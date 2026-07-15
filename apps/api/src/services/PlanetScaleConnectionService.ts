import { randomBytes, randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	PlanetScaleIntegrationStatus,
	PlanetScaleScrapeTargetSummary,
	ScrapeTargetId,
	UserId,
	type ScrapeTargetEncryptionError,
	type ScrapeTargetNotFoundError,
	type ScrapeTargetPersistenceError,
	type ScrapeTargetValidationError,
	type OrgId,
	type PlanetScaleMetricsTokenRequest,
	type PlanetScaleSelectOrganizationRequest,
} from "@maple/domain/http"
import { planetscaleConnections, scrapeTargets, type PlanetScaleConnectionRow } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { decodeDiscoveryConfig } from "./planetscale/discovery-config"
import { HttpSdResponse, subTargetsFromGroup } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService, planetScaleBearerHeader } from "./PlanetScaleOAuthService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

/**
 * First-class PlanetScale integration: one OAuth-backed connection per org.
 * The OAuth grant itself (tokens, refresh) lives in `oauth_connections` via
 * PlanetScaleOAuthService; this service owns the org binding on top of it.
 * `finalizeOrgSelection` validates the chosen PlanetScale organization against
 * the grant, probes API permissions, persists the binding, and auto-provisions
 * (or adopts) the `planetscale`-type scrape target that feeds branch metrics
 * through the existing scraper pipeline. The managed target is marked
 * `managedBy = "planetscale:{connectionId}"` and torn down on disconnect.
 */

export const managedByForConnection = (connectionId: string): string => `planetscale:${connectionId}`

const PROBE_TIMEOUT = Duration.seconds(10)

/** Permission keys stored in `detectedPermissionsJson` / surfaced in status. */
export interface PlanetScaleDetectedPermissions {
	readonly readOrganization: boolean
	readonly readMetricsEndpoints: boolean
	readonly readDatabases: boolean
}

export interface PlanetScaleConnectionServiceShape {
	readonly getStatus: (orgId: OrgId) => Effect.Effect<PlanetScaleIntegrationStatus, IntegrationsPersistenceError>
	/**
	 * Bind the org's stored OAuth grant to one PlanetScale organization. Called
	 * from the OAuth callback (single-org auto-bind) and the org-picker endpoint;
	 * re-binding (changing org / editing filters) is an upsert.
	 */
	readonly finalizeOrgSelection: (
		orgId: OrgId,
		request: Pick<
			PlanetScaleSelectOrganizationRequest,
			"organization" | "includeBranches" | "excludeBranches"
		>,
	) => Effect.Effect<
		PlanetScaleIntegrationStatus,
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/**
	 * Attach (or rotate) the service token that authenticates branch-metrics
	 * scraping — PlanetScale's metrics endpoints only accept service tokens, so
	 * this is the one credential the OAuth grant can't replace. Validates the
	 * token against the metrics discovery endpoint before storing it on the
	 * managed scrape target and re-enabling scraping.
	 */
	readonly setMetricsToken: (
		orgId: OrgId,
		request: PlanetScaleMetricsTokenRequest,
	) => Effect.Effect<
		PlanetScaleIntegrationStatus,
		| IntegrationsNotConnectedError
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/** Drop the org binding, the managed scrape target, and the OAuth grant. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/** Load the org's connection row (null when not connected) — for pollers/webhooks. */
	readonly loadConnection: (
		orgId: OrgId,
	) => Effect.Effect<PlanetScaleConnectionRow | null, IntegrationsPersistenceError>
	/** Webhook endpoint path + decrypted HMAC secret for manual setup (admin-gated at the route). */
	readonly webhookConfig: (orgId: OrgId) => Effect.Effect<
		{ readonly configured: boolean; readonly path: string | null; readonly secret: string | null },
		IntegrationsPersistenceError
	>
}

const toPersistenceError = (error: unknown) =>
	new IntegrationsPersistenceError({
		message: error instanceof Error ? error.message : "PlanetScale connection persistence failed",
	})

const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeScrapeTargetIdSync = Schema.decodeUnknownSync(ScrapeTargetId)

export class PlanetScaleConnectionService extends Context.Service<
	PlanetScaleConnectionService,
	PlanetScaleConnectionServiceShape
>()("@maple/api/services/PlanetScaleConnectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const scrapeTargetsService = yield* ScrapeTargetsService
		const psOAuth = yield* PlanetScaleOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new IntegrationsPersistenceError({ message }),
		)
		const apiBase = env.MAPLE_PLANETSCALE_API_BASE_URL.replace(/\/$/, "")

		/**
		 * GET an absolute URL with the given Authorization header (an OAuth bearer
		 * or a service-token scheme). Returns the HTTP status and body text;
		 * network-level failures surface as IntegrationsUpstreamError.
		 */
		const probeUrl = Effect.fn("PlanetScaleConnectionService.probeUrl")(function* (
			url: string,
			authorization: string,
		) {
			return yield* Effect.gen(function* () {
				const request = HttpClientRequest.get(url).pipe(
					HttpClientRequest.setHeaders({
						Authorization: authorization,
						Accept: "application/json",
					}),
				)
				const res = yield* httpClient.execute(request)
				// Read (and thereby drain) the body so the connection is released.
				const text = yield* res.text
				return { status: res.status, text }
			}).pipe(
				Effect.mapError(
					(error) =>
						new IntegrationsUpstreamError({
							message: `PlanetScale API request failed: ${error.message}`,
						}),
				),
				Effect.timeoutOrElse({
					duration: PROBE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new IntegrationsUpstreamError({
								message: "PlanetScale API request timed out after 10s",
							}),
						),
				}),
			)
		})

		/** GET a management-API path; returns only the HTTP status. */
		const probeStatus = Effect.fn("PlanetScaleConnectionService.probeStatus")(function* (
			path: string,
			authorization: string,
		) {
			const response = yield* probeUrl(`${apiBase}${path}`, authorization)
			return response.status
		})

		const decodeHttpSd = Schema.decodeUnknownEffect(Schema.fromJsonString(HttpSdResponse))

		/**
		 * Whether an ACTUAL branch-metrics scrape works. The SD endpoint on
		 * api.planetscale.com accepting the credential proves nothing about the
		 * data plane: metrics.psdb.cloud authenticates with the signed `?sig=&exp=`
		 * URL params minted in the SD response, so we probe a discovered endpoint
		 * via its `signedUrl` and let `readMetricsEndpoints` reflect scraping, not
		 * listing. Inconclusive outcomes (no branches discovered yet, transport
		 * blip, undecodable payload) keep the control-plane answer instead of
		 * pausing a possibly-working target.
		 */
		const probeDataPlaneScrape = Effect.fn("PlanetScaleConnectionService.probeDataPlaneScrape")(
			function* (organization: string, bearer: string) {
				const org = encodeURIComponent(organization)
				const outcome: "ok" | "rejected" | "inconclusive" = yield* Effect.gen(function* () {
					const sd = yield* probeUrl(`${apiBase}/v1/organizations/${org}/metrics`, bearer)
					if (sd.status === 401 || sd.status === 403) return "rejected" as const
					if (sd.status < 200 || sd.status >= 300) return "inconclusive" as const

					const groups = yield* decodeHttpSd(sd.text).pipe(
						Effect.catch(() => Effect.succeed(null)),
					)
					if (groups === null) return "inconclusive" as const

					// subTargetsFromGroup already SSRF-validates the discovered URLs.
					const first = groups.flatMap((group) => subTargetsFromGroup(group).ok)[0]
					if (first === undefined) return "inconclusive" as const

					// signedUrl carries the `?sig=&exp=` params the data plane requires.
					const scrape = yield* probeUrl(first.signedUrl, bearer)
					return scrape.status >= 200 && scrape.status < 300
						? ("ok" as const)
						: ("rejected" as const)
				}).pipe(
					Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
						Effect.logWarning("PlanetScale data-plane scrape probe failed; keeping SD result").pipe(
							Effect.annotateLogs({ organization, error: error.message }),
							Effect.as("inconclusive" as const),
						),
					),
				)
				if (outcome !== "ok") {
					yield* Effect.logInfo("PlanetScale data-plane scrape probe outcome").pipe(
						Effect.annotateLogs({ organization, outcome }),
					)
				}
				return outcome
			},
		)

		const probePermissions = Effect.fn("PlanetScaleConnectionService.probePermissions")(function* (
			organization: string,
			accessToken: string,
		) {
			const org = encodeURIComponent(organization)
			const bearer = planetScaleBearerHeader(accessToken)
			const [orgStatus, metricsStatus, databasesStatus] = yield* Effect.all(
				[
					probeStatus(`/v1/organizations/${org}`, bearer),
					probeStatus(`/v1/organizations/${org}/metrics`, bearer),
					probeStatus(`/v1/organizations/${org}/databases?per_page=1`, bearer),
				],
				{ concurrency: 3 },
			)
			const ok = (status: number) => status >= 200 && status < 300
			// The SD listing passing is necessary but not sufficient for scraping —
			// confirm against the data plane before declaring the bearer scrape-capable.
			const readMetricsEndpoints =
				ok(metricsStatus) && (yield* probeDataPlaneScrape(organization, bearer)) !== "rejected"
			const permissions: PlanetScaleDetectedPermissions = {
				readOrganization: ok(orgStatus),
				readMetricsEndpoints,
				readDatabases: ok(databasesStatus),
			}
			return { permissions, orgStatus, metricsStatus }
		})

		const selectConnection = Effect.fn("PlanetScaleConnectionService.selectConnection")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(planetscaleConnections)
						.where(eq(planetscaleConnections.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return rows[0] ?? null
		})

		const selectManagedTarget = Effect.fn("PlanetScaleConnectionService.selectManagedTarget")(function* (
			connection: PlanetScaleConnectionRow,
		) {
			if (connection.scrapeTargetId === null) return null
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(scrapeTargets)
						.where(
							and(
								eq(scrapeTargets.orgId, connection.orgId),
								eq(scrapeTargets.id, connection.scrapeTargetId!),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return rows[0] ?? null
		})

		const statusForConnection = Effect.fn("PlanetScaleConnectionService.statusForConnection")(function* (
			orgId: OrgId,
			connection: PlanetScaleConnectionRow | null,
		) {
			if (connection === null) {
				// A stored grant with no org binding is the pending-picker state.
				const pendingOrgSelection = yield* psOAuth.hasConnection(orgId)
				return new PlanetScaleIntegrationStatus({
					connected: false,
					pendingOrgSelection,
					metricsAuth: "missing",
					organization: null,
					connectedByUserId: null,
					detectedPermissions: null,
					scrapeTarget: null,
					lastInventoryAt: null,
					lastInventoryError: null,
				})
			}
			const target = yield* selectManagedTarget(connection)
			const discoveryConfig = target ? decodeDiscoveryConfig(target.discoveryConfigJson) : null
			// How scraping authenticates: a stored service token wins; grant-resolved
			// bearer auth counts only while the target is enabled (finalize disables
			// it unless the bearer passed an end-to-end data-plane scrape probe —
			// PlanetScale's metrics endpoints only document service-token auth);
			// anything else means scraping is paused until a token is added.
			const metricsAuth =
				target === null
					? ("missing" as const)
					: target.authType === "token" && target.authCredentialsCiphertext !== null
						? ("service_token" as const)
						: target.authType === "planetscale_oauth" && target.enabled
							? ("oauth" as const)
							: ("missing" as const)
			return new PlanetScaleIntegrationStatus({
				connected: true,
				pendingOrgSelection: false,
				metricsAuth,
				organization: connection.psOrganization,
				connectedByUserId: decodeUserIdSync(connection.connectedByUserId),
				detectedPermissions: connection.detectedPermissionsJson ?? null,
				scrapeTarget: target
					? new PlanetScaleScrapeTargetSummary({
							id: decodeScrapeTargetIdSync(target.id),
							enabled: target.enabled,
							scrapeIntervalSeconds: target.scrapeIntervalSeconds,
							includeBranches: discoveryConfig?.includeBranches ?? [],
							excludeBranches: discoveryConfig?.excludeBranches ?? [],
							lastScrapeAt: target.lastScrapeAt?.getTime() ?? null,
							lastScrapeError: target.lastScrapeError,
						})
					: null,
				lastInventoryAt: connection.lastInventoryAt?.getTime() ?? null,
				lastInventoryError: connection.lastInventoryError,
			})
		})

		const getStatus = Effect.fn("PlanetScaleConnectionService.getStatus")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* selectConnection(orgId)
			return yield* statusForConnection(orgId, connection)
		})

		/**
		 * Find an org's existing planetscale scrape target for the same PlanetScale
		 * organization — a user-created row from the manual escape hatch (or the
		 * managed row of a prior connection). Adopted in place so binding never
		 * double-scrapes the org.
		 */
		const findAdoptableTarget = Effect.fn("PlanetScaleConnectionService.findAdoptableTarget")(function* (
			orgId: OrgId,
			organization: string,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(scrapeTargets)
						.where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.targetType, "planetscale"))),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return (
				rows.find(
					(row) => decodeDiscoveryConfig(row.discoveryConfigJson)?.organization === organization,
				) ?? null
			)
		})

		const setManagedBy = Effect.fn("PlanetScaleConnectionService.setManagedBy")(function* (
			targetId: string,
			managedBy: string,
		) {
			yield* database
				.execute((db) =>
					db.update(scrapeTargets).set({ managedBy }).where(eq(scrapeTargets.id, targetId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Typed on the concrete scrape-target error union so a new tag added to
		// ScrapeTargetsService's error channel fails compilation here instead of
		// silently collapsing into a 503 persistence error.
		const mapScrapeTargetError = (
			error:
				| ScrapeTargetNotFoundError
				| ScrapeTargetValidationError
				| ScrapeTargetPersistenceError
				| ScrapeTargetEncryptionError,
		): IntegrationsValidationError | IntegrationsPersistenceError => {
			switch (error._tag) {
				case "@maple/http/errors/ScrapeTargetValidationError":
					return new IntegrationsValidationError({ message: error.message })
				case "@maple/http/errors/ScrapeTargetNotFoundError":
				case "@maple/http/errors/ScrapeTargetPersistenceError":
				case "@maple/http/errors/ScrapeTargetEncryptionError":
					return new IntegrationsPersistenceError({ message: error.message })
			}
		}

		const finalizeOrgSelection = Effect.fn("PlanetScaleConnectionService.finalizeOrgSelection")(function* (
			orgId: OrgId,
			request: Pick<
				PlanetScaleSelectOrganizationRequest,
				"organization" | "includeBranches" | "excludeBranches"
			>,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const organization = request.organization.trim()

			const { accessToken } = yield* psOAuth.getValidAccessToken(orgId)

			// The grant is the authority on which orgs may be bound — a slug outside
			// it would provision a scrape target that 403s on every scrape.
			const grantedOrgs = yield* psOAuth.listOrganizations(orgId)
			if (!grantedOrgs.some((org) => org.name === organization)) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: `The PlanetScale authorization does not grant access to organization "${organization}" — re-authorize or pick another organization.`,
					}),
				)
			}

			// Probe what the grant can do against this org (readMetricsEndpoints
			// requires an actual data-plane scrape to pass — see probePermissions).
			// The metrics endpoints only document service-token auth, so a failing
			// bearer probe does NOT block the binding — inventory/insights/webhooks
			// work on the grant, and scraping stays paused until a service token is
			// added via setMetricsToken (the card's follow-up step).
			const { permissions } = yield* probePermissions(organization, accessToken)

			// Attribution comes from the grant, so finalize behaves identically when
			// called from the tenantless OAuth callback and the picker endpoint. The
			// grant row must exist here — getValidAccessToken just used it.
			const connectedByUserId = yield* psOAuth.connectedByUserId(orgId)
			if (connectedByUserId === null) {
				return yield* Effect.fail(
					new IntegrationsNotConnectedError({
						message: "PlanetScale is not connected for this organization",
					}),
				)
			}

			const now = yield* Clock.currentTimeMillis
			const existing = yield* selectConnection(orgId)
			const connectionId = existing?.id ?? randomUUID()
			const managedBy = managedByForConnection(connectionId)

			// Provision or adopt the scrape target that feeds branch metrics. Managed
			// targets carry no credentials — the scraper resolves the OAuth grant at
			// scrape time (authType "planetscale_oauth").
			const adoptable = yield* findAdoptableTarget(orgId, organization)
			let scrapeTargetId: string
			if (adoptable !== null) {
				// An adopted row with working service-token credentials keeps them —
				// that's the auth the metrics endpoints actually accept. Only
				// credential-less rows switch to grant-resolved auth, and those stay
				// enabled only if the bearer probe passed.
				const keepsToken =
					adoptable.authType === "token" && adoptable.authCredentialsCiphertext !== null
				yield* scrapeTargetsService
					.update(orgId, decodeScrapeTargetIdSync(adoptable.id), {
						...(keepsToken ? {} : { authType: "planetscale_oauth" }),
						...(request.includeBranches !== undefined
							? { includeBranches: request.includeBranches }
							: {}),
						...(request.excludeBranches !== undefined
							? { excludeBranches: request.excludeBranches }
							: {}),
						enabled: keepsToken || permissions.readMetricsEndpoints,
					})
					.pipe(Effect.mapError(mapScrapeTargetError))
				scrapeTargetId = adoptable.id
			} else {
				const created = yield* scrapeTargetsService
					.create(orgId, {
						name: `PlanetScale (${organization})`,
						targetType: "planetscale",
						organization,
						authType: "planetscale_oauth",
						...(request.includeBranches !== undefined
							? { includeBranches: request.includeBranches }
							: {}),
						...(request.excludeBranches !== undefined
							? { excludeBranches: request.excludeBranches }
							: {}),
						// Paused until a service token arrives when the bearer probe
						// failed — an enabled target would just 401 every scrape.
						enabled: permissions.readMetricsEndpoints,
					})
					.pipe(Effect.mapError(mapScrapeTargetError))
				scrapeTargetId = created.id
			}
			yield* setManagedBy(scrapeTargetId, managedBy)

			if (existing !== null) {
				yield* database
					.execute((db) =>
						db
							.update(planetscaleConnections)
							.set({
								psOrganization: organization,
								connectedByUserId,
								scrapeTargetId,
								detectedPermissionsJson: { ...permissions },
								updatedAt: new Date(now),
							})
							.where(eq(planetscaleConnections.id, existing.id)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			} else {
				// Per-connection webhook HMAC secret, minted once at first binding.
				const webhookSecret = randomBytes(32).toString("hex")
				const encryptedWebhookSecret = yield* encryptAes256Gcm(webhookSecret, encryptionKey, () =>
					toPersistenceError(new Error("Failed to encrypt PlanetScale webhook secret")),
				)
				yield* database
					.execute((db) =>
						db.insert(planetscaleConnections).values({
							id: connectionId,
							orgId,
							psOrganization: organization,
							connectedByUserId,
							scrapeTargetId,
							webhookSecretCiphertext: encryptedWebhookSecret.ciphertext,
							webhookSecretIv: encryptedWebhookSecret.iv,
							webhookSecretTag: encryptedWebhookSecret.tag,
							detectedPermissionsJson: { ...permissions },
							createdAt: new Date(now),
							updatedAt: new Date(now),
						}),
					)
					.pipe(Effect.mapError(toPersistenceError))
			}

			return yield* getStatus(orgId)
		})

		const setMetricsToken = Effect.fn("PlanetScaleConnectionService.setMetricsToken")(function* (
			orgId: OrgId,
			request: PlanetScaleMetricsTokenRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* selectConnection(orgId)
			if (connection === null) {
				return yield* Effect.fail(
					new IntegrationsNotConnectedError({
						message: "Connect PlanetScale before adding a metrics service token",
					}),
				)
			}

			// Validate the token against the metrics discovery endpoint before
			// storing anything — this is exactly the call the scraper will make.
			const tokenId = request.tokenId.trim()
			const sdStatus = yield* probeStatus(
				`/v1/organizations/${encodeURIComponent(connection.psOrganization)}/metrics`,
				`token ${tokenId}:${request.tokenSecret}`,
			)
			if (sdStatus < 200 || sdStatus >= 300) {
				if (sdStatus !== 401 && sdStatus !== 403) {
					return yield* Effect.fail(
						new IntegrationsUpstreamError({
							message: `PlanetScale metrics discovery failed (HTTP ${sdStatus}). Try again shortly.`,
						}),
					)
				}
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"PlanetScale rejected the service token for the metrics endpoint. Create the token in the organization settings with the read_metrics_endpoints permission.",
					}),
				)
			}

			const target = yield* selectManagedTarget(connection)
			if (target === null) {
				return yield* Effect.fail(
					new IntegrationsPersistenceError({
						message: "The managed scrape target is missing — disconnect and reconnect PlanetScale.",
					}),
				)
			}
			yield* scrapeTargetsService
				.update(orgId, decodeScrapeTargetIdSync(target.id), {
					authType: "token",
					authCredentials: JSON.stringify({ tokenId, tokenSecret: request.tokenSecret }),
					enabled: true,
				})
				.pipe(Effect.mapError(mapScrapeTargetError))

			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("PlanetScaleConnectionService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* selectConnection(orgId)

			if (connection !== null) {
				// Tear down the managed scrape target — but only if this connection still
				// owns it (a user-created row adopted by a *different* connection stays).
				const target = yield* selectManagedTarget(connection)
				if (target !== null && target.managedBy === managedByForConnection(connection.id)) {
					yield* scrapeTargetsService
						.delete(orgId, decodeScrapeTargetIdSync(target.id))
						.pipe(
							Effect.catchTag("@maple/http/errors/ScrapeTargetNotFoundError", () =>
								Effect.succeed(undefined),
							),
							Effect.mapError(toPersistenceError),
						)
				}

				yield* database
					.execute((db) =>
						db.delete(planetscaleConnections).where(eq(planetscaleConnections.id, connection.id)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			}

			// Drop the OAuth grant too — covers the pending state (grant stored, no
			// org bound yet). PlanetScale documents no revoke endpoint.
			const grant = yield* psOAuth.disconnect(orgId)

			return { disconnected: connection !== null || grant.disconnected }
		})

		const loadConnection = Effect.fn("PlanetScaleConnectionService.loadConnection")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			return yield* selectConnection(orgId)
		})

		const webhookConfig = Effect.fn("PlanetScaleConnectionService.webhookConfig")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* selectConnection(orgId)
			if (
				connection === null ||
				connection.webhookSecretCiphertext === null ||
				connection.webhookSecretIv === null ||
				connection.webhookSecretTag === null
			) {
				return { configured: false, path: null, secret: null }
			}
			const secret = yield* decryptAes256Gcm(
				{
					ciphertext: connection.webhookSecretCiphertext,
					iv: connection.webhookSecretIv,
					tag: connection.webhookSecretTag,
				},
				encryptionKey,
				() => toPersistenceError(new Error("Failed to decrypt PlanetScale webhook secret")),
			)
			return {
				configured: true,
				path: `/api/integrations/planetscale/webhook/${connection.id}`,
				secret,
			}
		})

		return {
			getStatus,
			finalizeOrgSelection,
			setMetricsToken,
			disconnect,
			loadConnection,
			webhookConfig,
		} satisfies PlanetScaleConnectionServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

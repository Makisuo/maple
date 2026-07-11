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
	type OrgId,
	type PlanetScaleSelectOrganizationRequest,
} from "@maple/domain/http"
import { planetscaleConnections, scrapeTargets, type PlanetScaleConnectionRow } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
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

const DiscoveryConfigSchema = Schema.Struct({
	organization: Schema.String,
	includeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	excludeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
})

const decodeDiscoveryConfig = (json: unknown) => {
	if (!json) return null
	try {
		return Schema.decodeUnknownSync(DiscoveryConfigSchema)(json)
	} catch {
		return null
	}
}

export class PlanetScaleConnectionService extends Context.Service<
	PlanetScaleConnectionService,
	PlanetScaleConnectionServiceShape
>()("@maple/api/services/PlanetScaleConnectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const scrapeTargetsService = yield* ScrapeTargetsService
		const psOAuth = yield* PlanetScaleOAuthService
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new IntegrationsPersistenceError({ message }),
		)
		const apiBase = env.MAPLE_PLANETSCALE_API_BASE_URL.replace(/\/$/, "")

		/**
		 * GET a management-API path with the grant's access token. Returns the HTTP
		 * status; network-level failures surface as IntegrationsUpstreamError.
		 */
		const probeStatus = Effect.fn("PlanetScaleConnectionService.probeStatus")(function* (
			path: string,
			accessToken: string,
		) {
			return yield* Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const request = HttpClientRequest.get(`${apiBase}${path}`).pipe(
					HttpClientRequest.setHeaders({
						Authorization: planetScaleBearerHeader(accessToken),
						Accept: "application/json",
					}),
				)
				const res = yield* client.execute(request)
				// Drain the body so the connection is released.
				yield* res.text
				return res.status
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
				Effect.provide(FetchHttpClient.layer),
			)
		})

		const probePermissions = Effect.fn("PlanetScaleConnectionService.probePermissions")(function* (
			organization: string,
			accessToken: string,
		) {
			const org = encodeURIComponent(organization)
			const [orgStatus, metricsStatus, databasesStatus] = yield* Effect.all(
				[
					probeStatus(`/v1/organizations/${org}`, accessToken),
					probeStatus(`/v1/organizations/${org}/metrics`, accessToken),
					probeStatus(`/v1/organizations/${org}/databases?per_page=1`, accessToken),
				],
				{ concurrency: 3 },
			)
			const ok = (status: number) => status >= 200 && status < 300
			const permissions: PlanetScaleDetectedPermissions = {
				readOrganization: ok(orgStatus),
				readMetricsEndpoints: ok(metricsStatus),
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
			return new PlanetScaleIntegrationStatus({
				connected: true,
				pendingOrgSelection: false,
				organization: connection.psOrganization,
				connectedByUserId: decodeUserIdSync(connection.connectedByUserId),
				detectedPermissions: connection.detectedPermissionsJson ?? null,
				scrapeTarget: target
					? new PlanetScaleScrapeTargetSummary({
							id: target.id,
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

		const mapScrapeTargetError = (error: {
			readonly _tag: string
			readonly message: string
		}): IntegrationsValidationError | IntegrationsPersistenceError =>
			error._tag === "@maple/http/errors/ScrapeTargetValidationError"
				? new IntegrationsValidationError({ message: error.message })
				: new IntegrationsPersistenceError({ message: error.message })

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

			// Validate what the grant can do against this org before persisting anything.
			const { permissions, metricsStatus } = yield* probePermissions(organization, accessToken)
			if (!permissions.readMetricsEndpoints) {
				const rejected = metricsStatus === 401 || metricsStatus === 403
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: rejected
							? "PlanetScale rejected the authorization for the metrics endpoint. Grant the OAuth application the organization-level read_metrics_endpoints scope and reconnect."
							: `PlanetScale metrics discovery failed (HTTP ${metricsStatus}).`,
					}),
				)
			}

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
				// Switch the adopted row to grant-resolved auth (clearing any stored
				// service-token credentials) so scraping follows the OAuth connection.
				yield* scrapeTargetsService
					.update(orgId, decodeScrapeTargetIdSync(adoptable.id), {
						authType: "planetscale_oauth",
						...(request.includeBranches !== undefined
							? { includeBranches: request.includeBranches }
							: {}),
						...(request.excludeBranches !== undefined
							? { excludeBranches: request.excludeBranches }
							: {}),
						enabled: true,
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

		const disconnect = Effect.fn("PlanetScaleConnectionService.disconnect")(function* (orgId: OrgId) {
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
			return yield* selectConnection(orgId)
		})

		const webhookConfig = Effect.fn("PlanetScaleConnectionService.webhookConfig")(function* (
			orgId: OrgId,
		) {
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
			disconnect,
			loadConnection,
			webhookConfig,
		} satisfies PlanetScaleConnectionServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

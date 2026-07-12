import { randomUUID } from "node:crypto"
import {
	IsoDateTimeString,
	OrgId,
	ScrapeAuthType,
	ScrapeIntervalSeconds,
	ScrapeTargetAuthError,
	ScrapeTargetDeleteResponse,
	ScrapeTargetEncryptionError,
	ScrapeTargetId,
	ScrapeTargetNotFoundError,
	ScrapeTargetPersistenceError,
	ScrapeTargetProbeResponse,
	ScrapeTargetResponse,
	ScrapeTargetsListResponse,
	ScrapeTargetType,
	ScrapeTargetUpstreamError,
	ScrapeTargetValidationError,
	type CreateScrapeTargetRequest,
	type UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import { scrapeTargetChecks, scrapeTargets, type ScrapeTargetCheckRow } from "@maple/db"
import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { encryptAes256Gcm, parseBase64Aes256GcmKey, type EncryptedValue } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import {
	BasicCredentialsSchema,
	BearerCredentialsSchema,
	buildScrapeAuthHeaders,
	catchOAuthTokenFailure,
	TokenCredentialsSchema,
} from "../lib/scrape-auth"
import { safeFetch, validateExternalUrl } from "../lib/url-validator"
import { decodeDiscoveryConfig, DiscoveryConfigSchema } from "./planetscale/discovery-config"
import { PlanetScaleDiscoveryService, planetScaleDiscoveryUrl } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService, planetScaleBearerHeader } from "./PlanetScaleOAuthService"

type ScrapeTargetRow = typeof scrapeTargets.$inferSelect

interface ScrapeTargetProxyResponse {
	readonly status: number
	readonly body: string
	readonly contentType: string
	/**
	 * Upstream `Retry-After` in seconds (delta-seconds form only), surfaced so
	 * the scraper can back off precisely on 429/503. `null` when absent or in
	 * the HTTP-date form we don't parse.
	 */
	readonly retryAfterSeconds: number | null
}

/** Parse a `Retry-After` header value, honoring only the delta-seconds form. */
const parseRetryAfterSeconds = (value: string | null): number | null => {
	if (value === null) return null
	const seconds = Number(value.trim())
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

export interface ScrapeTargetsServiceShape {
	readonly list: (orgId: OrgId) => Effect.Effect<ScrapeTargetsListResponse, ScrapeTargetPersistenceError>
	readonly get: (
		orgId: OrgId,
		targetId: ScrapeTargetId,
	) => Effect.Effect<ScrapeTargetResponse, ScrapeTargetNotFoundError | ScrapeTargetPersistenceError>
	readonly create: (
		orgId: OrgId,
		request: CreateScrapeTargetRequest,
	) => Effect.Effect<
		ScrapeTargetResponse,
		ScrapeTargetValidationError | ScrapeTargetPersistenceError | ScrapeTargetEncryptionError
	>
	readonly update: (
		orgId: OrgId,
		targetId: ScrapeTargetId,
		request: UpdateScrapeTargetRequest,
	) => Effect.Effect<
		ScrapeTargetResponse,
		| ScrapeTargetNotFoundError
		| ScrapeTargetValidationError
		| ScrapeTargetPersistenceError
		| ScrapeTargetEncryptionError
	>
	readonly delete: (
		orgId: OrgId,
		targetId: ScrapeTargetId,
	) => Effect.Effect<ScrapeTargetDeleteResponse, ScrapeTargetNotFoundError | ScrapeTargetPersistenceError>
	readonly listAllEnabled: (
		interval?: ScrapeIntervalSeconds,
	) => Effect.Effect<ReadonlyArray<ScrapeTargetRow>, ScrapeTargetPersistenceError>
	readonly scrapeForCollector: (
		targetId: ScrapeTargetId,
		subTargetKey?: string,
	) => Effect.Effect<
		ScrapeTargetProxyResponse,
		| ScrapeTargetNotFoundError
		| ScrapeTargetPersistenceError
		| ScrapeTargetEncryptionError
		| ScrapeTargetAuthError
		| ScrapeTargetUpstreamError
	>
	readonly recordScrapeResults: (
		results: ReadonlyArray<{
			readonly targetId: ScrapeTargetId
			readonly scrapedAt: number
			readonly error: string | null
			readonly subTargetKey?: string | null
			readonly durationMs?: number
			readonly samplesScraped?: number
			readonly samplesPostMetricRelabeling?: number
		}>,
		options?: {
			/**
			 * Persist a `scrape_target_checks` row per result (default). Manual
			 * probes opt out so check history only reflects scheduled scrapes.
			 */
			readonly recordChecks?: boolean
		},
	) => Effect.Effect<void, ScrapeTargetPersistenceError>
	readonly listChecks: (
		orgId: OrgId,
		targetId: ScrapeTargetId,
		query: { readonly startTime?: number; readonly endTime?: number; readonly limit?: number },
	) => Effect.Effect<
		ReadonlyArray<ScrapeTargetCheckRow>,
		ScrapeTargetNotFoundError | ScrapeTargetPersistenceError
	>
	readonly probe: (
		orgId: OrgId,
		targetId: ScrapeTargetId,
	) => Effect.Effect<
		ScrapeTargetProbeResponse,
		| ScrapeTargetNotFoundError
		| ScrapeTargetPersistenceError
		| ScrapeTargetEncryptionError
		| ScrapeTargetAuthError
	>
}

/** Check-history retention: 24h sliding window… */
const CHECK_RETENTION_MS = 24 * 60 * 60 * 1000
/** …with a per-target row cap as backstop against very short intervals. */
const CHECK_MAX_ROWS_PER_TARGET = 10_000

const toPersistenceError = (error: unknown) =>
	new ScrapeTargetPersistenceError({
		message: error instanceof Error ? error.message : "Scrape target persistence failed",
	})

const toEncryptionError = (message: string) => new ScrapeTargetEncryptionError({ message })

const decodeTargetIdSync = Schema.decodeUnknownSync(ScrapeTargetId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeScrapeIntervalSecondsSync = Schema.decodeUnknownSync(ScrapeIntervalSeconds)
const decodeScrapeAuthTypeSync = Schema.decodeUnknownSync(ScrapeAuthType)
const decodeScrapeTargetTypeSync = Schema.decodeUnknownSync(ScrapeTargetType)
const ScrapeLabelsSchema = Schema.Record(Schema.String, Schema.String)

/** Cap pattern lists so a target config stays small and bounded. */
const MAX_BRANCH_PATTERNS = 50
const MAX_BRANCH_PATTERN_LENGTH = 200

/** Trim, drop blanks, and de-duplicate a branch glob list from a request. */
const normalizeBranchPatterns = (patterns: ReadonlyArray<string> | undefined): string[] => {
	if (!patterns) return []
	const seen = new Set<string>()
	for (const raw of patterns) {
		const pattern = raw.trim()
		if (pattern.length > 0) seen.add(pattern)
	}
	return [...seen]
}

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, ScrapeTargetEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptCredentials = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, ScrapeTargetEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () => toEncryptionError("Failed to encrypt credentials"))

const decodeAuthTypeEffect = Schema.decodeUnknownEffect(ScrapeAuthType)

const validateAuthType = (authType: string | undefined) => {
	if (authType === undefined) return Effect.succeed(undefined)
	return decodeAuthTypeEffect(authType).pipe(
		Effect.mapError(
			() =>
				new ScrapeTargetValidationError({
					message: `Invalid auth type: "${authType}". Must be one of: none, bearer, basic, token, planetscale_oauth`,
				}),
		),
	)
}

/** Auth types that store no credentials on the row. */
const isCredentialLessAuthType = (authType: string): boolean =>
	authType === "none" || authType === "planetscale_oauth"

const validateAuthCredentials = (authType: string, authCredentials: string | null | undefined) => {
	if (isCredentialLessAuthType(authType)) return Effect.succeed(undefined)

	if (!authCredentials) {
		return Effect.fail(
			new ScrapeTargetValidationError({
				message: `Credentials are required for auth type "${authType}"`,
			}),
		)
	}

	const schema =
		authType === "bearer"
			? BearerCredentialsSchema
			: authType === "token"
				? TokenCredentialsSchema
				: BasicCredentialsSchema
	return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(authCredentials).pipe(
		Effect.mapError(
			() =>
				new ScrapeTargetValidationError({
					message:
						authType === "bearer"
							? 'Bearer auth credentials must include a "token" string field'
							: authType === "token"
								? 'Service token credentials must include "tokenId" and "tokenSecret" string fields'
								: 'Basic auth credentials must include "username" and "password" string fields',
				}),
		),
		Effect.as(authCredentials),
	)
}

const rowToResponse = (row: ScrapeTargetRow): ScrapeTargetResponse => {
	const discoveryConfig = decodeDiscoveryConfig(row.discoveryConfigJson)
	return new ScrapeTargetResponse({
		id: decodeTargetIdSync(row.id),
		name: row.name,
		serviceName: row.serviceName ?? null,
		url: row.url,
		targetType: decodeScrapeTargetTypeSync(row.targetType),
		organization: discoveryConfig?.organization ?? null,
		includeBranches: discoveryConfig?.includeBranches ?? [],
		excludeBranches: discoveryConfig?.excludeBranches ?? [],
		scrapeIntervalSeconds: decodeScrapeIntervalSecondsSync(row.scrapeIntervalSeconds),
		labelsJson: row.labelsJson == null ? null : JSON.stringify(row.labelsJson),
		authType: decodeScrapeAuthTypeSync(row.authType),
		hasCredentials: row.authCredentialsCiphertext !== null,
		managedBy: row.managedBy ?? null,
		enabled: row.enabled,
		lastScrapeAt: row.lastScrapeAt
			? decodeIsoDateTimeStringSync(row.lastScrapeAt.toISOString())
			: null,
		lastScrapeError: row.lastScrapeError,
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
	})
}

const MIN_SCRAPE_INTERVAL = 5
const MAX_SCRAPE_INTERVAL = 300

const RESERVED_LABEL_KEYS = new Set(["job", "instance"])
const RESERVED_LABEL_PREFIXES = ["maple_", "__"]

const isReservedLabelKey = (key: string): boolean => {
	if (RESERVED_LABEL_KEYS.has(key)) return true
	return RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))
}

const validateUrl = (url: string) => {
	const trimmed = url.trim()
	return validateExternalUrl(trimmed).pipe(
		Effect.as(trimmed),
		Effect.mapError(
			(error) =>
				new ScrapeTargetValidationError({
					message: error.message,
				}),
		),
	)
}

const validateInterval = (seconds: number | undefined) => {
	if (seconds === undefined) return Effect.succeed(undefined)
	if (!Number.isInteger(seconds) || seconds < MIN_SCRAPE_INTERVAL || seconds > MAX_SCRAPE_INTERVAL) {
		return Effect.fail(
			new ScrapeTargetValidationError({
				message: `Scrape interval must be an integer between ${MIN_SCRAPE_INTERVAL} and ${MAX_SCRAPE_INTERVAL} seconds`,
			}),
		)
	}
	return Effect.succeed(seconds)
}

/**
 * Validate the request's JSON-text labels and return the decoded record for
 * the jsonb column write (null/undefined pass through unchanged).
 */
const validateLabelsJson = (labelsJson: string | null | undefined) => {
	if (labelsJson === undefined || labelsJson === null) return Effect.succeed(labelsJson)
	return Schema.decodeUnknownEffect(Schema.fromJsonString(ScrapeLabelsSchema))(labelsJson).pipe(
		Effect.mapError(
			() =>
				new ScrapeTargetValidationError({
					message: "labelsJson must be a JSON object with string values",
				}),
		),
		Effect.flatMap((decoded) => {
			const reserved = Object.keys(decoded).filter(isReservedLabelKey)
			if (reserved.length > 0) {
				return Effect.fail(
					new ScrapeTargetValidationError({
						message: `Reserved label keys are not allowed: ${reserved.join(", ")}`,
					}),
				)
			}
			return Effect.succeed(decoded)
		}),
	)
}

/**
 * Normalize + bound a branch glob list. Returns the cleaned patterns, or fails
 * if the list or an individual pattern exceeds the configured caps.
 */
const validateBranchPatterns = (
	patterns: ReadonlyArray<string> | undefined,
	field: "includeBranches" | "excludeBranches",
): Effect.Effect<string[], ScrapeTargetValidationError> => {
	const normalized = normalizeBranchPatterns(patterns)
	if (normalized.length > MAX_BRANCH_PATTERNS) {
		return Effect.fail(
			new ScrapeTargetValidationError({
				message: `${field} accepts at most ${MAX_BRANCH_PATTERNS} patterns`,
			}),
		)
	}
	const tooLong = normalized.find((pattern) => pattern.length > MAX_BRANCH_PATTERN_LENGTH)
	if (tooLong !== undefined) {
		return Effect.fail(
			new ScrapeTargetValidationError({
				message: `${field} patterns must be at most ${MAX_BRANCH_PATTERN_LENGTH} characters`,
			}),
		)
	}
	return Effect.succeed(normalized)
}

/** Assemble the `discovery_config_json` value, omitting empty pattern lists. */
const buildDiscoveryConfig = (
	organization: string,
	includeBranches: ReadonlyArray<string>,
	excludeBranches: ReadonlyArray<string>,
): { organization: string; includeBranches?: string[]; excludeBranches?: string[] } => ({
	organization,
	...(includeBranches.length > 0 ? { includeBranches: [...includeBranches] } : {}),
	...(excludeBranches.length > 0 ? { excludeBranches: [...excludeBranches] } : {}),
})

export class ScrapeTargetsService extends Context.Service<ScrapeTargetsService, ScrapeTargetsServiceShape>()(
	"@maple/api/services/ScrapeTargetsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const discovery = yield* PlanetScaleDiscoveryService
			const psOAuth = yield* PlanetScaleOAuthService
			const encryptionKey = yield* parseEncryptionKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			)

			const selectById = Effect.fn("ScrapeTargetsService.selectById")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
			) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(scrapeTargets)
							.where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId)))
							.limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				return Option.fromNullishOr(rows[0])
			})

			const requireTarget = Effect.fn("ScrapeTargetsService.requireTarget")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
			) {
				const row = yield* selectById(orgId, targetId)
				if (Option.isSome(row)) return row.value

				return yield* Effect.fail(
					new ScrapeTargetNotFoundError({
						targetId,
						message: "Scrape target not found",
					}),
				)
			})

			const selectByIdForInternalScrape = Effect.fn("ScrapeTargetsService.selectByIdForInternalScrape")(
				function* (targetId: ScrapeTargetId) {
					const rows = yield* database
						.execute((db) =>
							db.select().from(scrapeTargets).where(eq(scrapeTargets.id, targetId)).limit(1),
						)
						.pipe(Effect.mapError(toPersistenceError))

					return Option.fromNullishOr(rows[0])
				},
			)

			// Managed PlanetScale targets store no credentials — the org's OAuth grant
			// is resolved (and refreshed) at scrape time. Everything else decrypts the
			// row's stored credentials.
			const authHeadersForRow = Effect.fn("ScrapeTargetsService.authHeadersForRow")(function* (
				row: ScrapeTargetRow,
			) {
				if (row.authType !== "planetscale_oauth") {
					return yield* buildScrapeAuthHeaders(row, encryptionKey)
				}
				const { accessToken } = yield* psOAuth
					.getValidAccessToken(Schema.decodeUnknownSync(OrgId)(row.orgId))
					.pipe(Effect.catchTags(catchOAuthTokenFailure))
				return { Authorization: planetScaleBearerHeader(accessToken) }
			})

			const list = Effect.fn("ScrapeTargetsService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* database
					.execute((db) => db.select().from(scrapeTargets).where(eq(scrapeTargets.orgId, orgId)))
					.pipe(Effect.mapError(toPersistenceError))

				return new ScrapeTargetsListResponse({
					targets: rows.map(rowToResponse),
				})
			})

			const get = Effect.fn("ScrapeTargetsService.get")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, scrapeTargetId: targetId })
				const row = yield* requireTarget(orgId, targetId)
				return rowToResponse(row)
			})

			const create = Effect.fn("ScrapeTargetsService.create")(function* (
				orgId: OrgId,
				request: CreateScrapeTargetRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const targetType = request.targetType ?? "prometheus"

				let url: string
				let discoveryConfigJson:
					| { organization: string; includeBranches?: string[]; excludeBranches?: string[] }
					| null = null
				let authType: string

				if (targetType === "planetscale") {
					if (request.url) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message:
									"PlanetScale targets derive their URL from the organization; do not provide a url",
							}),
						)
					}
					const organization = request.organization?.trim()
					if (!organization) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message: "organization is required for PlanetScale targets",
							}),
						)
					}
					if (
						request.authType !== undefined &&
						request.authType !== "token" &&
						request.authType !== "planetscale_oauth"
					) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message:
									'PlanetScale targets use auth type "token" (service token id + secret) or "planetscale_oauth" (managed by the PlanetScale integration)',
							}),
						)
					}
					const includeBranches = yield* validateBranchPatterns(
						request.includeBranches,
						"includeBranches",
					)
					const excludeBranches = yield* validateBranchPatterns(
						request.excludeBranches,
						"excludeBranches",
					)
					url = planetScaleDiscoveryUrl(organization)
					discoveryConfigJson = buildDiscoveryConfig(organization, includeBranches, excludeBranches)
					authType = request.authType ?? "token"
				} else {
					if (request.includeBranches !== undefined || request.excludeBranches !== undefined) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message: "includeBranches/excludeBranches are only valid for PlanetScale targets",
							}),
						)
					}
					if (request.authType === "planetscale_oauth") {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message: 'Auth type "planetscale_oauth" is only valid for PlanetScale targets',
							}),
						)
					}
					if (!request.url) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({ message: "url is required" }),
						)
					}
					url = yield* validateUrl(request.url)
					authType = (yield* validateAuthType(request.authType)) ?? "none"
				}

				yield* validateInterval(request.scrapeIntervalSeconds)
				const labels = yield* validateLabelsJson(request.labelsJson)

				const name = request.name.trim()
				const serviceName = request.serviceName ?? null

				let credentialFields: {
					authCredentialsCiphertext: string | null
					authCredentialsIv: string | null
					authCredentialsTag: string | null
				} = {
					authCredentialsCiphertext: null,
					authCredentialsIv: null,
					authCredentialsTag: null,
				}

				if (!isCredentialLessAuthType(authType)) {
					yield* validateAuthCredentials(authType, request.authCredentials)
					const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
					credentialFields = {
						authCredentialsCiphertext: encrypted.ciphertext,
						authCredentialsIv: encrypted.iv,
						authCredentialsTag: encrypted.tag,
					}
				}

				const now = yield* Clock.currentTimeMillis
				const id = decodeTargetIdSync(randomUUID())

				yield* database
					.execute((db) =>
						db.insert(scrapeTargets).values({
							id,
							orgId,
							name,
							serviceName,
							url,
							targetType,
							discoveryConfigJson,
							scrapeIntervalSeconds:
								request.scrapeIntervalSeconds ?? (targetType === "planetscale" ? 30 : 15),
							labelsJson: labels ?? null,
							authType,
							...credentialFields,
							enabled: request.enabled !== false,
							createdAt: new Date(now),
							updatedAt: new Date(now),
						}),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const row = yield* selectById(orgId, id)
				if (Option.isNone(row)) {
					return yield* Effect.fail(
						new ScrapeTargetPersistenceError({
							message: "Failed to create scrape target",
						}),
					)
				}

				// Fire the first scrape in the background so target creation returns
				// promptly, but never swallow its failure silently: a probe that fails
				// before it can record a result (e.g. a revoked/not-connected OAuth
				// grant → ScrapeTargetAuthError) would otherwise leave the fresh target
				// looking healthy with no log and no lastScrapeError row.
				yield* probe(orgId, id).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Initial scrape probe failed").pipe(
							Effect.annotateLogs({ orgId, scrapeTargetId: id, error: Cause.pretty(cause) }),
						),
					),
					Effect.forkDetach,
				)

				return rowToResponse(row.value)
			})

			const update = Effect.fn("ScrapeTargetsService.update")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
				request: UpdateScrapeTargetRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, scrapeTargetId: targetId })
				const existing = yield* requireTarget(orgId, targetId)
				const isPlanetScale = existing.targetType === "planetscale"

				if (isPlanetScale && request.url !== undefined) {
					return yield* Effect.fail(
						new ScrapeTargetValidationError({
							message:
								"PlanetScale targets derive their URL from the organization; update organization instead",
						}),
					)
				}
				if (
					isPlanetScale &&
					request.authType !== undefined &&
					request.authType !== "token" &&
					request.authType !== "planetscale_oauth"
				) {
					return yield* Effect.fail(
						new ScrapeTargetValidationError({
							message:
								'PlanetScale targets use auth type "token" (service token id + secret) or "planetscale_oauth" (managed by the PlanetScale integration)',
						}),
					)
				}
				if (!isPlanetScale && request.authType === "planetscale_oauth") {
					return yield* Effect.fail(
						new ScrapeTargetValidationError({
							message: 'Auth type "planetscale_oauth" is only valid for PlanetScale targets',
						}),
					)
				}
				if (!isPlanetScale && request.organization !== undefined && request.organization !== null) {
					return yield* Effect.fail(
						new ScrapeTargetValidationError({
							message: "organization is only valid for PlanetScale targets",
						}),
					)
				}
				if (
					!isPlanetScale &&
					(request.includeBranches !== undefined || request.excludeBranches !== undefined)
				) {
					return yield* Effect.fail(
						new ScrapeTargetValidationError({
							message: "includeBranches/excludeBranches are only valid for PlanetScale targets",
						}),
					)
				}

				if (request.url !== undefined && request.url !== null) {
					yield* validateUrl(request.url)
				}
				yield* validateInterval(request.scrapeIntervalSeconds)
				const labels = yield* validateLabelsJson(request.labelsJson)

				const now = yield* Clock.currentTimeMillis
				const updates: Record<string, unknown> = { updatedAt: new Date(now) }

				if (request.name !== undefined) updates.name = request.name.trim()
				if (request.url !== undefined && request.url !== null) updates.url = request.url.trim()

				if (
					isPlanetScale &&
					(request.organization !== undefined ||
						request.includeBranches !== undefined ||
						request.excludeBranches !== undefined)
				) {
					const existingConfig = decodeDiscoveryConfig(existing.discoveryConfigJson)
					const organization =
						request.organization !== undefined
							? request.organization?.trim()
							: existingConfig?.organization
					if (!organization) {
						return yield* Effect.fail(
							new ScrapeTargetValidationError({
								message: "organization is required for PlanetScale targets",
							}),
						)
					}
					// Provided lists replace (empty array clears); omitted lists are preserved.
					const includeBranches =
						request.includeBranches !== undefined
							? yield* validateBranchPatterns(request.includeBranches, "includeBranches")
							: (existingConfig?.includeBranches ?? [])
					const excludeBranches =
						request.excludeBranches !== undefined
							? yield* validateBranchPatterns(request.excludeBranches, "excludeBranches")
							: (existingConfig?.excludeBranches ?? [])
					updates.url = planetScaleDiscoveryUrl(organization)
					updates.discoveryConfigJson = buildDiscoveryConfig(
						organization,
						includeBranches,
						excludeBranches,
					)
				}
				if (request.scrapeIntervalSeconds !== undefined) {
					updates.scrapeIntervalSeconds = request.scrapeIntervalSeconds
				}
				if (request.labelsJson !== undefined) updates.labelsJson = labels ?? null
				if (request.enabled !== undefined) updates.enabled = request.enabled
				if (request.serviceName !== undefined) updates.serviceName = request.serviceName

				if (request.authType !== undefined) {
					const newAuthType = yield* validateAuthType(request.authType)
					updates.authType = newAuthType

					if (newAuthType !== undefined && isCredentialLessAuthType(newAuthType)) {
						updates.authCredentialsCiphertext = null
						updates.authCredentialsIv = null
						updates.authCredentialsTag = null
					} else if (newAuthType !== existing.authType || request.authCredentials) {
						yield* validateAuthCredentials(newAuthType!, request.authCredentials)
						const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
						updates.authCredentialsCiphertext = encrypted.ciphertext
						updates.authCredentialsIv = encrypted.iv
						updates.authCredentialsTag = encrypted.tag
					}
				} else if (request.authCredentials) {
					const currentAuthType = existing.authType
					if (!isCredentialLessAuthType(currentAuthType)) {
						yield* validateAuthCredentials(currentAuthType, request.authCredentials)
						const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
						updates.authCredentialsCiphertext = encrypted.ciphertext
						updates.authCredentialsIv = encrypted.iv
						updates.authCredentialsTag = encrypted.tag
					}
				}

				yield* database
					.execute((db) =>
						db
							.update(scrapeTargets)
							.set(updates)
							.where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId))),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const row = yield* selectById(orgId, targetId)
				if (Option.isNone(row)) {
					return yield* Effect.fail(
						new ScrapeTargetPersistenceError({
							message: "Failed to load updated scrape target",
						}),
					)
				}

				// Org or credential changes must take effect on the next scrape, not
				// after the discovery TTL elapses.
				if (isPlanetScale) yield* discovery.invalidate(targetId)

				return rowToResponse(row.value)
			})

			const remove = Effect.fn("ScrapeTargetsService.delete")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, scrapeTargetId: targetId })
				const rows = yield* database
					.execute((db) =>
						db
							.delete(scrapeTargets)
							.where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId)))
							.returning({ id: scrapeTargets.id }),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const deleted = Option.fromNullishOr(rows[0])
				if (Option.isNone(deleted)) {
					return yield* Effect.fail(
						new ScrapeTargetNotFoundError({
							targetId,
							message: "Scrape target not found",
						}),
					)
				}

				yield* discovery.invalidate(targetId)

				return new ScrapeTargetDeleteResponse({
					id: decodeTargetIdSync(deleted.value.id),
				})
			})

			const listAllEnabled = Effect.fn("ScrapeTargetsService.listAllEnabled")(function* (
				interval?: ScrapeIntervalSeconds,
			) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(scrapeTargets)
							.where(
								interval === undefined
									? eq(scrapeTargets.enabled, true)
									: and(
											eq(scrapeTargets.enabled, true),
											eq(scrapeTargets.scrapeIntervalSeconds, interval),
										),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))

				return rows
			})

			const scrapeForCollector = Effect.fn("ScrapeTargetsService.scrapeForCollector")(function* (
				targetId: ScrapeTargetId,
				subTargetKey?: string,
			) {
				yield* Effect.annotateCurrentSpan({
					scrapeTargetId: targetId,
					subTargetKey: subTargetKey ?? "",
				})
				const row = yield* selectByIdForInternalScrape(targetId)
				if (Option.isNone(row) || !row.value.enabled) {
					return yield* Effect.fail(
						new ScrapeTargetNotFoundError({
							targetId,
							message: "Scrape target not found",
						}),
					)
				}

				let scrapeUrl = row.value.url
				if (row.value.targetType === "planetscale") {
					// Resolve the per-branch endpoint from the discovery cache. The
					// scrape itself carries the auth header too — PlanetScale's docs
					// only auth the SD call, but sending it is harmless if unneeded.
					const subTargets = yield* discovery.discover(row.value)
					const match = subTargets.find((entry) => entry.subTargetKey === subTargetKey)
					if (!match) {
						return yield* Effect.fail(
							new ScrapeTargetNotFoundError({
								targetId,
								message: `PlanetScale sub-target not found: ${subTargetKey ?? "(none)"}`,
							}),
						)
					}
					scrapeUrl = match.url
				}

				const headers = yield* authHeadersForRow(row.value)
				const timeoutMs = Math.min(
					10_000,
					Math.max(1_000, (row.value.scrapeIntervalSeconds - 1) * 1000),
				)

				// `safeFetch` is retained for its SSRF protection + per-hop redirect
				// re-validation (the Effect HttpClient transport has neither). The manual
				// AbortController/setTimeout is replaced by the interruption-aware signal
				// from `Effect.tryPromise` plus `Effect.timeout`: on timeout the fiber is
				// interrupted, which aborts the in-flight fetch via that signal.
				return yield* Effect.tryPromise({
					try: async (signal) => {
						const response = await safeFetch(scrapeUrl, {
							method: "GET",
							headers,
							signal,
						})
						return {
							status: response.status,
							body: await response.text(),
							contentType:
								response.headers.get("content-type") ??
								"text/plain; version=0.0.4; charset=utf-8",
							retryAfterSeconds: parseRetryAfterSeconds(
								response.headers.get("retry-after"),
							),
						} satisfies ScrapeTargetProxyResponse
					},
					catch: toPersistenceError,
				}).pipe(
					Effect.timeout(timeoutMs),
					// A timeout surfaces as the same persistence error a fetch abort
					// produced before, so callers see no new error type.
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(toPersistenceError(new Error("The operation was aborted"))),
					),
				)
			})

			const pruneChecks = Effect.fn("ScrapeTargetsService.pruneChecks")(function* (
				targetIds: ReadonlyArray<ScrapeTargetId>,
			) {
				const now = yield* Clock.currentTimeMillis
				const cutoff = now - CHECK_RETENTION_MS
				yield* database
					.execute((db) =>
						db
							.delete(scrapeTargetChecks)
							.where(
								and(
									inArray(scrapeTargetChecks.targetId, [...targetIds]),
									lt(scrapeTargetChecks.checkedAt, new Date(cutoff)),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))

				// Cap backstop for misconfigured/very short intervals: drop everything
				// older than the Nth-newest row per target.
				yield* Effect.forEach(
					targetIds,
					(targetId) =>
						Effect.gen(function* () {
							const capBoundary = yield* database
								.execute((db) =>
									db
										.select({ checkedAt: scrapeTargetChecks.checkedAt })
										.from(scrapeTargetChecks)
										.where(eq(scrapeTargetChecks.targetId, targetId))
										.orderBy(desc(scrapeTargetChecks.checkedAt))
										.limit(1)
										.offset(CHECK_MAX_ROWS_PER_TARGET - 1),
								)
								.pipe(Effect.mapError(toPersistenceError))
							const boundary = capBoundary[0]
							if (boundary === undefined) return
							yield* database
								.execute((db) =>
									db
										.delete(scrapeTargetChecks)
										.where(
											and(
												eq(scrapeTargetChecks.targetId, targetId),
												lt(scrapeTargetChecks.checkedAt, boundary.checkedAt),
											),
										),
								)
								.pipe(Effect.mapError(toPersistenceError))
						}),
					{ discard: true },
				)
			})

			const recordScrapeResults = Effect.fn("ScrapeTargetsService.recordScrapeResults")(function* (
				results: ReadonlyArray<{
					readonly targetId: ScrapeTargetId
					readonly scrapedAt: number
					readonly error: string | null
					readonly subTargetKey?: string | null
					readonly durationMs?: number
					readonly samplesScraped?: number
					readonly samplesPostMetricRelabeling?: number
				}>,
				options?: { readonly recordChecks?: boolean },
			) {
				const resultsByTarget = new Map<ScrapeTargetId, typeof results>()
				for (const result of results) {
					const targetResults = resultsByTarget.get(result.targetId)
					if (targetResults === undefined) {
						resultsByTarget.set(result.targetId, [result])
					} else {
						resultsByTarget.set(result.targetId, [...targetResults, result])
					}
				}

				yield* Effect.forEach(
					resultsByTarget.values(),
					(targetResults) =>
						Effect.forEach(
							targetResults,
							(result) => {
								// Rollup for discovered sub-targets: any branch success advances
								// lastScrapeAt; any branch failure surfaces (branch-prefixed) as
								// lastScrapeError. Per-branch health stays visible in check history
								// via the per-branch `instance`.
								const error =
									result.error !== null && result.subTargetKey
										? `[branch:${result.subTargetKey}] ${result.error}`
										: result.error
								return database
									.execute((db) =>
										db
											.update(scrapeTargets)
											.set(
												error === null
													? {
															lastScrapeAt: new Date(result.scrapedAt),
															lastScrapeError: null,
															updatedAt: new Date(result.scrapedAt),
														}
													: // Failure keeps lastScrapeAt at the last good scrape so data
														// gaps stay visible alongside the error.
														{
															lastScrapeError: error,
															updatedAt: new Date(result.scrapedAt),
														},
											)
											.where(eq(scrapeTargets.id, result.targetId)),
									)
									.pipe(Effect.mapError(toPersistenceError))
							},
							{ discard: true },
						),
					{ concurrency: 8, discard: true },
				)

				if (options?.recordChecks === false || results.length === 0) return

				// Durable check history: one row per scheduled scrape attempt.
				// Resolve orgIds in one pass; results for deleted targets are skipped
				// (the FK would reject them anyway).
				const targetIds = [...new Set(results.map((result) => result.targetId))]
				const targetRows = yield* database
					.execute((db) =>
						db
							.select({ id: scrapeTargets.id, orgId: scrapeTargets.orgId })
							.from(scrapeTargets)
							.where(inArray(scrapeTargets.id, targetIds)),
					)
					.pipe(Effect.mapError(toPersistenceError))
				const orgIdByTarget = new Map(targetRows.map((row) => [row.id, row.orgId]))

				const checkRows = results.flatMap((result) => {
					const orgId = orgIdByTarget.get(result.targetId)
					if (orgId === undefined) return []
					return [
						{
							targetId: result.targetId,
							orgId,
							subTargetKey: result.subTargetKey ?? "",
							checkedAt: new Date(result.scrapedAt),
							error: result.error,
							durationMs: result.durationMs ?? null,
							samplesScraped: result.samplesScraped ?? null,
							samplesPostRelabel: result.samplesPostMetricRelabeling ?? null,
						},
					]
				})

				if (checkRows.length > 0) {
					yield* database
						.execute((db) => db.insert(scrapeTargetChecks).values(checkRows))
						.pipe(Effect.mapError(toPersistenceError))
				}

				yield* pruneChecks([...new Set(checkRows.map((row) => row.targetId))])
			})

			const listChecks = Effect.fn("ScrapeTargetsService.listChecks")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
				query: { readonly startTime?: number; readonly endTime?: number; readonly limit?: number },
			) {
				yield* requireTarget(orgId, targetId)
				const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
				const conditions = [
					eq(scrapeTargetChecks.targetId, targetId),
					eq(scrapeTargetChecks.orgId, orgId),
					...(query.startTime !== undefined
						? [gte(scrapeTargetChecks.checkedAt, new Date(query.startTime))]
						: []),
					...(query.endTime !== undefined
						? [lte(scrapeTargetChecks.checkedAt, new Date(query.endTime))]
						: []),
				]
				return yield* database
					.execute((db) =>
						db
							.select()
							.from(scrapeTargetChecks)
							.where(and(...conditions))
							.orderBy(desc(scrapeTargetChecks.checkedAt), desc(scrapeTargetChecks.id))
							.limit(limit),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const probe = Effect.fn("ScrapeTargetsService.probe")(function* (
				orgId: OrgId,
				targetId: ScrapeTargetId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, scrapeTargetId: targetId })
				const row = yield* requireTarget(orgId, targetId)
				const headers = yield* authHeadersForRow(row)

				const now = yield* Clock.currentTimeMillis
				// `safeFetch` is retained for SSRF protection + redirect re-validation. The
				// manual AbortController/setTimeout is replaced by the interruption-aware
				// signal plus a fixed 10s `Effect.timeout`; the timeout lands as a failure
				// in the captured Exit (→ success: false), matching the old abort path.
				const requestExit = yield* Effect.tryPromise({
					try: async (signal) => {
						const response = await safeFetch(row.url, {
							method: "GET",
							headers,
							signal,
						})
						if (!response.ok) {
							throw new Error(`HTTP ${response.status} ${response.statusText}`)
						}
					},
					catch: (error) => (error instanceof Error ? error : new Error("Connection failed")),
				}).pipe(
					Effect.timeout(10_000),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(new Error("Connection failed")),
					),
					Effect.exit,
				)

				// Manual probes update lastScrapeAt/lastScrapeError but must not
				// fabricate scheduled-check history rows.
				yield* recordScrapeResults(
					[
						{
							targetId,
							scrapedAt: now,
							error: Exit.isSuccess(requestExit) ? null : Cause.pretty(requestExit.cause),
						},
					],
					{ recordChecks: false },
				)

				const updatedRows = yield* database
					.execute((db) =>
						db.select().from(scrapeTargets).where(eq(scrapeTargets.id, targetId)).limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const updated = Option.fromNullishOr(updatedRows[0])
				if (Option.isNone(updated)) {
					return yield* Effect.fail(
						new ScrapeTargetPersistenceError({
							message: "Failed to load probed scrape target",
						}),
					)
				}

				return new ScrapeTargetProbeResponse({
					success: Exit.isSuccess(requestExit),
					lastScrapeAt: updated.value.lastScrapeAt
						? decodeIsoDateTimeStringSync(updated.value.lastScrapeAt.toISOString())
						: null,
					lastScrapeError: updated.value.lastScrapeError ?? null,
				})
			})

			return {
				list,
				get,
				create,
				update,
				delete: remove,
				listAllEnabled,
				scrapeForCollector,
				recordScrapeResults,
				listChecks,
				probe,
			} satisfies ScrapeTargetsServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

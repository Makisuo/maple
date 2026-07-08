import {
	createObservabilityDestination,
	deleteObservabilityDestination,
	listObservabilityDestinations,
	type CloudflareObservabilityDestinationApi,
} from "../lib/CloudflareApi"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs } from "../lib/time"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import { cloudflareObservabilityDestinations, type CloudflareObservabilityDestinationRow } from "@maple/db"
import {
	CloudflareObservabilityDestination,
	OrgId,
	UserId,
	type CloudflareObservabilityDataset,
} from "@maple/domain/http"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"

const TRACE_DATASET = "opentelemetry-traces" as const
const LOGS_DATASET = "opentelemetry-logs" as const
const TRACE_DESTINATION_NAME = "Maple Traces"
const LOGS_DESTINATION_NAME = "Maple Logs"
const EXPECTED_DESTINATIONS: ReadonlyArray<{
	readonly dataset: CloudflareObservabilityDataset
	readonly name: string
}> = [
	{ dataset: TRACE_DATASET, name: TRACE_DESTINATION_NAME },
	{ dataset: LOGS_DATASET, name: LOGS_DESTINATION_NAME },
]

const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-cloudflare-observability")

const normalizeScope = (scope: string | null | undefined): ReadonlyArray<string> => {
	if (!scope) return []
	return scope
		.toLowerCase()
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((s) => s.replace(/[-_.:]/g, ""))
}

/**
 * Cloudflare returns OAuth scopes in either dot/dash API-token form or colon/underscore form
 * (e.g. `workers-observability-telemetry.write` vs `workers_observability_telemetry:write`).
 * Normalize by stripping separators before checking.
 */
export const hasObservabilityScopes = (scope: string | null | undefined): boolean =>
	normalizeScope(scope).includes("workersobservabilitytelemetrywrite")

interface CloudflareObservabilityServiceShape {
	/** Idempotently ensure trace/log Workers Observability destinations exist and return them. */
	readonly ensureDestinations: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<ReadonlyArray<CloudflareObservabilityDestination>, never, never>

	/** Best-effort delete Cloudflare-side destinations and remove persisted rows. */
	readonly deleteDestinations: (orgId: OrgId) => Effect.Effect<void, never, never>
}

interface CloudflareConnectionToken {
	readonly accessToken: string
	readonly accountId: string
	readonly scope: string
}

const fromRow = (row: CloudflareObservabilityDestinationRow): CloudflareObservabilityDestination =>
	new CloudflareObservabilityDestination({
		id: row.id,
		name: row.name,
		dataset: row.dataset as CloudflareObservabilityDataset,
		enabled: row.enabled,
		url: row.url,
		lastError: row.lastError ?? null,
		lastSyncedAt: dateToMs(row.lastSyncedAt),
		scripts: row.scriptsJson ? (JSON.parse(row.scriptsJson) as ReadonlyArray<string>) : [],
	})

const parseLastComplete = (value: string | undefined): Date | null => {
	if (!value || value.length === 0) return null
	const ms = Date.parse(value)
	return Number.isNaN(ms) ? null : new Date(ms)
}

const activeLastError = (jobStatus: CloudflareObservabilityDestinationApi["jobStatus"]): string | null => {
	if (!jobStatus) return null
	const message = jobStatus.errorMessage
	return message && message.length > 0 ? message : null
}

const buildDestinationUrl = (baseUrl: string, dataset: string): string => {
	const clean = baseUrl.replace(/\/$/, "")
	switch (dataset) {
		case TRACE_DATASET:
			return `${clean}/v1/traces`
		case LOGS_DATASET:
			return `${clean}/v1/logs`
		default:
			return `${clean}/v1/${dataset}`
	}
}

const matchesExpected = (
	apiDestination: CloudflareObservabilityDestinationApi,
	dataset: string,
	expectedUrl: string,
): boolean => apiDestination.dataset === dataset && apiDestination.url === expectedUrl

const persistDestination = async (
	db: DatabaseClient,
	orgId: string,
	accountId: string,
	userId: string,
	now: Date,
	apiDestination: CloudflareObservabilityDestinationApi,
): Promise<CloudflareObservabilityDestinationRow> => {
	const existing = await db
		.select()
		.from(cloudflareObservabilityDestinations)
		.where(
			and(
				eq(cloudflareObservabilityDestinations.orgId, orgId),
				eq(cloudflareObservabilityDestinations.slug, apiDestination.slug),
			),
		)
		.limit(1)

	const payload = {
		accountId,
		slug: apiDestination.slug,
		name: apiDestination.name,
		dataset: apiDestination.dataset,
		url: apiDestination.url,
		enabled: apiDestination.enabled,
		scriptsJson: JSON.stringify([...apiDestination.scripts]),
		lastError: activeLastError(apiDestination.jobStatus),
		lastSyncedAt: parseLastComplete(apiDestination.jobStatus?.lastComplete),
		updatedAt: now,
		updatedBy: userId,
	}

	if (existing.length > 0) {
		const [updated] = await db
			.update(cloudflareObservabilityDestinations)
			.set(payload)
			.where(eq(cloudflareObservabilityDestinations.id, existing[0].id))
			.returning()
		return updated
	}

	const [inserted] = await db
		.insert(cloudflareObservabilityDestinations)
		.values({
			id: randomUUID(),
			orgId,
			...payload,
			createdAt: now,
			createdBy: userId,
		})
		.returning()
	return inserted
}

/**
 * Run a database-backed effect and return a fallback value if it fails. All database failures
 * are logged and swallowed so observability provisioning can never break the status endpoint.
 */
const withDbFallback = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	logMessage: string,
	context: Record<string, unknown>,
	fallback: A,
): Effect.Effect<A, never, R> =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(logMessage).pipe(
					Effect.annotateLogs({ ...context, error: Cause.pretty(cause) }),
				)
				return fallback
			}),
		),
	)

/**
 * Run a Cloudflare API effect and return a fallback value if it fails, logging the cause.
 */
const withCloudflareFallback = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	logMessage: string,
	context: Record<string, unknown>,
	fallback: A,
): Effect.Effect<A, never, R> =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(logMessage).pipe(
					Effect.annotateLogs({ ...context, error: Cause.pretty(cause) }),
				)
				return fallback
			}),
		),
	)

const fromOption = <A>(option: Option.Option<A>): A | null => Option.getOrNull(option)

export class CloudflareObservabilityService extends Context.Service<
	CloudflareObservabilityService,
	CloudflareObservabilityServiceShape
>()("@maple/api/services/CloudflareObservabilityService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const oauth = yield* CloudflareOAuthService
		const ingestKeys = yield* OrgIngestKeysService

		const loadRows = (orgId: string) =>
			database.execute((db) =>
				db
					.select()
					.from(cloudflareObservabilityDestinations)
					.where(eq(cloudflareObservabilityDestinations.orgId, orgId)),
			)

		const safeLoadRows = (
			orgId: string,
		): Effect.Effect<ReadonlyArray<CloudflareObservabilityDestination>, never, never> =>
			withDbFallback(
				loadRows(orgId).pipe(Effect.map((rows) => rows.map(fromRow))),
				"Failed to load Cloudflare observability destinations",
				{ orgId },
				[],
			)

		const ensureDestinations = Effect.fn("CloudflareObservabilityService.ensureDestinations")(
			function* (orgId: OrgId, userId: UserId) {
				const tokenOption = yield* oauth
					.getValidAccessToken(orgId)
					.pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Cloudflare Observability skipped: not connected or token invalid").pipe(
								Effect.annotateLogs({ orgId, error }),
							),
						),
						Effect.option,
					)
				const connection = fromOption(tokenOption)

				if (connection === null) {
					return yield* safeLoadRows(orgId)
				}

				if (!hasObservabilityScopes(connection.scope)) {
					yield* Effect.logWarning("Cloudflare Observability skipped: missing telemetry scopes").pipe(
						Effect.annotateLogs({ orgId, scope: connection.scope }),
					)
					return yield* safeLoadRows(orgId)
				}

				const publicKeyOption = yield* ingestKeys
					.getOrCreate(orgId, SYSTEM_USER_ID)
					.pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Cloudflare Observability skipped: no public ingest key").pipe(
								Effect.annotateLogs({ orgId, error }),
							),
						),
						Effect.option,
					)
				const keyResponse = fromOption(publicKeyOption)

				if (keyResponse === null) {
					return yield* safeLoadRows(orgId)
				}

				const apiBaseUrl = env.MAPLE_CLOUDFLARE_API_BASE_URL
				const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL

				const cfDestinations = yield* withCloudflareFallback(
					listObservabilityDestinations(connection.accessToken, connection.accountId, apiBaseUrl),
					"Cloudflare Observability list failed; falling back to persisted rows",
					{ orgId, accountId: connection.accountId },
					[],
				)

				const now = new Date()
				const headers = { "x-maple-ingest-key": keyResponse.publicKey }
				const ensured: CloudflareObservabilityDestination[] = []

				for (const expected of EXPECTED_DESTINATIONS) {
					const url = buildDestinationUrl(ingestBaseUrl, expected.dataset)
					let apiDestination: CloudflareObservabilityDestinationApi | null =
						cfDestinations.find((d) => matchesExpected(d, expected.dataset, url)) ?? null

					if (apiDestination === null) {
						const createOption = yield* createObservabilityDestination(
							connection.accessToken,
							connection.accountId,
							expected.name,
							expected.dataset,
							url,
							headers,
							apiBaseUrl,
						).pipe(
							Effect.tapError((error) =>
								Effect.logWarning("Cloudflare Observability create failed").pipe(
									Effect.annotateLogs({
										orgId,
										accountId: connection.accountId,
										dataset: expected.dataset,
										error,
									}),
								),
							),
							Effect.option,
						)
						apiDestination = fromOption(createOption)
						if (apiDestination === null) {
							continue
						}
					}

					const rowOption = yield* database
						.execute((db) =>
							persistDestination(
								db,
								orgId,
								connection.accountId,
								userId,
								now,
								apiDestination,
							),
						)
						.pipe(
							Effect.tapError((error) =>
								Effect.logWarning("Cloudflare Observability persist failed").pipe(
									Effect.annotateLogs({
										orgId,
										dataset: expected.dataset,
										slug: apiDestination.slug,
										error,
									}),
								),
							),
							Effect.option,
						)
					const row = fromOption(rowOption)

					if (row !== null) {
						yield* Effect.annotateCurrentSpan({
							"maple.cloudflare.observability_destination_upserted": true,
							orgId,
							dataset: expected.dataset,
							slug: apiDestination.slug,
						})
						ensured.push(fromRow(row))
					}
				}

				// Evict rows for datasets Maple no longer manages.
				const managedDatasets = new Set(EXPECTED_DESTINATIONS.map((d) => d.dataset))
				yield* withDbFallback(
					database
						.execute((db) =>
							db
								.select()
								.from(cloudflareObservabilityDestinations)
								.where(eq(cloudflareObservabilityDestinations.orgId, orgId)),
						)
						.pipe(
							Effect.map((rows) =>
								rows.filter((r) => !managedDatasets.has(r.dataset as CloudflareObservabilityDataset)),
							),
							Effect.flatMap((staleRows) =>
								database.execute((db) =>
									db
										.delete(cloudflareObservabilityDestinations)
										.where(
											inArray(
												cloudflareObservabilityDestinations.id,
												staleRows.map((r) => r.id),
											),
										),
								),
							),
						),
					"Failed to evict stale Cloudflare observability rows",
					{ orgId },
					undefined,
				)

				return ensured
			},
		)

		const deleteDestinations = Effect.fn("CloudflareObservabilityService.deleteDestinations")(
			function* (orgId: OrgId) {
				const rows = yield* withDbFallback(
					loadRows(orgId),
					"Failed to load Cloudflare observability destinations for disconnect",
					{ orgId },
					[],
				)

				const tokenOption = yield* oauth
					.getValidAccessToken(orgId)
					.pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Cloudflare Observability disconnect skipped: no valid token").pipe(
								Effect.annotateLogs({ orgId, error }),
							),
						),
						Effect.option,
					)
				const connection = fromOption(tokenOption)

				if (connection) {
					for (const row of rows) {
						yield* withCloudflareFallback(
							deleteObservabilityDestination(
								connection.accessToken,
								connection.accountId,
								row.slug,
								env.MAPLE_CLOUDFLARE_API_BASE_URL,
							),
							"Cloudflare Observability delete failed; removing DB row anyway",
							{ orgId, accountId: connection.accountId, slug: row.slug },
							undefined,
						)
					}
				}

				if (rows.length > 0) {
					yield* withDbFallback(
						database.execute((db) =>
							db
								.delete(cloudflareObservabilityDestinations)
								.where(
									inArray(
										cloudflareObservabilityDestinations.id,
										rows.map((r) => r.id),
									),
								),
						),
						"Failed to delete Cloudflare observability destination rows",
						{ orgId, count: rows.length },
						undefined,
					)
				}
			},
		)

		return {
			ensureDestinations,
			deleteDestinations,
		} satisfies CloudflareObservabilityServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

import { randomUUID } from "node:crypto"
import {
	IntegrationsConfigurationError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	PlanetScaleQueryInsightRow,
	PlanetScaleQueryInsightsResponse,
} from "@maple/domain/http"
import {
	planetscaleConnections,
	planetscaleDatabases,
	planetscaleEvents,
	planetscalePollState,
	type PlanetScaleBranchInfo,
	type PlanetScaleConnectionRow,
	type PlanetScaleDatabaseRow,
	type PlanetScaleEventRow,
} from "@maple/db"
import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { PlanetScaleOAuthService, planetScaleBearerHeader } from "@/services/auth/PlanetScaleOAuthService"
import { insertPlanetScaleEvent } from "./planetscale/webhook-events"
import { summarizeCause } from "@/platform/describe-cause"

/**
 * PlanetScale management-API poller: keeps the org's database/branch inventory
 * (`planetscale_databases`) fresh so the service map can brand + overlay DB
 * nodes and the infra page can list databases. Runs from the alerting worker's
 * every-5-minutes cron (`planetScaleTick`), refreshing each org's inventory on
 * an hourly TTL behind a lease-guarded anchor row in `planetscale_poll_state` —
 * the same overlap-guard shape as the Cloudflare analytics poller.
 *
 * Budget: one databases listing + one branches listing per database, per org,
 * per hour — far below PlanetScale's 600 req/min limit.
 */

const INVENTORY_DATASET = "inventory"
/** Inventory refresh TTL — resource metadata changes slowly. */
const INVENTORY_TTL_MS = Duration.toMillis(Duration.hours(1))

/**
 * Deploy-request history, fanned into `planetscale_events`. Webhooks are the
 * live source; this exists so an org that connects after the fact still has a
 * timeline, and so a missed delivery self-heals.
 */
const DEPLOY_REQUESTS_DATASET = "deploy_requests"
/** Faster than inventory: a deploy an hour late is a deploy nobody can use. */
const DEPLOY_REQUESTS_TTL_MS = Duration.toMillis(Duration.minutes(5))
/** How far back a first backfill reaches. Older deploys have no chart left. */
const DEPLOY_REQUESTS_FLOOR_MS = Duration.toMillis(Duration.days(30))
/** Per-tick budget so a 200-database org can't monopolize the API allowance. */
const DEPLOY_REQUESTS_MAX_DATABASES_PER_TICK = 25
const DEPLOY_REQUESTS_CONCURRENCY = 2
/** Tick-overlap lease. */
const LEASE_MS = Duration.toMillis(Duration.minutes(4))
const REQUEST_TIMEOUT = Duration.seconds(15)
/**
 * Extra attempts after a timed-out request, before the call fails. A PlanetScale
 * slowdown timed out the inventory listing for 5+ orgs at once; a single retry
 * rides out a stall that short without extending the tick meaningfully (worst
 * case 3 × 15s for one path). Jittered so every org's tick doesn't re-hit a
 * struggling API in lockstep. Only timeouts retry — an HTTP error is returned by
 * the caller's own taxonomy (revoked / upstream) and must not be replayed.
 */
const REQUEST_TIMEOUT_RETRIES = 2
const REQUEST_RETRY_BASE_DELAY = Duration.millis(500)
/**
 * Tagged onto the exhausted-timeout failure so the tick can tell "PlanetScale is
 * slow" from "PlanetScale rejected us" without matching on a message string. A
 * genuine upstream 504 classifies the same way, which is correct — both are the
 * provider failing to answer in time.
 */
const UPSTREAM_TIMEOUT_STATUS = 504
const isUpstreamTimeout = (error: { readonly _tag: string; readonly status?: number }) =>
	error._tag === "@maple/http/errors/IntegrationsUpstreamError" && error.status === UPSTREAM_TIMEOUT_STATUS
const ORG_CONCURRENCY = 3
const INVENTORY_WRITE_CONCURRENCY = 4
/** Pagination caps — a runaway org can't make a tick unbounded. */
const PAGE_SIZE = 100
const MAX_PAGES = 10

export interface PlanetScalePollSummary {
	readonly orgs: number
	readonly refreshed: number
	readonly skipped: number
	readonly failures: number
	/** Timeline rows the deploy-request backfill added this tick. */
	readonly deployEvents: number
}

export interface PlanetScaleQueryInsightsOptions {
	readonly database: string
	readonly branch?: string | undefined
	/** Window bounds, epoch ms. */
	readonly startTime: number
	readonly endTime: number
	readonly limit?: number | undefined
}

export interface PlanetScaleListEventsOptions {
	readonly database?: string | undefined
	readonly branch?: string | undefined
	/** Window bounds, epoch ms. */
	readonly startTime: number
	readonly endTime: number
	readonly categories?: ReadonlyArray<string> | undefined
	readonly limit: number
	/** Keyset cursor `${occurredAtMs}:${id}` from the previous page. */
	readonly cursor?: string | undefined
}

export interface PlanetScaleServiceApi {
	readonly pollAllOrgs: () => Effect.Effect<PlanetScalePollSummary, IntegrationsPersistenceError>
	/** The org's (non-deleted) database inventory, for the API surface. */
	readonly listDatabases: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<PlanetScaleDatabaseRow>, IntegrationsPersistenceError>
	/**
	 * The lifecycle timeline for a window: deploy transitions and branch state
	 * changes, newest first. Backs both the chart markers and the activity feed.
	 */
	readonly listEvents: (
		orgId: OrgId,
		options: PlanetScaleListEventsOptions,
	) => Effect.Effect<
		{ readonly events: ReadonlyArray<PlanetScaleEventRow>; readonly nextCursor: string | null },
		IntegrationsPersistenceError
	>
	/**
	 * Live top-queries lookup, proxied to PlanetScale's Query Insights API.
	 * Per-fingerprint cardinality is unbounded (and duplicates the trace-derived
	 * query-shapes feature), so this is never stored — computed on demand and
	 * edge-cached briefly by the HTTP handler.
	 */
	readonly queryInsights: (
		orgId: OrgId,
		options: PlanetScaleQueryInsightsOptions,
	) => Effect.Effect<
		PlanetScaleQueryInsightsResponse,
		| IntegrationsConfigurationError
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
}

const toPersistenceError = (error: unknown) =>
	new IntegrationsPersistenceError({
		message: error instanceof Error ? error.message : "PlanetScale inventory persistence failed",
	})

// Lenient decoders: only the fields we consume, everything else ignored. The
// region/kind shapes differ between the Vitess and Postgres products, so all
// secondary fields are optional.
const DatabaseSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
	plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
	region: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
				display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	),
})

const BranchSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	production: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	ready: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
})

/**
 * Deploy request (GET .../databases/{db}/deploy-requests). Every field beyond
 * the number is optional: the payload shape differs between the Vitess and
 * Postgres products and across API versions, and a missing timestamp should
 * cost one timeline marker, not the whole backfill.
 */
const DeployRequestSchema = Schema.Struct({
	number: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
	into_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
	html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	updated_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	closed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	actor: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	),
	deployment: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				state: Schema.optionalKey(Schema.NullOr(Schema.String)),
				started_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
				finished_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	),
})
type DeployRequest = Schema.Schema.Type<typeof DeployRequestSchema>

// Query Insights list row (GET .../branches/{branch}/insights) — only the
// fields we surface; latencies/durations are milliseconds.
const InsightRowSchema = Schema.Struct({
	fingerprint: Schema.optionalKey(Schema.NullOr(Schema.String)),
	normalized_sql: Schema.optionalKey(Schema.NullOr(Schema.String)),
	statement_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
	query_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	error_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	sum_total_duration_millis: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	time_per_query: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	p50_latency: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	p99_latency: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	rows_read_per_query: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	rows_returned_per_query: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	last_run_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const PageSchema = <S extends Schema.Top>(item: S) =>
	Schema.Struct({
		data: Schema.Array(item),
	})

const parseTimestamp = (value: string | null | undefined): number | null => {
	if (value == null || value === "") return null
	const parsed = Date.parse(value)
	return Number.isNaN(parsed) ? null : parsed
}

/**
 * One deploy request → the timeline rows its timestamps prove happened.
 *
 * The REST payload is a *current state* snapshot, not an event log, so the
 * transitions are reconstructed from the timestamps it carries. Anything the
 * payload doesn't timestamp is not emitted — a marker at the wrong moment is
 * worse than a missing one, because it invites someone to blame the wrong
 * deploy for a latency cliff.
 *
 * The event types match the webhook vocabulary exactly, so a webhook-delivered
 * transition and its backfilled twin collide on the dedupe index.
 */
export const deployRequestTimelineRows = (
	request: DeployRequest,
): ReadonlyArray<{
	readonly eventType: string
	readonly state: string
	readonly occurredAtMs: number
}> => {
	const rows: Array<{ eventType: string; state: string; occurredAtMs: number }> = []
	const push = (state: string, at: number | null) => {
		if (at !== null) rows.push({ eventType: `deploy_request.${state}`, state, occurredAtMs: at })
	}

	push("opened", parseTimestamp(request.created_at))
	push("in_progress", parseTimestamp(request.deployment?.started_at))

	const finishedAt = parseTimestamp(request.deployment?.finished_at)
	if (finishedAt !== null) {
		const deploymentState = request.deployment?.state ?? ""
		push(
			deploymentState === "error" || deploymentState === "errored" ? "errored" : "schema_applied",
			finishedAt,
		)
	}

	const closedAt = parseTimestamp(request.closed_at)
	if (closedAt !== null) {
		push(request.state === "reverted" ? "reverted" : "closed", closedAt)
	}
	return rows
}

/**
 * `${occurredAtMs}:${id}` → its parts. A malformed cursor reads as "no cursor"
 * rather than an error: a stale link should show page one, not a 400.
 */
const parseEventCursor = (
	cursor: string | undefined,
): { readonly occurredAtMs: number; readonly id: string } | null => {
	if (cursor === undefined || cursor === "") return null
	const separator = cursor.indexOf(":")
	if (separator <= 0) return null
	const occurredAtMs = Number(cursor.slice(0, separator))
	const id = cursor.slice(separator + 1)
	if (!Number.isFinite(occurredAtMs) || id === "") return null
	return { occurredAtMs, id }
}

/** Same phrasing as the webhook classifier, so both sources read identically. */
const DEPLOY_BACKFILL_VERB: Record<string, string> = {
	opened: "opened",
	in_progress: "deploying",
	schema_applied: "applied its schema",
	errored: "failed",
	reverted: "was reverted",
	closed: "closed",
} satisfies Record<string, string>

export class PlanetScaleService extends Context.Service<PlanetScaleService, PlanetScaleServiceApi>()(
	"@maple/api/services/PlanetScaleService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const psOAuth = yield* PlanetScaleOAuthService
			const httpClient = yield* HttpClient.HttpClient
			const apiBase = env.MAPLE_PLANETSCALE_API_BASE_URL.replace(/\/$/, "")

			const apiGetJson = Effect.fn("PlanetScaleService.apiGetJson")(function* (
				path: string,
				authorization: string,
			) {
				return yield* Effect.gen(function* () {
					const request = HttpClientRequest.get(`${apiBase}${path}`).pipe(
						HttpClientRequest.setHeaders({
							Authorization: authorization,
							Accept: "application/json",
						}),
					)
					const res = yield* httpClient.execute(request)
					const text = yield* res.text
					return { status: res.status, text }
				}).pipe(
					Effect.mapError(
						(error) =>
							new IntegrationsUpstreamError({
								message: `PlanetScale API request failed: ${error.message}`,
								cause: error,
							}),
					),
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.retry({
						while: (error) => error._tag === "TimeoutError",
						times: REQUEST_TIMEOUT_RETRIES,
						schedule: Schedule.exponential(REQUEST_RETRY_BASE_DELAY).pipe(Schedule.jittered),
					}),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new IntegrationsUpstreamError({
								message: `PlanetScale API request timed out: ${path}`,
								status: UPSTREAM_TIMEOUT_STATUS,
							}),
						),
					),
				)
			})

			/** Fetch all pages of a list endpoint (bounded by MAX_PAGES). */
			const fetchAllPages = Effect.fn("PlanetScaleService.fetchAllPages")(function* <
				S extends Schema.Top,
			>(basePath: string, authorization: string, itemSchema: S) {
				const decodePage = Schema.decodeUnknownEffect(Schema.fromJsonString(PageSchema(itemSchema)))
				const items: Array<S["Type"]> = []
				for (let page = 1; page <= MAX_PAGES; page++) {
					const separator = basePath.includes("?") ? "&" : "?"
					const response = yield* apiGetJson(
						`${basePath}${separator}page=${page}&per_page=${PAGE_SIZE}`,
						authorization,
					)
					// Same taxonomy as fetchOrganizations: a rejected grant surfaces as
					// revoked, so the per-org lastInventoryError copy (and any future
					// tag-keyed handling) distinguishes it from a transient blip.
					if (response.status === 401 || response.status === 403) {
						return yield* Effect.fail(
							new IntegrationsRevokedError({
								message: `PlanetScale rejected the authorization (HTTP ${response.status}) for ${basePath} — reconnect the integration`,
							}),
						)
					}
					if (response.status < 200 || response.status >= 300) {
						return yield* Effect.fail(
							new IntegrationsUpstreamError({
								message: `PlanetScale API returned HTTP ${response.status} for ${basePath}`,
								status: response.status,
							}),
						)
					}
					const decoded = yield* decodePage(response.text).pipe(
						Effect.mapError(
							(cause) =>
								new IntegrationsUpstreamError({
									message: `PlanetScale API returned an unexpected payload for ${basePath}`,
									cause,
								}),
						),
					)
					items.push(...decoded.data)
					if (decoded.data.length < PAGE_SIZE) break
				}
				return items
			})

			/**
			 * Bearer Authorization for the org's OAuth grant, refreshed as needed.
			 * A revoked/missing grant surfaces as-is — the poller records it per-org
			 * and moves on; queryInsights lets the endpoint error union carry it.
			 */
			const authorizationFor = (connection: PlanetScaleConnectionRow) =>
				Schema.decodeEffect(OrgId)(connection.orgId).pipe(
					Effect.orDie,
					Effect.flatMap((orgId) => psOAuth.getValidAccessToken(orgId)),
					Effect.map(({ accessToken }) => planetScaleBearerHeader(accessToken)),
				)

			/**
			 * Claim the org's inventory anchor row for this tick. A non-"claimed"
			 * outcome says exactly why the org was skipped — polling disabled, the
			 * TTL says the inventory is still fresh, or another tick holds the
			 * lease — so pollOrg can put the reason on its span instead of
			 * collapsing them into one invisible boolean.
			 */
			const claimPollWork = Effect.fn("PlanetScaleService.claimPollWork")(function* (
				orgId: OrgId,
				dataset: string,
				databaseId: string,
				ttlMs: number,
			) {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscalePollState)
							.where(
								and(
									eq(planetscalePollState.orgId, orgId),
									eq(planetscalePollState.dataset, dataset),
									eq(planetscalePollState.databaseId, databaseId),
								),
							)
							.limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))
				const existing = rows[0]

				if (existing === undefined) {
					yield* database
						.execute((db) =>
							db.insert(planetscalePollState).values({
								id: randomUUID(),
								orgId,
								dataset,
								databaseId,
								leaseUntil: new Date(now + LEASE_MS),
								createdAt: new Date(now),
								updatedAt: new Date(now),
							}),
						)
						.pipe(Effect.mapError(toPersistenceError))
					return "claimed" as const
				}

				if (!existing.enabled) return "disabled" as const
				if (existing.lastSuccessAt !== null && now - existing.lastSuccessAt.getTime() < ttlMs) {
					return "fresh" as const
				}

				// Lease claim: only wins if the previous lease expired. `.returning()`
				// length is the claim signal (never read driver write-result shapes).
				const claimed = yield* database
					.execute((db) =>
						db
							.update(planetscalePollState)
							.set({ leaseUntil: new Date(now + LEASE_MS), updatedAt: new Date(now) })
							.where(
								and(
									eq(planetscalePollState.id, existing.id),
									or(
										isNull(planetscalePollState.leaseUntil),
										lt(planetscalePollState.leaseUntil, new Date(now)),
									),
								),
							)
							.returning({ id: planetscalePollState.id }),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return claimed.length > 0 ? ("claimed" as const) : ("lease_held" as const)
			})

			/** The org-wide inventory anchor row — also the tick-overlap lease. */
			const claimInventoryWork = (orgId: OrgId) =>
				claimPollWork(orgId, INVENTORY_DATASET, "", INVENTORY_TTL_MS)

			/**
			 * `insertPlanetScaleEvent` is shared with the webhook consumer, which
			 * runs in a layer that provides `Database` directly. Here the service
			 * already holds a resolved instance, so re-provide it rather than let the
			 * requirement leak into every caller's signature.
			 */
			const appendTimelineEvent = (input: Parameters<typeof insertPlanetScaleEvent>[0]) =>
				insertPlanetScaleEvent(input).pipe(Effect.provideService(Database, database))

			const readPollState = Effect.fn("PlanetScaleService.readPollState")(function* (
				orgId: OrgId,
				dataset: string,
				databaseId: string,
			) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscalePollState)
							.where(
								and(
									eq(planetscalePollState.orgId, orgId),
									eq(planetscalePollState.dataset, dataset),
									eq(planetscalePollState.databaseId, databaseId),
								),
							)
							.limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return rows[0]
			})

			/** `databaseId → lastSuccessAt`, for round-robining a budgeted sweep. */
			const pollStateByDatabaseId = Effect.fn("PlanetScaleService.pollStateByDatabaseId")(function* (
				orgId: OrgId,
				dataset: string,
			) {
				const rows = yield* database
					.execute((db) =>
						db
							.select({
								databaseId: planetscalePollState.databaseId,
								lastSuccessAt: planetscalePollState.lastSuccessAt,
							})
							.from(planetscalePollState)
							.where(
								and(
									eq(planetscalePollState.orgId, orgId),
									eq(planetscalePollState.dataset, dataset),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return new Map(rows.map((row) => [row.databaseId, row.lastSuccessAt]))
			})

			/**
			 * Release a non-inventory dataset row. Advancing `watermarkAt` only on
			 * success is what keeps a failed page from being skipped forever.
			 */
			const recordPollResult = Effect.fn("PlanetScaleService.recordPollResult")(function* (
				orgId: OrgId,
				dataset: string,
				databaseId: string,
				error: string | null,
				watermarkAt: Date | null,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(planetscalePollState)
							.set(
								error === null
									? {
											lastSuccessAt: new Date(now),
											lastError: null,
											lastErrorAt: null,
											leaseUntil: null,
											updatedAt: new Date(now),
											...(!(watermarkAt === null) ? { watermarkAt } : undefined),
										}
									: {
											lastError: error,
											lastErrorAt: new Date(now),
											leaseUntil: null,
											updatedAt: new Date(now),
										},
							)
							.where(
								and(
									eq(planetscalePollState.orgId, orgId),
									eq(planetscalePollState.dataset, dataset),
									eq(planetscalePollState.databaseId, databaseId),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const recordInventoryResult = Effect.fn("PlanetScaleService.recordInventoryResult")(function* (
				orgId: OrgId,
				connectionId: string,
				error: string | null,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(planetscalePollState)
							.set(
								error === null
									? {
											lastSuccessAt: new Date(now),
											lastError: null,
											lastErrorAt: null,
											leaseUntil: null,
											updatedAt: new Date(now),
										}
									: {
											lastError: error,
											lastErrorAt: new Date(now),
											leaseUntil: null,
											updatedAt: new Date(now),
										},
							)
							.where(
								and(
									eq(planetscalePollState.orgId, orgId),
									eq(planetscalePollState.dataset, INVENTORY_DATASET),
									eq(planetscalePollState.databaseId, ""),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				yield* database
					.execute((db) =>
						db
							.update(planetscaleConnections)
							.set(
								error === null
									? {
											lastInventoryAt: new Date(now),
											lastInventoryError: null,
											updatedAt: new Date(now),
										}
									: { lastInventoryError: error, updatedAt: new Date(now) },
							)
							.where(eq(planetscaleConnections.id, connectionId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const refreshInventory = Effect.fn("PlanetScaleService.refreshInventory")(function* (
				connection: PlanetScaleConnectionRow,
			) {
				const authorization = yield* authorizationFor(connection)
				const org = encodeURIComponent(connection.psOrganization)

				const upstreamDatabases = yield* fetchAllPages(
					`/v1/organizations/${org}/databases`,
					authorization,
					DatabaseSchema,
				)

				const withBranches = yield* Effect.forEach(
					upstreamDatabases,
					(db) =>
						Effect.gen(function* () {
							const branches = yield* fetchAllPages(
								`/v1/organizations/${org}/databases/${encodeURIComponent(db.name)}/branches`,
								authorization,
								BranchSchema,
							)
							const branchInfos: PlanetScaleBranchInfo[] = branches.map((branch) => ({
								id: branch.id,
								name: branch.name,
								production: branch.production ?? false,
								ready: branch.ready ?? true,
							}))
							return { db, branches: branchInfos }
						}),
					{ concurrency: 4 },
				)

				const now = yield* Clock.currentTimeMillis
				const existingRows = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscaleDatabases)
							.where(eq(planetscaleDatabases.orgId, connection.orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
				const existingByDatabaseId = new Map(existingRows.map((row) => [row.databaseId, row]))
				const upstreamIds = new Set(withBranches.map(({ db }) => db.id))

				yield* Effect.forEach(
					withBranches,
					({ db, branches }) => {
						const values = {
							name: db.name,
							kind: normalizeKind(db.kind),
							state: db.state ?? null,
							region: db.region?.slug ?? db.region?.display_name ?? null,
							plan: db.plan ?? null,
							branchesJson: branches,
							deletedAt: null,
							updatedAt: new Date(now),
						}
						const existing = existingByDatabaseId.get(db.id)
						return (
							existing !== undefined
								? database.execute((client) =>
										client
											.update(planetscaleDatabases)
											.set(values)
											.where(eq(planetscaleDatabases.id, existing.id)),
									)
								: database.execute((client) =>
										client.insert(planetscaleDatabases).values({
											id: randomUUID(),
											orgId: connection.orgId,
											databaseId: db.id,
											createdAt: new Date(now),
											...values,
										}),
									)
						).pipe(Effect.mapError(toPersistenceError))
					},
					{ concurrency: INVENTORY_WRITE_CONCURRENCY, discard: true },
				)

				// Soft-delete rows whose database disappeared upstream, so identity is
				// kept if it re-appears.
				yield* Effect.forEach(
					existingRows.filter((row) => !upstreamIds.has(row.databaseId) && row.deletedAt === null),
					(row) =>
						database
							.execute((client) =>
								client
									.update(planetscaleDatabases)
									.set({ deletedAt: new Date(now), updatedAt: new Date(now) })
									.where(eq(planetscaleDatabases.id, row.id)),
							)
							.pipe(Effect.mapError(toPersistenceError)),
					{ concurrency: INVENTORY_WRITE_CONCURRENCY, discard: true },
				)

				return withBranches.length
			})

			/**
			 * Backfill one database's deploy-request history into the timeline.
			 *
			 * Every insert is idempotent, so this is safe to re-run and safe to
			 * overlap with live webhook deliveries of the same transitions — the
			 * dedupe index is what makes the two sources converge.
			 */
			const refreshDeployRequestsFor = Effect.fn("PlanetScaleService.refreshDeployRequestsFor")(
				function* (
					connection: PlanetScaleConnectionRow,
					database_: PlanetScaleDatabaseRow,
					authorization: string,
				) {
					const claim = yield* claimPollWork(
						connection.orgId,
						DEPLOY_REQUESTS_DATASET,
						database_.databaseId,
						DEPLOY_REQUESTS_TTL_MS,
					)
					if (claim !== "claimed") {
						yield* Effect.annotateCurrentSpan({ "maple.planetscale.skip_reason": claim })
						return 0
					}
					const orgId = yield* Schema.decodeEffect(OrgId)(connection.orgId).pipe(Effect.orDie)

					const state = yield* readPollState(
						connection.orgId,
						DEPLOY_REQUESTS_DATASET,
						database_.databaseId,
					)
					const now = yield* Clock.currentTimeMillis
					// First backfill reaches 30 days; afterwards only what changed since
					// the watermark, so a steady-state tick pages once and stops.
					const floor = Math.max(state?.watermarkAt?.getTime() ?? 0, now - DEPLOY_REQUESTS_FLOOR_MS)

					const org = encodeURIComponent(connection.psOrganization)
					const requests = yield* fetchAllPages(
						`/v1/organizations/${org}/databases/${encodeURIComponent(database_.name)}/deploy-requests`,
						authorization,
						DeployRequestSchema,
					)

					let inserted = 0
					let newestUpdate = state?.watermarkAt?.getTime() ?? 0
					for (const request of requests) {
						const updatedAt = parseTimestamp(request.updated_at) ?? 0
						if (updatedAt > newestUpdate) newestUpdate = updatedAt
						// Untouched since the watermark: its transitions are already stored.
						if (updatedAt !== 0 && updatedAt <= floor) continue

						const externalId =
							request.number != null ? String(request.number) : (request.id ?? "")
						const label = externalId === "" ? "Deploy request" : `Deploy request #${externalId}`
						for (const row of deployRequestTimelineRows(request)) {
							if (row.occurredAtMs < now - DEPLOY_REQUESTS_FLOOR_MS) continue
							const result = yield* appendTimelineEvent({
								orgId,
								databaseName: database_.name,
								// A deploy request spans two branches; pinning the marker to
								// one of them would be a guess the payload doesn't support.
								branchName: "",
								category: "deploy_request",
								eventType: row.eventType,
								state: row.state,
								externalId,
								title: `${label} ${DEPLOY_BACKFILL_VERB[row.state] ?? row.state}`,
								source: "backfill",
								actorLogin: request.actor?.display_name ?? null,
								url: request.html_url ?? null,
								payload: {
									branch: request.branch ?? null,
									intoBranch: request.into_branch ?? null,
								},
								occurredAtMs: row.occurredAtMs,
								createdAtMs: now,
							}).pipe(Effect.mapError(toPersistenceError))
							if (result.inserted) inserted++
						}
					}

					yield* recordPollResult(
						connection.orgId,
						DEPLOY_REQUESTS_DATASET,
						database_.databaseId,
						null,
						newestUpdate > 0 ? new Date(newestUpdate) : null,
					)
					yield* Effect.annotateCurrentSpan({
						"maple.planetscale.deploy_requests.seen": requests.length,
						"maple.planetscale.deploy_requests.inserted": inserted,
					})
					return inserted
				},
			)

			/**
			 * Deploy-request backfill across the org, budgeted. Runs after the
			 * inventory refresh and inside its own error boundary — a failure here
			 * must never cost the org its inventory.
			 */
			const refreshDeployRequests = Effect.fn("PlanetScaleService.refreshDeployRequests")(function* (
				connection: PlanetScaleConnectionRow,
			) {
				const authorization = yield* authorizationFor(connection)
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscaleDatabases)
							.where(
								and(
									eq(planetscaleDatabases.orgId, connection.orgId),
									isNull(planetscaleDatabases.deletedAt),
									// Deploy requests are a MySQL/Vitess-only resource — Postgres
									// databases answer 405 on this endpoint. Polling them anyway
									// burned a slot in every tick's batch and buried the result
									// in a logWarning, so it repeated forever.
									eq(planetscaleDatabases.kind, "mysql"),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))

				// Round-robin by staleness so every database is reached eventually
				// rather than the first 25 alphabetically being reached always.
				const staleness = yield* pollStateByDatabaseId(connection.orgId, DEPLOY_REQUESTS_DATASET)
				const ordered = [...rows].sort(
					(a, b) =>
						(staleness.get(a.databaseId)?.getTime() ?? 0) -
						(staleness.get(b.databaseId)?.getTime() ?? 0),
				)
				const batch = ordered.slice(0, DEPLOY_REQUESTS_MAX_DATABASES_PER_TICK)
				if (ordered.length > batch.length) {
					// Never truncate silently — a partial sweep that reads as complete is
					// how a stale timeline goes unnoticed.
					yield* Effect.logInfo("PlanetScale deploy-request backfill truncated for this tick").pipe(
						Effect.annotateLogs({
							orgId: connection.orgId,
							databases: ordered.length,
							polled: batch.length,
						}),
					)
				}

				const counts = yield* Effect.forEach(
					batch,
					(row) =>
						refreshDeployRequestsFor(connection, row, authorization).pipe(
							// One bad database must not stop the others.
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("PlanetScale deploy-request backfill failed").pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												database: row.name,
												error: summarizeCause(cause),
											}),
											Effect.map(() => 0),
										),
							),
						),
					{ concurrency: DEPLOY_REQUESTS_CONCURRENCY },
				)
				return counts.reduce((sum, count) => sum + count, 0)
			})

			const pollOrg = Effect.fn("PlanetScaleService.pollOrg")(function* (
				connection: PlanetScaleConnectionRow,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
				const claim = yield* claimInventoryWork(connection.orgId)
				// Deliberately outside the inventory claim: inventory refreshes hourly,
				// and a deploy marker an hour late is a deploy nobody can correlate.
				// Each database row carries its own lease + 5-minute TTL, so this is
				// safe to enter on every tick. Its own error boundary — a broken
				// backfill must never cost the org its inventory.
				const deployEvents = yield* refreshDeployRequests(connection).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logWarning("PlanetScale deploy-request backfill failed for org").pipe(
									Effect.annotateLogs({
										orgId: connection.orgId,
										error: summarizeCause(cause),
									}),
									Effect.map(() => 0),
								),
					),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.planetscale.deploy_events_inserted": deployEvents,
				})

				if (claim !== "claimed") {
					// A silent skip is how the Cloudflare poller once hid a real outage —
					// put the reason on the span (mirrors CloudflareAnalyticsService.pollOrg)
					// so every skipped org is visible on the trace.
					yield* Effect.annotateCurrentSpan({ "maple.planetscale.skip_reason": claim })
					return { outcome: "skipped" as const, deployEvents }
				}

				const result = yield* refreshInventory(connection).pipe(
					Effect.map((count) => ({ ok: true as const, count })),
					Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
				)
				if (result.ok) {
					yield* recordInventoryResult(connection.orgId, connection.id, null)
					yield* Effect.logInfo("PlanetScale inventory refreshed").pipe(
						Effect.annotateLogs({ orgId: connection.orgId, databases: result.count }),
					)
					return { outcome: "refreshed" as const, deployEvents }
				}
				yield* recordInventoryResult(connection.orgId, connection.id, result.error.message).pipe(
					Effect.ignore,
				)
				// Fail inside a span so poll failures surface in find_errors, mirroring
				// the Cloudflare poller's observeDatasetFailure seam — EXCEPT an upstream
				// timeout, which is a transient provider slowdown (theirs timed out 5+ orgs
				// at once) that the next tick refreshes, not a Maple failure. That one is
				// recorded on an Ok span as `error.type` + a Warn log, per CLAUDE.md's
				// "only 5xx is Error" rule; both paths still log identically.
				const timedOut = isUpstreamTimeout(result.error)
				yield* (
					timedOut
						? Effect.annotateCurrentSpan({ "error.type": "upstream_timeout" })
						: Effect.fail(result.error)
				).pipe(
					Effect.withSpan("PlanetScaleService.inventoryPollFailed", {
						attributes: { orgId: connection.orgId },
					}),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
					),
					Effect.andThen(
						Effect.logWarning("PlanetScale inventory refresh failed").pipe(
							Effect.annotateLogs({
								orgId: connection.orgId,
								"error.type": timedOut ? "upstream_timeout" : result.error._tag,
								error: result.error.message,
							}),
						),
					),
				)
				return { outcome: "failed" as const, deployEvents }
			})

			const pollAllOrgs = Effect.fn("PlanetScaleService.pollAllOrgs")(function* () {
				const connections = yield* database
					.execute((db) => db.select().from(planetscaleConnections))
					.pipe(
						Effect.mapError(toPersistenceError),
						Effect.tapError((error) =>
							Effect.logWarning("PlanetScale poll could not list connections").pipe(
								Effect.annotateLogs({ error: error.message }),
							),
						),
					)

				let refreshed = 0
				let skipped = 0
				let failures = 0
				let deployEvents = 0
				yield* Effect.forEach(
					connections,
					(connection) =>
						pollOrg(connection).pipe(
							Effect.map((result) => {
								deployEvents += result.deployEvents
								if (result.outcome === "refreshed") refreshed++
								else if (result.outcome === "skipped") skipped++
								else failures++
							}),
							// A broken org must not stop the fleet.
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("PlanetScale org poll failed").pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												error: summarizeCause(cause),
											}),
											Effect.map(() => {
												failures++
											}),
										),
							),
						),
					{ concurrency: ORG_CONCURRENCY, discard: true },
				)

				return { orgs: connections.length, refreshed, skipped, failures, deployEvents }
			})

			const queryInsights = Effect.fn("PlanetScaleService.queryInsights")(function* (
				orgId: OrgId,
				options: PlanetScaleQueryInsightsOptions,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.planetscale.database": options.database,
					"maple.planetscale.branch": options.branch ?? "",
				})
				const connections = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscaleConnections)
							.where(eq(planetscaleConnections.orgId, orgId))
							.limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))
				const connection = connections[0]
				if (connection === undefined) {
					return yield* Effect.fail(
						new IntegrationsNotConnectedError({
							message: "PlanetScale is not connected for this organization",
						}),
					)
				}

				// Default to the database's production branch from the inventory.
				let branch = options.branch
				if (branch === undefined || branch.length === 0) {
					const rows = yield* database
						.execute((db) =>
							db
								.select()
								.from(planetscaleDatabases)
								.where(
									and(
										eq(planetscaleDatabases.orgId, orgId),
										eq(planetscaleDatabases.name, options.database),
									),
								)
								.limit(1),
						)
						.pipe(Effect.mapError(toPersistenceError))
					const branches = rows[0]?.branchesJson ?? []
					branch = branches.find((entry) => entry.production)?.name ?? branches[0]?.name ?? "main"
				}

				const authorization = yield* authorizationFor(connection)
				const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 25)
				const path =
					`/v1/organizations/${encodeURIComponent(connection.psOrganization)}` +
					`/databases/${encodeURIComponent(options.database)}` +
					`/branches/${encodeURIComponent(branch)}/insights` +
					`?from=${encodeURIComponent(new Date(options.startTime).toISOString())}` +
					`&to=${encodeURIComponent(new Date(options.endTime).toISOString())}` +
					`&sort=totalTime&dir=desc&per_page=${limit}`

				const response = yield* apiGetJson(path, authorization)
				if (response.status < 200 || response.status >= 300) {
					// Authz/branch-shaped rejections soft-fail so the panel renders an
					// inline empty state instead of a 5xx toast (top-traffic pattern).
					return new PlanetScaleQueryInsightsResponse({
						branch,
						rows: [],
						unavailableReason:
							response.status === 401 || response.status === 403
								? "The PlanetScale authorization lacks the read_databases scope needed for Query Insights."
								: response.status === 404
									? `PlanetScale has no insights for ${options.database}/${branch}.`
									: `PlanetScale Query Insights returned HTTP ${response.status}.`,
					})
				}

				const decoded = yield* Schema.decodeEffect(
					Schema.fromJsonString(PageSchema(InsightRowSchema)),
				)(response.text).pipe(
					Effect.mapError(
						(cause) =>
							new IntegrationsUpstreamError({
								message: "PlanetScale Query Insights returned an unexpected payload",
								cause,
							}),
					),
				)

				return new PlanetScaleQueryInsightsResponse({
					branch,
					unavailableReason: null,
					rows: decoded.data.flatMap((row) => {
						const normalizedSql = row.normalized_sql ?? ""
						if (normalizedSql.length === 0) return []
						const lastRunAtMs = row.last_run_at ? Date.parse(row.last_run_at) : Number.NaN
						return [
							new PlanetScaleQueryInsightRow({
								fingerprint: row.fingerprint ?? normalizedSql,
								normalizedSql,
								statementType: row.statement_type ?? null,
								queryCount: row.query_count ?? 0,
								errorCount: row.error_count ?? 0,
								totalDurationMillis: row.sum_total_duration_millis ?? 0,
								timePerQueryMillis: row.time_per_query ?? 0,
								p50LatencyMillis: row.p50_latency ?? 0,
								p99LatencyMillis: row.p99_latency ?? 0,
								rowsReadPerQuery: row.rows_read_per_query ?? 0,
								rowsReturnedPerQuery: row.rows_returned_per_query ?? 0,
								lastRunAt: Number.isFinite(lastRunAtMs) ? lastRunAtMs : null,
							}),
						]
					}),
				})
			})

			const listDatabases = Effect.fn("PlanetScaleService.listDatabases")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				return yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscaleDatabases)
							.where(
								and(
									eq(planetscaleDatabases.orgId, orgId),
									isNull(planetscaleDatabases.deletedAt),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const listEvents = Effect.fn("PlanetScaleService.listEvents")(function* (
				orgId: OrgId,
				options: PlanetScaleListEventsOptions,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.planetscale.database": options.database })

				// Keyset pagination over (occurred_at DESC, id DESC): an offset would
				// skip rows as live webhooks land at the head between pages.
				const cursor = parseEventCursor(options.cursor)
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(planetscaleEvents)
							.where(
								and(
									// OrgId first, always.
									eq(planetscaleEvents.orgId, orgId),
									gte(planetscaleEvents.occurredAt, new Date(options.startTime)),
									lte(planetscaleEvents.occurredAt, new Date(options.endTime)),
									...(options.database === undefined
										? []
										: [eq(planetscaleEvents.databaseName, options.database)]),
									// A deploy request has no single branch, so a branch filter
									// must not hide deploys — it narrows branch-scoped rows only.
									...(options.branch === undefined
										? []
										: [
												or(
													eq(planetscaleEvents.branchName, options.branch),
													eq(planetscaleEvents.branchName, ""),
												)!,
											]),
									...(options.categories === undefined || options.categories.length === 0
										? []
										: [inArray(planetscaleEvents.category, [...options.categories])]),
									...(cursor === null
										? []
										: [
												or(
													lt(
														planetscaleEvents.occurredAt,
														new Date(cursor.occurredAtMs),
													),
													and(
														eq(
															planetscaleEvents.occurredAt,
															new Date(cursor.occurredAtMs),
														),
														lt(planetscaleEvents.id, cursor.id),
													),
												)!,
											]),
								),
							)
							.orderBy(desc(planetscaleEvents.occurredAt), desc(planetscaleEvents.id))
							// One extra row is how we know a next page exists without a count.
							.limit(options.limit + 1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const events = rows.slice(0, options.limit)
				const last = events[events.length - 1]
				const nextCursor =
					rows.length > options.limit && last !== undefined
						? `${last.occurredAt.getTime()}:${last.id}`
						: null
				return { events, nextCursor }
			})

			return {
				pollAllOrgs,
				listDatabases,
				listEvents,
				queryInsights,
			} satisfies PlanetScaleServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

/** Normalize PlanetScale's product kind to "mysql" | "postgresql". */
const normalizeKind = (kind: string | null | undefined): string => {
	const normalized = (kind ?? "").toLowerCase()
	if (normalized.includes("postgres")) return "postgresql"
	return "mysql"
}

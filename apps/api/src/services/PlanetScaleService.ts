import { randomUUID } from "node:crypto"
import {
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
	planetscalePollState,
	type PlanetScaleBranchInfo,
	type PlanetScaleConnectionRow,
	type PlanetScaleDatabaseRow,
} from "@maple/db"
import { and, eq, isNull, lt, or } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { PlanetScaleOAuthService, planetScaleBearerHeader } from "./PlanetScaleOAuthService"

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
/** Tick-overlap lease. */
const LEASE_MS = Duration.toMillis(Duration.minutes(4))
const REQUEST_TIMEOUT = Duration.seconds(15)
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
}

export interface PlanetScaleQueryInsightsOptions {
	readonly database: string
	readonly branch?: string | undefined
	/** Window bounds, epoch ms. */
	readonly startTime: number
	readonly endTime: number
	readonly limit?: number | undefined
}

export interface PlanetScaleServiceShape {
	readonly pollAllOrgs: () => Effect.Effect<PlanetScalePollSummary, IntegrationsPersistenceError>
	/** The org's (non-deleted) database inventory, for the API surface. */
	readonly listDatabases: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<PlanetScaleDatabaseRow>, IntegrationsPersistenceError>
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

export class PlanetScaleService extends Context.Service<PlanetScaleService, PlanetScaleServiceShape>()(
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
							}),
					),
					Effect.timeoutOrElse({
						duration: REQUEST_TIMEOUT,
						orElse: () =>
							Effect.fail(
								new IntegrationsUpstreamError({
									message: `PlanetScale API request timed out: ${path}`,
								}),
							),
					}),
				)
			})

			/** Fetch all pages of a list endpoint (bounded by MAX_PAGES). */
			const fetchAllPages = Effect.fn("PlanetScaleService.fetchAllPages")(function* <S extends Schema.Top>(
				basePath: string,
				authorization: string,
				itemSchema: S,
			) {
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
							() =>
								new IntegrationsUpstreamError({
									message: `PlanetScale API returned an unexpected payload for ${basePath}`,
								}),
						),
					)
					items.push(...decoded.data)
					if (decoded.data.length < PAGE_SIZE) break
				}
				return items
			})

			const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

			/**
			 * Bearer Authorization for the org's OAuth grant, refreshed as needed.
			 * A revoked/missing grant surfaces as-is — the poller records it per-org
			 * and moves on; queryInsights lets the endpoint error union carry it.
			 */
			const authorizationFor = (connection: PlanetScaleConnectionRow) =>
				psOAuth
					.getValidAccessToken(decodeOrgIdSync(connection.orgId))
					.pipe(Effect.map(({ accessToken }) => planetScaleBearerHeader(accessToken)))

			/**
			 * Claim the org's inventory anchor row for this tick. A non-"claimed"
			 * outcome says exactly why the org was skipped — polling disabled, the
			 * TTL says the inventory is still fresh, or another tick holds the
			 * lease — so pollOrg can put the reason on its span instead of
			 * collapsing them into one invisible boolean.
			 */
			const claimInventoryWork = Effect.fn("PlanetScaleService.claimInventoryWork")(function* (
				orgId: string,
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
									eq(planetscalePollState.dataset, INVENTORY_DATASET),
									eq(planetscalePollState.databaseId, ""),
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
								dataset: INVENTORY_DATASET,
								databaseId: "",
								leaseUntil: new Date(now + LEASE_MS),
								createdAt: new Date(now),
								updatedAt: new Date(now),
							}),
						)
						.pipe(Effect.mapError(toPersistenceError))
					return "claimed" as const
				}

				if (!existing.enabled) return "disabled" as const
				if (
					existing.lastSuccessAt !== null &&
					now - existing.lastSuccessAt.getTime() < INVENTORY_TTL_MS
				) {
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

			const recordInventoryResult = Effect.fn("PlanetScaleService.recordInventoryResult")(function* (
				orgId: string,
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
									? { lastInventoryAt: new Date(now), lastInventoryError: null, updatedAt: new Date(now) }
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

			const pollOrg = Effect.fn("PlanetScaleService.pollOrg")(function* (
				connection: PlanetScaleConnectionRow,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
				const claim = yield* claimInventoryWork(connection.orgId)
				if (claim !== "claimed") {
					// A silent skip is how the Cloudflare poller once hid a real outage —
					// put the reason on the span (mirrors CloudflareAnalyticsService.pollOrg)
					// so every skipped org is visible on the trace.
					yield* Effect.annotateCurrentSpan({ "maple.planetscale.skip_reason": claim })
					return "skipped" as const
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
					return "refreshed" as const
				}
				yield* recordInventoryResult(connection.orgId, connection.id, result.error.message).pipe(
					Effect.ignore,
				)
				// Fail inside a span so poll failures surface in find_errors, mirroring
				// the Cloudflare poller's observeDatasetFailure seam.
				yield* Effect.fail(result.error).pipe(
					Effect.withSpan("PlanetScaleService.inventoryPollFailed", {
						attributes: { orgId: connection.orgId },
					}),
					Effect.catchCause((cause) =>
						Effect.logWarning("PlanetScale inventory refresh failed").pipe(
							Effect.annotateLogs({ orgId: connection.orgId, error: Cause.pretty(cause) }),
						),
					),
				)
				return "failed" as const
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
				yield* Effect.forEach(
					connections,
					(connection) =>
						pollOrg(connection).pipe(
							Effect.map((outcome) => {
								if (outcome === "refreshed") refreshed++
								else if (outcome === "skipped") skipped++
								else failures++
							}),
							// A broken org must not stop the fleet.
							Effect.catchCause((cause) =>
								Effect.logWarning("PlanetScale org poll failed").pipe(
									Effect.annotateLogs({
										orgId: connection.orgId,
										error: Cause.pretty(cause),
									}),
									Effect.map(() => {
										failures++
									}),
								),
							),
						),
					{ concurrency: ORG_CONCURRENCY, discard: true },
				)

				return { orgs: connections.length, refreshed, skipped, failures }
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
					`&sort=sum_total_duration_millis&dir=desc&per_page=${limit}`

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

				const decoded = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(PageSchema(InsightRowSchema)),
				)(response.text).pipe(
					Effect.mapError(
						() =>
							new IntegrationsUpstreamError({
								message: "PlanetScale Query Insights returned an unexpected payload",
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
								and(eq(planetscaleDatabases.orgId, orgId), isNull(planetscaleDatabases.deletedAt)),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			return { pollAllOrgs, listDatabases, queryInsights } satisfies PlanetScaleServiceShape
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

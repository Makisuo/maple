/**
 * Cloudflare edge-analytics collector.
 *
 * Polls the Cloudflare GraphQL Analytics API for every org with a connected Cloudflare account
 * and writes the results into the regular OTel metrics pipeline (`metrics_sum`/`metrics_gauge`
 * Tinybird datasources), so the metric explorer, dashboard builder, and alerting all work on
 * edge data with zero new query paths.
 *
 * Collected per account:
 * - `httpRequestsAdaptiveGroups` per zone: request counts by cache status × response-status
 *   class, bytes, visits, and zone-level TTFB / origin-duration percentiles per 5-min bucket.
 * - `workersInvocationsAdaptive`: Worker requests/errors and CPU-time/duration percentiles per
 *   script.
 *
 * State lives in `cloudflare_analytics_state` (one row per org × dataset × zone): watermark of
 * the last fully-ingested bucket, cached dataset `settings` (Cloudflare's per-plan limits), a
 * lease column as the tick-overlap guard, and last success/error for the integration UI. The
 * poll loop is resumable by construction — a budget-exhausted backfill simply continues from
 * its watermark on the next tick. Metrics rows are written exactly once because a window is
 * only ever ingested before its watermark advances, and windows never overlap.
 */
import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	RoleName,
	UserId as UserIdSchema,
	type OrgId,
} from "@maple/domain/http"
import { cloudflareAnalyticsState, oauthConnections, type CloudflareAnalyticsStateRow } from "@maple/db"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Result, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import {
	graphqlQuery,
	listZones,
	type CloudflareGraphqlError,
	type CloudflareGraphqlResult,
	type CloudflareZone,
} from "../lib/CloudflareApi"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs } from "../lib/time"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import {
	mapHttpGroups,
	mapWorkersGroups,
	type CloudflareMetricRows,
	type MetricGaugeRow,
	type MetricSumRow,
} from "./cloudflare-analytics/mapping"
import {
	decodeHttpAnalyticsResponse,
	decodeSettingsResponse,
	decodeWorkersAnalyticsResponse,
	httpAnalyticsQuery,
	HTTP_DATASET,
	MAX_ZONES_PER_QUERY,
	settingsQuery,
	toGraphqlTime,
	WORKERS_DATASET,
	workersAnalyticsQuery,
	type DatasetSettingsShape,
} from "./cloudflare-analytics/queries"

/**
 * OAuth scopes the poller needs (space-delimited ids in `oauth_connections.scope`). Kept next to
 * the service so the HTTP status route and the poll gating share one source of truth.
 * TODO(cf-analytics): verify against GET /client/v4/oauth/scopes before shipping.
 */
export const CLOUDFLARE_ANALYTICS_SCOPES = ["account-analytics.read", "zone.read"] as const

export const hasAnalyticsScopes = (scope: string): boolean => {
	const granted = new Set(scope.split(/[\s,]+/).filter((s) => s.length > 0))
	return CLOUDFLARE_ANALYTICS_SCOPES.every((required) => granted.has(required))
}

const BUCKET_MS = 5 * 60_000
/** Never query buckets younger than this — ABR data needs a few minutes to become complete. */
const SAFETY_LAG_MS = 10 * 60_000
/** How far back the first poll reaches (further bounded by the plan's `notOlderThan`). */
const BACKFILL_MS = 24 * 60 * 60_000
/**
 * Max window per GraphQL call. 12 buckets × worst-case ~200 (cacheStatus × status) groups stays
 * comfortably under Cloudflare's 5000-rows-per-selection cap.
 */
const MAX_WINDOW_MS = 60 * 60_000
/** Hard per-org call budget per tick so a pathological backfill can't blow the 300/5min limit. */
const MAX_CALLS_PER_ORG_TICK = 50
const LEASE_MS = 4 * 60_000
const SETTINGS_TTL_MS = 24 * 60 * 60_000
const INGEST_CHUNK = 500
const ORG_CONCURRENCY = 3

const MISSING_SCOPES_ERROR =
	"Cloudflare connection lacks the analytics scopes — reconnect the integration to update permissions"

const floorToBucket = (ms: number) => ms - (ms % BUCKET_MS)

const chunk = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[])
	return out
}

const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "Cloudflare analytics database error",
	})

/** Classify GraphQL-level errors (HTTP 200 + errors[]) into the poller's reaction. */
type GraphqlErrorKind = "authz" | "disabled" | "quantiles-unavailable" | "other"

const classifyGraphqlErrors = (errors: ReadonlyArray<CloudflareGraphqlError>): GraphqlErrorKind => {
	const messages = errors.map((e) => e.message.toLowerCase())
	// Plan lacks the timing-quantile fields → the query referenced an unknown field. Degrade to
	// counters-only instead of erroring forever.
	if (
		messages.some(
			(m) =>
				(m.includes("unknown") || m.includes("cannot query")) &&
				(m.includes("edgetimetofirstbytems") || m.includes("cputime") || m.includes("quantiles")),
		)
	) {
		return "quantiles-unavailable"
	}
	if (messages.some((m) => m.includes("not authorized") || m.includes("unauthorized") || m.includes("access denied"))) {
		return "authz"
	}
	if (messages.some((m) => m.includes("not enabled") || m.includes("disabled"))) {
		return "disabled"
	}
	return "other"
}

const graphqlErrorMessage = (errors: ReadonlyArray<CloudflareGraphqlError>): string =>
	errors
		.map((e) => e.message)
		.join("; ")
		.slice(0, 500)

interface ParsedSettings {
	readonly notOlderThanMs: number | null
	readonly maxDurationMs: number | null
}

const parseStoredSettings = (settingsJson: string | null): ParsedSettings => {
	if (!settingsJson) return { notOlderThanMs: null, maxDurationMs: null }
	try {
		const parsed = JSON.parse(settingsJson) as { notOlderThan?: number | null; maxDuration?: number | null }
		return {
			notOlderThanMs: typeof parsed.notOlderThan === "number" ? parsed.notOlderThan * 1000 : null,
			maxDurationMs: typeof parsed.maxDuration === "number" ? parsed.maxDuration * 1000 : null,
		}
	} catch {
		return { notOlderThanMs: null, maxDurationMs: null }
	}
}

/** `availableFields` naming isn't pinned by docs — match on substring, defaulting to available. */
const quantilesFromAvailableFields = (
	settings: DatasetSettingsShape | null | undefined,
	needle: string,
): boolean => {
	const fields = settings?.availableFields
	if (fields == null) return true
	return fields.some((field) => field.toLowerCase().includes(needle))
}

export interface CloudflareAnalyticsZoneStatus {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly lastSyncedAt: number | null
	readonly lastError: string | null
}

export interface CloudflareAnalyticsStatus {
	readonly zones: ReadonlyArray<CloudflareAnalyticsZoneStatus>
	readonly workers: {
		readonly enabled: boolean
		readonly lastSyncedAt: number | null
		readonly lastError: string | null
	} | null
}

export interface PollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly callsMade: number
	readonly rowsIngested: number
}

export interface PollAllOrgsSummary {
	readonly orgs: number
	readonly rowsIngested: number
}

export interface CloudflareAnalyticsServiceShape {
	readonly pollAllOrgs: () => Effect.Effect<PollAllOrgsSummary, IntegrationsPersistenceError>
	readonly pollOrg: (orgId: OrgId) => Effect.Effect<PollOrgSummary, IntegrationsPersistenceError>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<CloudflareAnalyticsStatus, IntegrationsPersistenceError>
}

export class CloudflareAnalyticsService extends Context.Service<
	CloudflareAnalyticsService,
	CloudflareAnalyticsServiceShape
>()("@maple/api/services/CloudflareAnalyticsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const warehouse = yield* WarehouseQueryService
		const oauth = yield* CloudflareOAuthService

		const apiBaseUrl = env.MAPLE_CLOUDFLARE_API_BASE_URL

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-cloudflare-analytics"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		// ------------------------------------------------------------------
		// State-row helpers
		// ------------------------------------------------------------------

		const loadStateRows = (orgId: OrgId) =>
			dbExecute((db) =>
				db.select().from(cloudflareAnalyticsState).where(eq(cloudflareAnalyticsState.orgId, orgId)),
			)

		const recordError = (rowIds: ReadonlyArray<string>, message: string, now: number) =>
			rowIds.length === 0
				? Effect.void
				: dbExecute((db) =>
						db
							.update(cloudflareAnalyticsState)
							.set({
								lastError: message.slice(0, 500),
								lastErrorAt: new Date(now),
								updatedAt: new Date(now),
							})
							.where(
								sql`${cloudflareAnalyticsState.id} in (${sql.join(
									rowIds.map((id) => sql`${id}`),
									sql`, `,
								)})`,
							),
					)

		const recordOrgError = (orgId: OrgId, message: string, now: number, options?: { disable?: boolean }) =>
			dbExecute((db) =>
				db
					.update(cloudflareAnalyticsState)
					.set({
						lastError: message.slice(0, 500),
						lastErrorAt: new Date(now),
						...(options?.disable ? { enabled: false } : {}),
						updatedAt: new Date(now),
					})
					.where(eq(cloudflareAnalyticsState.orgId, orgId)),
			)

		const advanceWatermark = (rowIds: ReadonlyArray<string>, watermarkMs: number, now: number) =>
			rowIds.length === 0
				? Effect.void
				: dbExecute((db) =>
						db
							.update(cloudflareAnalyticsState)
							.set({
								watermarkAt: new Date(watermarkMs),
								lastSuccessAt: new Date(now),
								lastError: null,
								lastErrorAt: null,
								updatedAt: new Date(now),
							})
							.where(
								sql`${cloudflareAnalyticsState.id} in (${sql.join(
									rowIds.map((id) => sql`${id}`),
									sql`, `,
								)})`,
							),
					)

		/**
		 * Ensure the account-scoped workers row exists — it anchors the org lease and gives scope
		 * errors somewhere to land even before zone discovery has ever succeeded.
		 */
		const ensureWorkersRow = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db
					.insert(cloudflareAnalyticsState)
					.values({
						id: randomUUID(),
						orgId,
						dataset: WORKERS_DATASET,
						zoneId: "",
						createdAt: new Date(now),
						updatedAt: new Date(now),
					})
					.onConflictDoNothing(),
			)

		/** Claim the org's tick lease via the workers anchor row; false → another tick owns it. */
		const claimLease = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db
					.update(cloudflareAnalyticsState)
					.set({ leaseUntil: new Date(now + LEASE_MS), updatedAt: new Date(now) })
					.where(
						and(
							eq(cloudflareAnalyticsState.orgId, orgId),
							eq(cloudflareAnalyticsState.dataset, WORKERS_DATASET),
							eq(cloudflareAnalyticsState.zoneId, ""),
							or(
								isNull(cloudflareAnalyticsState.leaseUntil),
								lt(cloudflareAnalyticsState.leaseUntil, new Date(now)),
							),
						),
					)
					.returning({ id: cloudflareAnalyticsState.id }),
			).pipe(Effect.map((rows) => rows.length > 0))

		const releaseLease = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db
					.update(cloudflareAnalyticsState)
					.set({ leaseUntil: null, updatedAt: new Date(now) })
					.where(
						and(
							eq(cloudflareAnalyticsState.orgId, orgId),
							eq(cloudflareAnalyticsState.dataset, WORKERS_DATASET),
							eq(cloudflareAnalyticsState.zoneId, ""),
						),
					),
			)

		/** Reconcile discovered zones against http_requests state rows. */
		const reconcileZones = (orgId: OrgId, zones: ReadonlyArray<CloudflareZone>, now: number) =>
			Effect.gen(function* () {
				const rows = yield* loadStateRows(orgId)
				const httpRows = rows.filter((row) => row.dataset === HTTP_DATASET)
				const byZoneId = new Map(httpRows.map((row) => [row.zoneId, row]))
				const seen = new Set<string>()

				for (const zone of zones) {
					seen.add(zone.id)
					const existing = byZoneId.get(zone.id)
					if (!existing) {
						yield* dbExecute((db) =>
							db
								.insert(cloudflareAnalyticsState)
								.values({
									id: randomUUID(),
									orgId,
									dataset: HTTP_DATASET,
									zoneId: zone.id,
									zoneName: zone.name,
									createdAt: new Date(now),
									updatedAt: new Date(now),
								})
								.onConflictDoNothing(),
						)
					} else if (existing.zoneName !== zone.name || !existing.enabled) {
						// Re-enable on reappearance; a dataset-level disable re-asserts itself on the
						// next settings check, so this errs on the side of collecting again.
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({ zoneName: zone.name, enabled: true, updatedAt: new Date(now) })
								.where(eq(cloudflareAnalyticsState.id, existing.id)),
						)
					}
				}

				const vanished = httpRows.filter((row) => row.enabled && !seen.has(row.zoneId))
				for (const row of vanished) {
					yield* dbExecute((db) =>
						db
							.update(cloudflareAnalyticsState)
							.set({
								enabled: false,
								lastError: "Zone no longer present on the Cloudflare account",
								lastErrorAt: new Date(now),
								updatedAt: new Date(now),
							})
							.where(eq(cloudflareAnalyticsState.id, row.id)),
					)
				}
			})

		// ------------------------------------------------------------------
		// Settings refresh (per-plan limits discovery)
		// ------------------------------------------------------------------

		const refreshSettings = (
			accessToken: string,
			accountId: string,
			rows: ReadonlyArray<CloudflareAnalyticsStateRow>,
			now: number,
			budget: { calls: number },
		) =>
			Effect.gen(function* () {
				const stale = rows.filter(
					(row) =>
						row.enabled &&
						(row.settingsFetchedAt == null || now - row.settingsFetchedAt.getTime() > SETTINGS_TTL_MS),
				)
				if (stale.length === 0) return

				const staleHttp = stale.filter((row) => row.dataset === HTTP_DATASET)
				const staleWorkers = stale.filter((row) => row.dataset === WORKERS_DATASET)
				const zoneChunks = chunk(staleHttp, MAX_ZONES_PER_QUERY)

				// The account (workers) settings ride along with the first zone chunk; with no zones
				// we still need one account-only call for the workers row.
				const plans: Array<{ zones: CloudflareAnalyticsStateRow[]; includeAccount: boolean }> =
					zoneChunks.length > 0
						? zoneChunks.map((zones, index) => ({ zones, includeAccount: index === 0 && staleWorkers.length > 0 }))
						: staleWorkers.length > 0
							? [{ zones: [], includeAccount: true }]
							: []

				for (const plan of plans) {
					if (budget.calls >= MAX_CALLS_PER_ORG_TICK) return
					budget.calls += 1
					const result = yield* graphqlQuery(
						accessToken,
						{
							query: settingsQuery({ withZones: plan.zones.length > 0 }),
							variables: {
								accountTag: accountId,
								...(plan.zones.length > 0 ? { zoneTags: plan.zones.map((row) => row.zoneId) } : {}),
							},
						},
						apiBaseUrl,
					).pipe(
						Effect.catch((error) =>
							Effect.logWarning("cloudflare-analytics settings query failed", { error: error.message }).pipe(
								Effect.as(null as CloudflareGraphqlResult | null),
							),
						),
					)
					if (result == null || result.errors.length > 0) continue

					const decoded = yield* decodeSettingsResponse(result.data).pipe(
						Effect.catch(() => Effect.succeed(null)),
					)
					if (decoded == null) continue

					const zoneSettings = new Map(
						(decoded.viewer.zones ?? []).map((zone) => [
							zone.zoneTag,
							zone.settings?.httpRequestsAdaptiveGroups ?? null,
						]),
					)
					for (const row of plan.zones) {
						const settings = zoneSettings.get(row.zoneId)
						if (settings === undefined) continue
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({
									settingsJson: settings == null ? null : JSON.stringify(settings),
									settingsFetchedAt: new Date(now),
									quantilesAvailable: quantilesFromAvailableFields(settings, "edgetimetofirstbytems"),
									...(settings?.enabled === false ? { enabled: false } : {}),
									updatedAt: new Date(now),
								})
								.where(eq(cloudflareAnalyticsState.id, row.id)),
						)
					}

					if (plan.includeAccount) {
						const accountSettings = decoded.viewer.accounts?.[0]?.settings?.workersInvocationsAdaptive ?? null
						for (const row of staleWorkers) {
							yield* dbExecute((db) =>
								db
									.update(cloudflareAnalyticsState)
									.set({
										settingsJson: accountSettings == null ? null : JSON.stringify(accountSettings),
										settingsFetchedAt: new Date(now),
										quantilesAvailable: quantilesFromAvailableFields(accountSettings, "cputime"),
										...(accountSettings?.enabled === false ? { enabled: false } : {}),
										updatedAt: new Date(now),
									})
									.where(eq(cloudflareAnalyticsState.id, row.id)),
							)
						}
					}
				}
			})

		// ------------------------------------------------------------------
		// Window math
		// ------------------------------------------------------------------

		const pollWindow = (row: CloudflareAnalyticsStateRow, now: number): { start: number; end: number } | null => {
			const settings = parseStoredSettings(row.settingsJson)
			const effectiveEnd = floorToBucket(now - SAFETY_LAG_MS)
			const retentionFloor =
				settings.notOlderThanMs != null ? floorToBucket(now - settings.notOlderThanMs) + BUCKET_MS : null
			const backfillStart = floorToBucket(now - SAFETY_LAG_MS - BACKFILL_MS)
			const watermarkMs = row.watermarkAt == null ? null : dateToMs(row.watermarkAt)

			let start = watermarkMs ?? backfillStart
			if (retentionFloor != null && start < retentionFloor) start = retentionFloor
			start = floorToBucket(start)

			const maxWindow = Math.min(MAX_WINDOW_MS, settings.maxDurationMs ?? MAX_WINDOW_MS)
			const end = Math.min(start + maxWindow, effectiveEnd)
			if (end <= start) return null
			return { start, end }
		}

		// ------------------------------------------------------------------
		// Ingest
		// ------------------------------------------------------------------

		const ingestRows = (orgId: OrgId, rows: CloudflareMetricRows) =>
			Effect.gen(function* () {
				const tenant = systemTenant(orgId)
				const ingestAll = (datasource: "metrics_sum" | "metrics_gauge", batch: ReadonlyArray<MetricSumRow | MetricGaugeRow>) =>
					Effect.forEach(chunk(batch, INGEST_CHUNK), (part) => warehouse.ingest(tenant, datasource, part), {
						concurrency: 1,
						discard: true,
					})
				yield* ingestAll("metrics_sum", rows.sumRows)
				yield* ingestAll("metrics_gauge", rows.gaugeRows)
				return rows.sumRows.length + rows.gaugeRows.length
			})

		// ------------------------------------------------------------------
		// HTTP dataset polling
		// ------------------------------------------------------------------

		const pollHttpChunk = (
			orgId: OrgId,
			accessToken: string,
			zoneRows: ReadonlyArray<CloudflareAnalyticsStateRow>,
			window: { start: number; end: number },
			withQuantiles: boolean,
			now: number,
		) =>
			Effect.gen(function* () {
				const result = yield* graphqlQuery(
					accessToken,
					{
						query: httpAnalyticsQuery({ withQuantiles }),
						variables: {
							zoneTags: zoneRows.map((row) => row.zoneId),
							start: toGraphqlTime(window.start),
							end: toGraphqlTime(window.end),
						},
					},
					apiBaseUrl,
				)

				if (result.errors.length > 0) {
					const kind = classifyGraphqlErrors(result.errors)
					const message = graphqlErrorMessage(result.errors)
					const rowIds = zoneRows.map((row) => row.id)
					if (kind === "quantiles-unavailable") {
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({ quantilesAvailable: false, updatedAt: new Date(now) })
								.where(
									sql`${cloudflareAnalyticsState.id} in (${sql.join(
										rowIds.map((id) => sql`${id}`),
										sql`, `,
									)})`,
								),
						)
						// The next round rebuilds the document without the quantile fields — retry.
						return { ingested: 0, advanced: true }
					}
					if (kind === "disabled") {
						yield* recordError(rowIds, message, now)
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({ enabled: false, updatedAt: new Date(now) })
								.where(
									sql`${cloudflareAnalyticsState.id} in (${sql.join(
										rowIds.map((id) => sql`${id}`),
										sql`, `,
									)})`,
								),
						)
					} else {
						yield* recordError(rowIds, message, now)
					}
					return { ingested: 0, advanced: false }
				}

				const decoded = yield* decodeHttpAnalyticsResponse(result.data).pipe(
					Effect.mapError(() =>
						new IntegrationsPersistenceError({
							message: "Cloudflare GraphQL HTTP analytics response had an unexpected shape",
						}),
					),
				)

				const zoneResults = new Map((decoded.viewer.zones ?? []).map((zone) => [zone.zoneTag, zone]))
				const combined: CloudflareMetricRows = { sumRows: [], gaugeRows: [] }
				for (const row of zoneRows) {
					const zoneResult = zoneResults.get(row.zoneId)
					if (!zoneResult) continue
					const mapped = mapHttpGroups({
						orgId,
						zoneId: row.zoneId,
						zoneName: row.zoneName ?? row.zoneId,
						groups: zoneResult.groups,
						latency: zoneResult.latency,
					})
					combined.sumRows.push(...mapped.sumRows)
					combined.gaugeRows.push(...mapped.gaugeRows)
				}

				const ingested = yield* ingestRows(orgId, combined).pipe(
					Effect.mapError((error) =>
						new IntegrationsPersistenceError({
							message: `Cloudflare analytics ingest failed: ${error.message}`,
						}),
					),
				)
				// Watermark only advances after the ingest above succeeded — exactly-once by construction.
				yield* advanceWatermark(
					zoneRows.map((row) => row.id),
					window.end,
					now,
				)
				return { ingested, advanced: true }
			})

		const pollWorkers = (
			orgId: OrgId,
			accessToken: string,
			accountId: string,
			row: CloudflareAnalyticsStateRow,
			window: { start: number; end: number },
			now: number,
		) =>
			Effect.gen(function* () {
				const result = yield* graphqlQuery(
					accessToken,
					{
						query: workersAnalyticsQuery({ withQuantiles: row.quantilesAvailable }),
						variables: {
							accountTag: accountId,
							start: toGraphqlTime(window.start),
							end: toGraphqlTime(window.end),
						},
					},
					apiBaseUrl,
				)

				if (result.errors.length > 0) {
					const kind = classifyGraphqlErrors(result.errors)
					const message = graphqlErrorMessage(result.errors)
					if (kind === "quantiles-unavailable") {
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({ quantilesAvailable: false, updatedAt: new Date(now) })
								.where(eq(cloudflareAnalyticsState.id, row.id)),
						)
						return { ingested: 0, advanced: true }
					}
					if (kind === "disabled") {
						yield* recordError([row.id], message, now)
						yield* dbExecute((db) =>
							db
								.update(cloudflareAnalyticsState)
								.set({ enabled: false, updatedAt: new Date(now) })
								.where(eq(cloudflareAnalyticsState.id, row.id)),
						)
					} else {
						yield* recordError([row.id], message, now)
					}
					return { ingested: 0, advanced: false }
				}

				const decoded = yield* decodeWorkersAnalyticsResponse(result.data).pipe(
					Effect.mapError(() =>
						new IntegrationsPersistenceError({
							message: "Cloudflare GraphQL workers analytics response had an unexpected shape",
						}),
					),
				)
				const groups = decoded.viewer.accounts?.[0]?.invocations ?? []
				const mapped = mapWorkersGroups({ orgId, accountId, groups })
				const ingested = yield* ingestRows(orgId, mapped).pipe(
					Effect.mapError((error) =>
						new IntegrationsPersistenceError({
							message: `Cloudflare analytics ingest failed: ${error.message}`,
						}),
					),
				)
				yield* advanceWatermark([row.id], window.end, now)
				return { ingested, advanced: true }
			})

		// ------------------------------------------------------------------
		// Per-org poll
		// ------------------------------------------------------------------

		const pollOrg = Effect.fn("CloudflareAnalyticsService.pollOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const skip = (reason: string): PollOrgSummary => ({ orgId, skipped: reason, callsMade: 0, rowsIngested: 0 })

			const status = yield* oauth.getStatus(orgId)
			if (!status.connected) return skip("not connected")

			const now = yield* Clock.currentTimeMillis
			yield* ensureWorkersRow(orgId, now)
			const claimed = yield* claimLease(orgId, now)
			if (!claimed) return skip("lease held by another tick")

			const summary = yield* Effect.gen(function* () {
				if (!hasAnalyticsScopes(status.scope)) {
					yield* recordOrgError(orgId, MISSING_SCOPES_ERROR, now)
					return skip("missing analytics scopes")
				}

				// Token + zone discovery. Revocation disables all rows until reconnect; transient
				// upstream failures record and retry next tick.
				const tokenResult = yield* Effect.result(oauth.getValidAccessToken(orgId))
				if (Result.isFailure(tokenResult)) {
					const error = tokenResult.failure
					if (error instanceof IntegrationsRevokedError) {
						yield* recordOrgError(orgId, error.message, now, { disable: true })
					} else if (!(error instanceof IntegrationsNotConnectedError)) {
						yield* recordOrgError(orgId, error.message, now)
					}
					return skip(`token unavailable: ${error._tag}`)
				}
				const { accessToken, accountId } = tokenResult.success

				const budget = { calls: 0 }

				const zonesResult = yield* Effect.result(listZones(accessToken, accountId, apiBaseUrl))
				if (Result.isFailure(zonesResult)) {
					const error = zonesResult.failure
					if (error instanceof IntegrationsRevokedError) {
						yield* recordOrgError(orgId, error.message, now, { disable: true })
					} else {
						yield* recordOrgError(orgId, error.message, now)
					}
					return skip(`zone discovery failed: ${error._tag}`)
				}
				yield* reconcileZones(orgId, zonesResult.success, now)

				let rows = yield* loadStateRows(orgId)
				yield* refreshSettings(accessToken, accountId, rows, now, budget)
				rows = yield* loadStateRows(orgId)

				let rowsIngested = 0

				// Round-based catch-up: every round advances each behind zone/dataset by one window;
				// loop until caught up or the call budget is spent (backfill resumes next tick).
				let progressed = true
				// Set when Cloudflare rejects the token mid-loop — every further call would 401 too.
				let revoked = false
				while (progressed && !revoked && budget.calls < MAX_CALLS_PER_ORG_TICK) {
					progressed = false

					const httpRows = rows.filter((row) => row.dataset === HTTP_DATASET && row.enabled)
					const withWindows = httpRows
						.map((row) => ({ row, window: pollWindow(row, now) }))
						.filter((entry): entry is { row: CloudflareAnalyticsStateRow; window: { start: number; end: number } } =>
							entry.window != null,
						)

					// Zones sharing an identical window (the steady state) batch into 10-zone calls;
					// quantile availability also splits the batch since it changes the document.
					const groups = new Map<string, { rows: CloudflareAnalyticsStateRow[]; window: { start: number; end: number }; withQuantiles: boolean }>()
					for (const entry of withWindows) {
						const key = `${entry.window.start}:${entry.window.end}:${entry.row.quantilesAvailable}`
						const group = groups.get(key)
						if (group) group.rows.push(entry.row)
						else
							groups.set(key, {
								rows: [entry.row],
								window: entry.window,
								withQuantiles: entry.row.quantilesAvailable,
							})
					}

					const noProgress = { ingested: 0, advanced: false }

					for (const group of groups.values()) {
						for (const zoneChunk of chunk(group.rows, MAX_ZONES_PER_QUERY)) {
							if (budget.calls >= MAX_CALLS_PER_ORG_TICK || revoked) break
							budget.calls += 1
							const outcome = yield* pollHttpChunk(
								orgId,
								accessToken,
								zoneChunk,
								group.window,
								group.withQuantiles,
								now,
							).pipe(
								Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
									Effect.sync(() => {
										revoked = true
									}).pipe(
										Effect.andThen(recordOrgError(orgId, error.message, now, { disable: true })),
										Effect.as(noProgress),
									),
								),
								Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
									recordError(
										zoneChunk.map((row) => row.id),
										error.message,
										now,
									).pipe(Effect.as(noProgress)),
								),
							)
							rowsIngested += outcome.ingested
							if (outcome.advanced) progressed = true
						}
					}

					const workersRow = rows.find((row) => row.dataset === WORKERS_DATASET && row.enabled)
					if (workersRow && budget.calls < MAX_CALLS_PER_ORG_TICK && !revoked) {
						const window = pollWindow(workersRow, now)
						if (window) {
							budget.calls += 1
							const outcome = yield* pollWorkers(orgId, accessToken, accountId, workersRow, window, now).pipe(
								Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
									Effect.sync(() => {
										revoked = true
									}).pipe(
										Effect.andThen(recordOrgError(orgId, error.message, now, { disable: true })),
										Effect.as(noProgress),
									),
								),
								Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
									recordError([workersRow.id], error.message, now).pipe(Effect.as(noProgress)),
								),
							)
							rowsIngested += outcome.ingested
							if (outcome.advanced) progressed = true
						}
					}

					if (progressed) {
						rows = yield* loadStateRows(orgId)
					}
				}

				yield* Effect.annotateCurrentSpan("cloudflare.calls", budget.calls)
				yield* Effect.annotateCurrentSpan("cloudflare.rowsIngested", rowsIngested)
				return { orgId, skipped: null, callsMade: budget.calls, rowsIngested } satisfies PollOrgSummary
			}).pipe(
				Effect.ensuring(
					Clock.currentTimeMillis.pipe(Effect.flatMap((end) => releaseLease(orgId, end).pipe(Effect.ignore))),
				),
			)

			return summary
		})

		// ------------------------------------------------------------------
		// All-orgs tick + status
		// ------------------------------------------------------------------

		const pollAllOrgs = Effect.fn("CloudflareAnalyticsService.pollAllOrgs")(function* () {
			const orgRows = yield* dbExecute((db) =>
				db
					.selectDistinct({ orgId: oauthConnections.orgId })
					.from(oauthConnections)
					.where(eq(oauthConnections.provider, "cloudflare")),
			)
			let rowsIngested = 0
			yield* Effect.forEach(
				orgRows,
				(row) =>
					pollOrg(row.orgId as OrgId).pipe(
						Effect.tap((summary) =>
							Effect.sync(() => {
								rowsIngested += summary.rowsIngested
							}),
						),
						Effect.catch((error) =>
							Effect.logWarning("cloudflare-analytics org poll failed", {
								orgId: row.orgId,
								error: error.message,
							}),
						),
					),
				{ concurrency: ORG_CONCURRENCY, discard: true },
			)
			return { orgs: orgRows.length, rowsIngested } satisfies PollAllOrgsSummary
		})

		const getStatus = Effect.fn("CloudflareAnalyticsService.getStatus")(function* (orgId: OrgId) {
			const rows = yield* loadStateRows(orgId)
			const zones = rows
				.filter((row) => row.dataset === HTTP_DATASET)
				.map((row) => ({
					id: row.zoneId,
					name: row.zoneName ?? row.zoneId,
					enabled: row.enabled,
					lastSyncedAt: row.lastSuccessAt == null ? null : dateToMs(row.lastSuccessAt),
					lastError: row.lastError,
				}))
				.sort((a, b) => a.name.localeCompare(b.name))
			const workersRow = rows.find((row) => row.dataset === WORKERS_DATASET)
			return {
				zones,
				workers: workersRow
					? {
							enabled: workersRow.enabled,
							lastSyncedAt: workersRow.lastSuccessAt == null ? null : dateToMs(workersRow.lastSuccessAt),
							lastError: workersRow.lastError,
						}
					: null,
			} satisfies CloudflareAnalyticsStatus
		})

		return { pollAllOrgs, pollOrg, getStatus } satisfies CloudflareAnalyticsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

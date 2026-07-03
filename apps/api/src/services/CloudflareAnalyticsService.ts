/**
 * Cloudflare edge-analytics collector.
 *
 * Polls the Cloudflare GraphQL Analytics API for every org with a connected Cloudflare account
 * and writes the results into the regular OTel metrics pipeline (`metrics_sum`/`metrics_gauge`
 * Tinybird datasources), so the metric explorer, dashboard builder, and alerting all work on
 * edge data with zero new query paths.
 *
 * Collected datasets are described by the {@link DATASETS} registry — one generic poll pipeline
 * drives them all:
 * - `http_requests` (zone-scoped `httpRequestsAdaptiveGroups`): request counts by cache status ×
 *   response-status class, bytes, visits, and zone-level TTFB / origin-duration percentiles per
 *   5-min bucket.
 * - `workers_invocations` (account-scoped `workersInvocationsAdaptive`): Worker requests/errors
 *   and CPU-time/duration percentiles per script.
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
	CloudflareAnalyticsWorkersStatus,
	CloudflareAnalyticsZoneStatus,
	CloudflareIntegrationStatus,
	CloudflareServiceUsage,
	CloudflareUsageBucket,
	CloudflareUsageResponse,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	OrgId,
	RoleName,
	UserId as UserIdSchema,
} from "@maple/domain/http"
import * as CH from "@maple/query-engine/ch"
import {
	cloudflareAnalyticsState,
	oauthConnections,
	type CloudflareAnalyticsStateInsert,
	type CloudflareAnalyticsStateRow,
} from "@maple/db"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Ref,
	Result,
	Schema,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { TenantContext } from "./AuthService"
import {
	graphqlQuery,
	listZones,
	type CloudflareGraphqlError,
	type CloudflareZone,
} from "../lib/CloudflareApi"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs } from "../lib/time"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import { mapHttpGroups, mapWorkersGroups, type CloudflareMetricRows } from "./cloudflare-analytics/mapping"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import {
	DatasetSettings,
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
	type SettingsResponseShape,
} from "./cloudflare-analytics/queries"

/**
 * OAuth scopes the poller needs (space-delimited ids in `oauth_connections.scope`). Kept next to
 * the service so the HTTP status route and the poll gating share one source of truth.
 *   - account-analytics.read → account-scoped datasets (workersInvocationsAdaptive)
 *   - analytics.read         → zone-scoped datasets (httpRequestsAdaptiveGroups) — WITHOUT this the
 *                              zone GraphQL query is rejected "not authorized" even though zones list
 *   - zone.read              → zone discovery (REST /zones); grants config read, NOT analytics
 * A connection missing any of these is treated as not analytics-capable so the UI prompts a
 * reconnect (existing tokens predating a scope addition won't carry it). Ids verified verbatim
 * against the live registry (GET /client/v4/oauth/scopes).
 */
const CLOUDFLARE_ANALYTICS_SCOPES = ["account-analytics.read", "analytics.read", "zone.read"] as const

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
/** Zone discovery (REST pagination) runs hourly; poll ticks in between reuse the state rows. */
const DISCOVERY_TTL_MS = 60 * 60_000
const ORG_CONCURRENCY = 3

const MISSING_SCOPES_ERROR =
	"Cloudflare connection lacks the analytics scopes — reconnect the integration to update permissions"

const floorToBucket = (ms: number) => ms - (ms % BUCKET_MS)

const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeOrgId = Schema.decodeUnknownSync(OrgId)

/** Synthetic actor stamped on rows the poller writes on the org's behalf (ingest keys, state). */
const SYSTEM_USER_ID = decodeUserIdSync("system-cloudflare-analytics")

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "Cloudflare analytics database error",
	})

/** Integrations-page usage window: last 24h in hourly buckets. */
const USAGE_WINDOW_MS = 24 * 60 * 60_000
const USAGE_BUCKET_SECONDS = 3600
const WORKER_SERVICE_PREFIX = "cloudflare-worker/"
const ZONE_SERVICE_PREFIX = "cloudflare/"

/** Epoch ms → warehouse DateTime64 literal (`YYYY-MM-DD HH:MM:SS.mmm`, UTC). */
const toWarehouseDateTime64 = (ms: number) => {
	const d = new Date(ms)
	const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

// ---------------------------------------------------------------------------
// Dataset registry — everything dataset-specific lives here; the poll pipeline is generic.
// ---------------------------------------------------------------------------

interface PollWindow {
	readonly start: number
	readonly end: number
}

interface DatasetPollTarget {
	readonly orgId: OrgId
	readonly accountId: string
	readonly rows: ReadonlyArray<CloudflareAnalyticsStateRow>
}

interface DatasetDef {
	readonly id: string
	readonly scope: "zone" | "account"
	/** Lowercased needles identifying this dataset's quantile fields in GraphQL error text. */
	readonly quantileNeedles: ReadonlyArray<string>
	/** Needle for the settings `availableFields` probe (see {@link quantilesFromAvailableFields}). */
	readonly availableFieldsNeedle: string
	readonly buildQuery: (options: {
		readonly rows: ReadonlyArray<CloudflareAnalyticsStateRow>
		readonly accountId: string
		readonly window: PollWindow
		readonly withQuantiles: boolean
	}) => { readonly query: string; readonly variables: Record<string, unknown> }
	/** Decode a poll response and map it to metric rows for the polled state rows. */
	readonly decodeRows: (
		data: unknown,
		target: DatasetPollTarget,
	) => Effect.Effect<CloudflareMetricRows, IntegrationsPersistenceError>
	/**
	 * Extract this dataset's settings node from a decoded settings response; `undefined` → the
	 * response carried nothing for this row (its cached settings stay untouched).
	 */
	readonly settingsNode: (
		decoded: SettingsResponseShape,
		row: CloudflareAnalyticsStateRow,
	) => DatasetSettingsShape | null | undefined
}

const httpDataset: DatasetDef = {
	id: HTTP_DATASET,
	scope: "zone",
	quantileNeedles: ["edgetimetofirstbytems", "quantiles"],
	availableFieldsNeedle: "edgetimetofirstbytems",
	buildQuery: ({ rows, window, withQuantiles }) => ({
		query: httpAnalyticsQuery({ withQuantiles }),
		variables: {
			zoneTags: rows.map((row) => row.zoneId),
			start: toGraphqlTime(window.start),
			end: toGraphqlTime(window.end),
		},
	}),
	decodeRows: (data, target) =>
		decodeHttpAnalyticsResponse(data).pipe(
			Effect.mapError(
				() =>
					new IntegrationsPersistenceError({
						message: "Cloudflare GraphQL HTTP analytics response had an unexpected shape",
					}),
			),
			Effect.map((decoded) => {
				const zoneResults = new Map((decoded.viewer.zones ?? []).map((zone) => [zone.zoneTag, zone]))
				const combined: CloudflareMetricRows = { sumRows: [], gaugeRows: [] }
				for (const row of target.rows) {
					const zoneResult = zoneResults.get(row.zoneId)
					if (!zoneResult) continue
					const mapped = mapHttpGroups({
						orgId: target.orgId,
						zoneId: row.zoneId,
						zoneName: row.zoneName ?? row.zoneId,
						groups: zoneResult.groups,
						latency: zoneResult.latency,
					})
					combined.sumRows.push(...mapped.sumRows)
					combined.gaugeRows.push(...mapped.gaugeRows)
				}
				return combined
			}),
		),
	settingsNode: (decoded, row) => {
		const zone = (decoded.viewer.zones ?? []).find((entry) => entry.zoneTag === row.zoneId)
		return zone === undefined ? undefined : (zone.settings?.httpRequestsAdaptiveGroups ?? null)
	},
}

const workersDataset: DatasetDef = {
	id: WORKERS_DATASET,
	scope: "account",
	quantileNeedles: ["cputime", "quantiles"],
	availableFieldsNeedle: "cputime",
	buildQuery: ({ accountId, window, withQuantiles }) => ({
		query: workersAnalyticsQuery({ withQuantiles }),
		variables: {
			accountTag: accountId,
			start: toGraphqlTime(window.start),
			end: toGraphqlTime(window.end),
		},
	}),
	decodeRows: (data, target) =>
		decodeWorkersAnalyticsResponse(data).pipe(
			Effect.mapError(
				() =>
					new IntegrationsPersistenceError({
						message: "Cloudflare GraphQL workers analytics response had an unexpected shape",
					}),
			),
			Effect.map((decoded) =>
				mapWorkersGroups({
					orgId: target.orgId,
					accountId: target.accountId,
					groups: decoded.viewer.accounts?.[0]?.invocations ?? [],
				}),
			),
		),
	settingsNode: (decoded) => decoded.viewer.accounts?.[0]?.settings?.workersInvocationsAdaptive ?? null,
}

const DATASETS: ReadonlyArray<DatasetDef> = [httpDataset, workersDataset]
const DATASET_BY_ID = new Map(DATASETS.map((dataset) => [dataset.id, dataset]))

// ---------------------------------------------------------------------------
// GraphQL error classification
// ---------------------------------------------------------------------------

/** Classify GraphQL-level errors (HTTP 200 + errors[]) into the poller's reaction. */
type GraphqlErrorKind = "authz" | "disabled" | "quantiles-unavailable" | "other"

const graphqlErrorCode = (error: CloudflareGraphqlError): string | null => {
	const extensions = error.extensions
	if (typeof extensions === "object" && extensions !== null && "code" in extensions) {
		const code = extensions.code
		if (typeof code === "string") return code
	}
	return null
}

const classifyGraphqlErrors = (
	errors: ReadonlyArray<CloudflareGraphqlError>,
	quantileNeedles: ReadonlyArray<string>,
): GraphqlErrorKind => {
	const messages = errors.map((error) => error.message.toLowerCase())
	// Plan lacks the dataset's timing-quantile fields → the query referenced an unknown field.
	// Degrade to counters-only instead of erroring forever.
	if (
		messages.some(
			(message) =>
				(message.includes("unknown") || message.includes("cannot query")) &&
				quantileNeedles.some((needle) => message.includes(needle)),
		)
	) {
		return "quantiles-unavailable"
	}
	// extensions.code carries Cloudflare's machine-readable classification ("authz" on permission
	// failures); the message substrings are only a fallback for errors that omit it.
	if (errors.some((error) => graphqlErrorCode(error) === "authz")) return "authz"
	if (
		messages.some(
			(message) =>
				message.includes("not authorized") ||
				message.includes("unauthorized") ||
				message.includes("access denied"),
		)
	) {
		return "authz"
	}
	if (messages.some((message) => message.includes("not enabled") || message.includes("disabled"))) {
		return "disabled"
	}
	return "other"
}

const graphqlErrorMessage = (errors: ReadonlyArray<CloudflareGraphqlError>): string =>
	errors
		.map((e) => e.message)
		.join("; ")
		.slice(0, 500)

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

interface ParsedSettings {
	readonly notOlderThanMs: number | null
	readonly maxDurationMs: number | null
}

const decodeStoredSettings = Schema.decodeUnknownOption(Schema.fromJsonString(DatasetSettings))

const parseStoredSettings = (settingsJson: string | null): ParsedSettings => {
	if (!settingsJson) return { notOlderThanMs: null, maxDurationMs: null }
	return Option.match(decodeStoredSettings(settingsJson), {
		onNone: () => ({ notOlderThanMs: null, maxDurationMs: null }),
		onSome: (parsed) => ({
			notOlderThanMs: typeof parsed.notOlderThan === "number" ? parsed.notOlderThan * 1000 : null,
			maxDurationMs: typeof parsed.maxDuration === "number" ? parsed.maxDuration * 1000 : null,
		}),
	})
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

const pollWindow = (row: CloudflareAnalyticsStateRow, now: number): PollWindow | null => {
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

// ---------------------------------------------------------------------------
// Round planning
// ---------------------------------------------------------------------------

interface WorkItem {
	readonly dataset: DatasetDef
	readonly rows: CloudflareAnalyticsStateRow[]
	readonly window: PollWindow
	readonly withQuantiles: boolean
}

/**
 * Plan one poll round: per dataset, rows sharing an identical window (the steady state) batch
 * into one GraphQL call; quantile availability also splits the batch since it changes the
 * document. Zone-scoped batches are capped at Cloudflare's 10-zones-per-query limit.
 */
const buildWorkItems = (rows: ReadonlyArray<CloudflareAnalyticsStateRow>, now: number): WorkItem[] => {
	const items: WorkItem[] = []
	for (const dataset of DATASETS) {
		const groups = new Map<
			string,
			{ rows: CloudflareAnalyticsStateRow[]; window: PollWindow; withQuantiles: boolean }
		>()
		for (const row of rows) {
			if (row.dataset !== dataset.id || !row.enabled) continue
			const window = pollWindow(row, now)
			if (window == null) continue
			const key = `${window.start}:${window.end}:${row.quantilesAvailable}`
			const group = groups.get(key)
			if (group) group.rows.push(row)
			else groups.set(key, { rows: [row], window, withQuantiles: row.quantilesAvailable })
		}
		const chunkSize = dataset.scope === "zone" ? MAX_ZONES_PER_QUERY : 1
		for (const group of groups.values()) {
			for (const chunkRows of Arr.chunksOf(group.rows, chunkSize)) {
				items.push({
					dataset,
					rows: chunkRows,
					window: group.window,
					withQuantiles: group.withQuantiles,
				})
			}
		}
	}
	return items
}

type PollOutcome =
	| { readonly kind: "advanced"; readonly ingested: number }
	| { readonly kind: "quantiles-downgraded" }
	| { readonly kind: "disabled" }
	| { readonly kind: "failed" }

const FAILED_OUTCOME: PollOutcome = { kind: "failed" }

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CloudflareAnalyticsZoneStatusShape {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly lastSyncedAt: number | null
	readonly lastError: string | null
	readonly watermarkAt: number | null
}

interface CloudflareAnalyticsStatus {
	readonly zones: ReadonlyArray<CloudflareAnalyticsZoneStatusShape>
	readonly workers: {
		readonly enabled: boolean
		readonly lastSyncedAt: number | null
		readonly lastError: string | null
		readonly watermarkAt: number | null
	} | null
}

interface PollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly callsMade: number
	readonly rowsIngested: number
}

interface PollAllOrgsSummary {
	readonly orgs: number
	readonly rowsIngested: number
}

export interface CloudflareAnalyticsServiceShape {
	readonly pollAllOrgs: () => Effect.Effect<PollAllOrgsSummary, IntegrationsPersistenceError>
	readonly pollOrg: (orgId: OrgId) => Effect.Effect<PollOrgSummary, IntegrationsPersistenceError>
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<CloudflareAnalyticsStatus, IntegrationsPersistenceError>
	readonly getIntegrationStatus: (
		orgId: OrgId,
	) => Effect.Effect<CloudflareIntegrationStatus, IntegrationsPersistenceError>
	readonly getUsage: (orgId: OrgId) => Effect.Effect<CloudflareUsageResponse, IntegrationsPersistenceError>
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
		const ingestKeys = yield* OrgIngestKeysService

		const apiBaseUrl = env.MAPLE_CLOUDFLARE_API_BASE_URL
		/** The ingest gateway's OTLP metrics endpoint — poller metrics flow through it like all telemetry. */
		const ingestMetricsUrl = `${env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")}/v1/metrics`

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: SYSTEM_USER_ID,
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

		/** One IN-list UPDATE over the given state rows; no-op on an empty id list. */
		const updateRows = (rowIds: ReadonlyArray<string>, set: Partial<CloudflareAnalyticsStateInsert>) =>
			rowIds.length === 0
				? Effect.void
				: dbExecute((db) =>
						db
							.update(cloudflareAnalyticsState)
							.set(set)
							.where(inArray(cloudflareAnalyticsState.id, [...rowIds])),
					)

		const recordError = (
			rowIds: ReadonlyArray<string>,
			message: string,
			now: number,
			options?: { disable?: boolean },
		) =>
			updateRows(rowIds, {
				lastError: message.slice(0, 500),
				lastErrorAt: new Date(now),
				...(options?.disable ? { enabled: false } : {}),
				updatedAt: new Date(now),
			})

		const recordOrgError = (
			orgId: OrgId,
			message: string,
			now: number,
			options?: { disable?: boolean },
		) =>
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
			updateRows(rowIds, {
				watermarkAt: new Date(watermarkMs),
				lastSuccessAt: new Date(now),
				lastError: null,
				lastErrorAt: null,
				updatedAt: new Date(now),
			})

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

		/**
		 * Claim the org's tick lease via the workers anchor row. Returns the claimed anchor (it
		 * carries the zone-discovery timestamp) or null — no anchor yet, or another tick owns it.
		 */
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
					.returning(),
			).pipe(Effect.map((rows) => rows[0] ?? null))

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

		/**
		 * Reconcile discovered zones against http_requests state rows and stamp the discovery time
		 * on the anchor row. Returns the org's resulting row set so the caller skips a re-SELECT.
		 */
		const reconcileZones = Effect.fn("CloudflareAnalyticsService.reconcileZones")(function* (
			orgId: OrgId,
			zones: ReadonlyArray<CloudflareZone>,
			anchorId: string,
			now: number,
		) {
			const rows = yield* loadStateRows(orgId)
			const byZoneId = new Map(
				rows.filter((row) => row.dataset === HTTP_DATASET).map((row) => [row.zoneId, row]),
			)

			const newZones = zones.filter((zone) => !byZoneId.has(zone.id))
			const inserted =
				newZones.length === 0
					? []
					: yield* dbExecute((db) =>
							db
								.insert(cloudflareAnalyticsState)
								.values(
									newZones.map((zone) => ({
										id: randomUUID(),
										orgId,
										dataset: HTTP_DATASET,
										zoneId: zone.id,
										zoneName: zone.name,
										createdAt: new Date(now),
										updatedAt: new Date(now),
									})),
								)
								.onConflictDoNothing()
								.returning(),
						)

			for (const zone of zones) {
				const existing = byZoneId.get(zone.id)
				if (!existing || (existing.zoneName === zone.name && existing.enabled)) continue
				// Re-enable on reappearance; a dataset-level disable re-asserts itself on the
				// next settings check, so this errs on the side of collecting again.
				yield* updateRows([existing.id], {
					zoneName: zone.name,
					enabled: true,
					updatedAt: new Date(now),
				})
				existing.zoneName = zone.name
				existing.enabled = true
			}

			const seen = new Set(zones.map((zone) => zone.id))
			const vanished = rows.filter(
				(row) => row.dataset === HTTP_DATASET && row.enabled && !seen.has(row.zoneId),
			)
			yield* updateRows(
				vanished.map((row) => row.id),
				{
					enabled: false,
					lastError: "Zone no longer present on the Cloudflare account",
					lastErrorAt: new Date(now),
					updatedAt: new Date(now),
				},
			)
			for (const row of vanished) row.enabled = false

			yield* updateRows([anchorId], { discoveredAt: new Date(now), updatedAt: new Date(now) })

			return [...rows, ...inserted]
		})

		// ------------------------------------------------------------------
		// Settings refresh (per-plan limits discovery)
		// ------------------------------------------------------------------

		/**
		 * Refresh stale per-plan dataset settings. Returns true when anything was written — the
		 * caller then reloads its row set (and skips the reload otherwise).
		 */
		const refreshSettings = Effect.fn("CloudflareAnalyticsService.refreshSettings")(function* (
			accessToken: string,
			accountId: string,
			rows: ReadonlyArray<CloudflareAnalyticsStateRow>,
			now: number,
			budget: { calls: number },
		) {
			let wrote = false
			const stale = rows.filter(
				(row) =>
					row.enabled &&
					(row.settingsFetchedAt == null ||
						now - row.settingsFetchedAt.getTime() > SETTINGS_TTL_MS),
			)
			if (stale.length === 0) return wrote

			const staleHttp = stale.filter((row) => row.dataset === HTTP_DATASET)
			const staleWorkers = stale.filter((row) => row.dataset === WORKERS_DATASET)
			const zoneChunks = Arr.chunksOf(staleHttp, MAX_ZONES_PER_QUERY)

			// The account (workers) settings ride along with the first zone chunk; with no zones
			// we still need one account-only call for the workers row.
			const plans: Array<{
				zones: ReadonlyArray<CloudflareAnalyticsStateRow>
				includeAccount: boolean
			}> =
				zoneChunks.length > 0
					? zoneChunks.map((zones, index) => ({
							zones,
							includeAccount: index === 0 && staleWorkers.length > 0,
						}))
					: staleWorkers.length > 0
						? [{ zones: [], includeAccount: true }]
						: []

			for (const plan of plans) {
				if (budget.calls >= MAX_CALLS_PER_ORG_TICK) return wrote
				budget.calls += 1
				const result = yield* graphqlQuery(
					accessToken,
					{
						query: settingsQuery({ withZones: plan.zones.length > 0 }),
						variables: {
							accountTag: accountId,
							...(plan.zones.length > 0
								? { zoneTags: plan.zones.map((row) => row.zoneId) }
								: {}),
						},
					},
					apiBaseUrl,
				).pipe(
					// Token died mid-refresh: stop burning settings calls — every further one
					// would 401 too. The poll loop records the revoke on its first chunk.
					Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
						Effect.logWarning("cloudflare-analytics settings query failed", {
							errorTag: error._tag,
							error: error.message,
						}).pipe(Effect.as("revoked" as const)),
					),
					Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
						Effect.logWarning("cloudflare-analytics settings query failed", {
							errorTag: error._tag,
							error: error.message,
						}).pipe(Effect.as(null)),
					),
				)
				if (result === "revoked") return wrote
				if (result == null || result.errors.length > 0) continue

				const decoded = yield* decodeSettingsResponse(result.data).pipe(
					Effect.catch((error) =>
						Effect.logWarning("cloudflare-analytics settings response decode failed", {
							error: String(error),
						}).pipe(Effect.as(null)),
					),
				)
				if (decoded == null) continue

				// Group rows by their resulting update payload — zones on the same Cloudflare
				// plan (the common case) collapse into one UPDATE.
				const updates = new Map<
					string,
					{ ids: string[]; set: Partial<CloudflareAnalyticsStateInsert> }
				>()
				for (const row of [...plan.zones, ...(plan.includeAccount ? staleWorkers : [])]) {
					const dataset = DATASET_BY_ID.get(row.dataset)
					if (!dataset) continue
					const settings = dataset.settingsNode(decoded, row)
					if (settings === undefined) continue
					const set: Partial<CloudflareAnalyticsStateInsert> = {
						settingsJson: settings == null ? null : JSON.stringify(settings),
						settingsFetchedAt: new Date(now),
						quantilesAvailable: quantilesFromAvailableFields(
							settings,
							dataset.availableFieldsNeedle,
						),
						...(settings?.enabled === false ? { enabled: false } : {}),
						updatedAt: new Date(now),
					}
					const key = `${set.settingsJson}|${set.quantilesAvailable}|${set.enabled ?? ""}`
					const group = updates.get(key)
					if (group) group.ids.push(row.id)
					else updates.set(key, { ids: [row.id], set })
				}
				for (const group of updates.values()) {
					yield* updateRows(group.ids, group.set)
					wrote = true
				}
			}
			return wrote
		})

		// ------------------------------------------------------------------
		// Ingest — via the gateway, so per-org routing (managed Tinybird vs BYO
		// ClickHouse), schema-version gating, WAL durability, and Autumn metering
		// all apply exactly as they do for the org's own telemetry.
		// ------------------------------------------------------------------

		/**
		 * The org's public ingest key (`maple_pk_*`), minted on first use. The gateway resolves the
		 * owning org from it and routes accordingly — that key is the only org attribution needed.
		 */
		const getOrgIngestKey = (orgId: OrgId) =>
			ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID).pipe(Effect.map((keys) => keys.publicKey))

		/**
		 * Ship a chunk's metric rows to the ingest gateway as one OTLP/JSON request. Non-2xx and
		 * transport failures surface as {@link IntegrationsUpstreamError} so the poll loop records
		 * them and retries next tick (the watermark only advances on success). Returns the row count.
		 */
		const emitMetrics = Effect.fn("CloudflareAnalyticsService.emitMetrics")(
			function* (ingestKey: string, rows: CloudflareMetricRows) {
				const total = rows.sumRows.length + rows.gaugeRows.length
				if (total === 0) return 0
				const payload = metricRowsToOtlp(rows.sumRows, rows.gaugeRows)
				const client = yield* HttpClient.HttpClient
				const request = HttpClientRequest.post(ingestMetricsUrl, {
					headers: { authorization: `Bearer ${ingestKey}`, "content-type": "application/json" },
				}).pipe(HttpClientRequest.bodyJsonUnsafe(payload))
				const response = yield* client.execute(request)
				if (response.status >= 300) {
					const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
					return yield* Effect.fail(
						new IntegrationsUpstreamError({
							message: `Cloudflare metrics ingest returned ${response.status}: ${body.slice(0, 300)}`,
							status: response.status,
						}),
					)
				}
				return total
			},
			(effect) =>
				effect.pipe(
					Effect.provide(FetchHttpClient.layer),
					Effect.mapError((error) =>
						error instanceof IntegrationsUpstreamError
							? error
							: new IntegrationsUpstreamError({
									message: `Cloudflare metrics ingest request failed: ${error instanceof Error ? error.message : String(error)}`,
									cause: error,
								}),
					),
				),
		)

		// ------------------------------------------------------------------
		// Generic dataset polling
		// ------------------------------------------------------------------

		/**
		 * One poll step: query a dataset chunk's window, classify GraphQL-level errors (quantile
		 * downgrade / dataset disabled / other), decode, map, ingest, advance the watermark.
		 */
		const pollDatasetChunk = Effect.fn("CloudflareAnalyticsService.pollDatasetChunk")(function* (
			item: WorkItem,
			context: {
				readonly orgId: OrgId
				readonly accountId: string
				readonly accessToken: string
				readonly ingestKey: string
			},
			now: number,
		) {
			const rowIds = item.rows.map((row) => row.id)
			const result = yield* graphqlQuery(
				context.accessToken,
				item.dataset.buildQuery({
					rows: item.rows,
					accountId: context.accountId,
					window: item.window,
					withQuantiles: item.withQuantiles,
				}),
				apiBaseUrl,
			)

			if (result.errors.length > 0) {
				const kind = classifyGraphqlErrors(result.errors, item.dataset.quantileNeedles)
				if (kind === "quantiles-unavailable") {
					yield* updateRows(rowIds, { quantilesAvailable: false, updatedAt: new Date(now) })
					// The next round rebuilds the document without the quantile fields — retry.
					return { kind: "quantiles-downgraded" } as const satisfies PollOutcome
				}
				yield* recordError(rowIds, graphqlErrorMessage(result.errors), now, {
					disable: kind === "disabled",
				})
				if (kind === "disabled") return { kind: "disabled" } as const satisfies PollOutcome
				return FAILED_OUTCOME
			}

			const mapped = yield* item.dataset.decodeRows(result.data, {
				orgId: context.orgId,
				accountId: context.accountId,
				rows: item.rows,
			})
			const ingested = yield* emitMetrics(context.ingestKey, mapped)
			// Watermark only advances after the gateway accepted the batch above.
			yield* advanceWatermark(rowIds, item.window.end, now)
			return { kind: "advanced", ingested } as const satisfies PollOutcome
		})

		// ------------------------------------------------------------------
		// Per-org poll
		// ------------------------------------------------------------------

		const pollOrg = Effect.fn("CloudflareAnalyticsService.pollOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const skip = (reason: string): PollOrgSummary => ({
				orgId,
				skipped: reason,
				callsMade: 0,
				rowsIngested: 0,
			})

			const now = yield* Clock.currentTimeMillis

			// One connection read resolves connected-ness, capability (scope), and a fresh token.
			const tokenResult = yield* Effect.result(oauth.getValidAccessToken(orgId))
			if (
				Result.isFailure(tokenResult) &&
				tokenResult.failure instanceof IntegrationsNotConnectedError
			) {
				return skip("not connected")
			}

			// Claim the tick lease; the anchor row is created lazily the first time an org is polled.
			let claimed = yield* claimLease(orgId, now)
			if (claimed == null) {
				yield* ensureWorkersRow(orgId, now)
				claimed = yield* claimLease(orgId, now)
			}
			if (claimed == null) return skip("lease held by another tick")
			const anchor = claimed

			return yield* Effect.gen(function* () {
				// Token failures: revocation disables all rows until reconnect; transient upstream
				// failures record and retry next tick.
				if (Result.isFailure(tokenResult)) {
					const error = tokenResult.failure
					yield* recordOrgError(orgId, error.message, now, {
						disable: error instanceof IntegrationsRevokedError,
					})
					return skip(`token unavailable: ${error._tag}`)
				}
				const { accessToken, accountId, scope } = tokenResult.success

				if (!hasAnalyticsScopes(scope)) {
					yield* recordOrgError(orgId, MISSING_SCOPES_ERROR, now)
					return skip("missing analytics scopes")
				}

				// Zone discovery (REST pagination) is hourly-TTL'd on the anchor row; ticks in
				// between reuse the reconciled state rows.
				let rows: CloudflareAnalyticsStateRow[]
				if (anchor.discoveredAt == null || now - anchor.discoveredAt.getTime() > DISCOVERY_TTL_MS) {
					const zonesResult = yield* Effect.result(listZones(accessToken, accountId, apiBaseUrl))
					if (Result.isFailure(zonesResult)) {
						const error = zonesResult.failure
						yield* recordOrgError(orgId, error.message, now, {
							disable: error instanceof IntegrationsRevokedError,
						})
						return skip(`zone discovery failed: ${error._tag}`)
					}
					rows = yield* reconcileZones(orgId, zonesResult.success, anchor.id, now)
				} else {
					rows = yield* loadStateRows(orgId)
				}

				const budget = { calls: 0 }
				const settingsWrote = yield* refreshSettings(accessToken, accountId, rows, now, budget)
				if (settingsWrote) rows = yield* loadStateRows(orgId)

				// The org's public ingest key authenticates the gateway POSTs (minted on first use).
				const keyResult = yield* Effect.result(getOrgIngestKey(orgId))
				if (Result.isFailure(keyResult)) {
					yield* recordOrgError(
						orgId,
						`Cloudflare ingest key unavailable: ${keyResult.failure.message}`,
						now,
					)
					return skip("ingest key unavailable")
				}
				const ingestKey = keyResult.success

				const rowsIngestedRef = yield* Ref.make(0)
				// Set when Cloudflare rejects the token mid-loop — every further call would 401 too.
				const revokedRef = yield* Ref.make(false)

				// Round-based catch-up: every round advances each behind zone/dataset by one window;
				// loop until caught up or the call budget is spent (backfill resumes next tick).
				while (!(yield* Ref.get(revokedRef)) && budget.calls < MAX_CALLS_PER_ORG_TICK) {
					const work = buildWorkItems(rows, now)
					if (work.length === 0) break
					let progressed = false

					for (const item of work) {
						if (budget.calls >= MAX_CALLS_PER_ORG_TICK || (yield* Ref.get(revokedRef))) break
						budget.calls += 1
						const outcome = yield* pollDatasetChunk(
							item,
							{ orgId, accountId, accessToken, ingestKey },
							now,
						).pipe(
							Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
								Ref.set(revokedRef, true).pipe(
									Effect.andThen(
										recordOrgError(orgId, error.message, now, { disable: true }),
									),
									Effect.as(FAILED_OUTCOME),
								),
							),
							Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
								recordError(
									item.rows.map((row) => row.id),
									error.message,
									now,
								).pipe(Effect.as(FAILED_OUTCOME)),
							),
						)

						// Mirror the DB write onto the in-memory rows so the next round re-plans
						// without a per-round SELECT.
						yield* Match.value(outcome).pipe(
							Match.discriminatorsExhaustive("kind")({
								advanced: ({ ingested }) =>
									Ref.update(rowsIngestedRef, (count) => count + ingested).pipe(
										Effect.map(() => {
											progressed = true
											const watermark = new Date(item.window.end)
											for (const row of item.rows) row.watermarkAt = watermark
										}),
									),
								"quantiles-downgraded": () =>
									Effect.sync(() => {
										progressed = true
										for (const row of item.rows) row.quantilesAvailable = false
									}),
								disabled: () =>
									Effect.sync(() => {
										for (const row of item.rows) row.enabled = false
									}),
								failed: () => Effect.void,
							}),
						)
					}

					if (!progressed) break
				}

				const rowsIngested = yield* Ref.get(rowsIngestedRef)
				// Metrics ship through the ingest gateway (see emitMetrics), so Autumn metering
				// happens there — no self-report here.
				yield* Effect.annotateCurrentSpan("maple.cloudflare.calls", budget.calls)
				yield* Effect.annotateCurrentSpan("maple.cloudflare.rows_ingested", rowsIngested)
				return {
					orgId,
					skipped: null,
					callsMade: budget.calls,
					rowsIngested,
				} satisfies PollOrgSummary
			}).pipe(
				Effect.ensuring(
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((end) => releaseLease(orgId, end).pipe(Effect.ignore)),
					),
				),
			)
		})

		// ------------------------------------------------------------------
		// All-orgs tick + status
		// ------------------------------------------------------------------

		const pollAllOrgs = Effect.fn("CloudflareAnalyticsService.pollAllOrgs")(function* () {
			const orgRows = yield* dbExecute((db) =>
				db
					.selectDistinct({ orgId: oauthConnections.orgId, scope: oauthConnections.scope })
					.from(oauthConnections)
					.where(eq(oauthConnections.provider, "cloudflare")),
			)
			// Orgs whose grant lacks the analytics scopes can't be polled — the status endpoint
			// already surfaces that (analyticsCapable: false), so skipping them here avoids
			// rewriting the same scope error into their state rows every tick.
			const capable = orgRows.filter((row) => hasAnalyticsScopes(row.scope))
			// Concurrent fan-out below — must be a Ref rather than a mutable closure variable.
			const rowsIngestedRef = yield* Ref.make(0)
			yield* Effect.forEach(
				capable,
				(row) =>
					pollOrg(decodeOrgId(row.orgId)).pipe(
						Effect.tap((summary) =>
							Ref.update(rowsIngestedRef, (count) => count + summary.rowsIngested),
						),
						// Isolate genuine per-org failures/defects so one bad org can't fail the
						// whole tick. Interrupts (isolate teardown) are NOT per-org failures —
						// re-raise them so the tick cancels promptly instead of logging a phantom
						// failure and marching through the remaining orgs. (Same pattern as
						// AnomalyDetectionService / ErrorsService.)
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("cloudflare-analytics org poll failed", {
										orgId: row.orgId,
										error: Cause.pretty(cause),
									}),
						),
					),
				{ concurrency: ORG_CONCURRENCY, discard: true },
			)
			const rowsIngested = yield* Ref.get(rowsIngestedRef)
			return { orgs: capable.length, rowsIngested } satisfies PollAllOrgsSummary
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
					watermarkAt: row.watermarkAt == null ? null : dateToMs(row.watermarkAt),
				}))
				.sort((a, b) => a.name.localeCompare(b.name))
			const workersRow = rows.find((row) => row.dataset === WORKERS_DATASET)
			return {
				zones,
				workers: workersRow
					? {
							enabled: workersRow.enabled,
							lastSyncedAt:
								workersRow.lastSuccessAt == null ? null : dateToMs(workersRow.lastSuccessAt),
							lastError: workersRow.lastError,
							watermarkAt:
								workersRow.watermarkAt == null ? null : dateToMs(workersRow.watermarkAt),
						}
					: null,
			} satisfies CloudflareAnalyticsStatus
		})

		/**
		 * Warehouse-derived ingest usage for the integrations page: hourly request volume,
		 * datapoint counts, and the most recent metric timestamp per zone/Worker service.
		 * Proves end-to-end delivery (data is queryable) rather than poller bookkeeping.
		 */
		const getUsage = Effect.fn("CloudflareAnalyticsService.getUsage")(function* (orgId: OrgId) {
			const now = yield* Clock.currentTimeMillis
			const windowStart = now - USAGE_WINDOW_MS

			const connection = yield* oauth.getStatus(orgId)
			if (!connection.connected) {
				return new CloudflareUsageResponse({
					windowStart,
					windowEnd: now,
					bucketSeconds: USAGE_BUCKET_SECONDS,
					totalRequests: 0,
					services: [],
				})
			}

			const compiled = CH.compile(CH.cloudflareUsageQuery(), {
				orgId,
				bucketSeconds: USAGE_BUCKET_SECONDS,
				startTime: toWarehouseDateTime64(windowStart),
				endTime: toWarehouseDateTime64(now),
			})
			const rows = yield* warehouse
				// Metrics now flow through the ingest gateway, which routes each org to its own
				// warehouse (managed Tinybird or BYO ClickHouse). Read from that same warehouse
				// via the default resolver — no ingest pin — so BYO-CH orgs see their own data.
				.compiledQuery(systemTenant(orgId), compiled, {
					profile: "aggregation",
					context: "cloudflareUsage",
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new IntegrationsPersistenceError({
								message: `Failed to load Cloudflare usage: ${error.message}`,
							}),
					),
				)

			interface ServiceAgg {
				buckets: Array<CloudflareUsageBucket>
				totalRequests: number
				totalDatapoints: number
				lastDataAt: number | null
			}
			const byService = new Map<string, ServiceAgg>()
			for (const row of rows) {
				const agg = byService.get(row.serviceName) ?? {
					buckets: [],
					totalRequests: 0,
					totalDatapoints: 0,
					lastDataAt: null,
				}
				const requests = Math.round(row.requests)
				agg.buckets.push(
					new CloudflareUsageBucket({
						bucketStart: Date.parse(row.bucket),
						requests,
						datapoints: row.datapoints,
					}),
				)
				agg.totalRequests += requests
				agg.totalDatapoints += row.datapoints
				const lastMs = Date.parse(row.lastTimeUnix)
				if (Number.isFinite(lastMs)) {
					agg.lastDataAt = agg.lastDataAt == null ? lastMs : Math.max(agg.lastDataAt, lastMs)
				}
				byService.set(row.serviceName, agg)
			}

			const services = [...byService.entries()]
				.map(([serviceName, agg]) => {
					const isWorker = serviceName.startsWith(WORKER_SERVICE_PREFIX)
					const displayName = isWorker
						? serviceName.slice(WORKER_SERVICE_PREFIX.length)
						: serviceName.startsWith(ZONE_SERVICE_PREFIX)
							? serviceName.slice(ZONE_SERVICE_PREFIX.length)
							: serviceName
					return new CloudflareServiceUsage({
						serviceName,
						kind: isWorker ? ("worker" as const) : ("zone" as const),
						displayName,
						totalRequests: agg.totalRequests,
						totalDatapoints: agg.totalDatapoints,
						lastDataAt: agg.lastDataAt,
						buckets: agg.buckets,
					})
				})
				.sort((a, b) =>
					a.kind === b.kind
						? a.displayName.localeCompare(b.displayName)
						: a.kind === "zone"
							? -1
							: 1,
				)

			return new CloudflareUsageResponse({
				windowStart,
				windowEnd: now,
				bucketSeconds: USAGE_BUCKET_SECONDS,
				totalRequests: services.reduce((sum, s) => sum + s.totalRequests, 0),
				services,
			})
		})

		/** The full HTTP-facing integration status (connection + analytics collection state). */
		const getIntegrationStatus = Effect.fn("CloudflareAnalyticsService.getIntegrationStatus")(function* (
			orgId: OrgId,
		) {
			const connection = yield* oauth.getStatus(orgId)
			if (!connection.connected) {
				return new CloudflareIntegrationStatus({
					connected: false,
					accountId: null,
					accountName: null,
					connectedByUserId: null,
					scope: null,
					analyticsCapable: false,
					zones: [],
					workers: null,
				})
			}
			const analytics = yield* getStatus(orgId)
			return new CloudflareIntegrationStatus({
				connected: true,
				accountId: connection.accountId,
				accountName: connection.accountName,
				connectedByUserId: decodeUserIdSync(connection.connectedByUserId),
				scope: connection.scope,
				analyticsCapable: hasAnalyticsScopes(connection.scope),
				zones: analytics.zones.map((zone) => new CloudflareAnalyticsZoneStatus(zone)),
				workers: analytics.workers ? new CloudflareAnalyticsWorkersStatus(analytics.workers) : null,
			})
		})

		return {
			pollAllOrgs,
			pollOrg,
			getStatus,
			getIntegrationStatus,
			getUsage,
		} satisfies CloudflareAnalyticsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

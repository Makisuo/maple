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
	cloudflareHyperdriveConfigs,
	oauthConnections,
	type CloudflareAnalyticsStateInsert,
	type CloudflareAnalyticsStateRow,
	type CloudflareHyperdriveConfigRow,
} from "@maple/db"
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm"
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
	listHyperdriveConfigs as listAccountHyperdriveConfigs,
	listWorkerScripts,
	listZones,
	type CloudflareGraphqlError,
	type CloudflareHyperdriveConfig,
	type CloudflareZone,
} from "../lib/CloudflareApi"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs } from "../lib/time"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import { OrgClickHouseSettingsService } from "./OrgClickHouseSettingsService"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import {
	mapDnsGroups,
	mapDurableObjectsGroups,
	mapFirewallGroups,
	mapHttpGroups,
	mapQueueBacklogGroups,
	mapQueueConsumersGroups,
	mapWorkersGroups,
	type CloudflareMetricRows,
} from "./cloudflare-analytics/mapping"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import {
	accountAnalyticsDocument,
	DatasetSettings,
	decodeAccountAnalyticsEnvelope,
	decodeDnsZoneNode,
	decodeDurableObjectsAccountNode,
	decodeFirewallZoneNode,
	decodeHttpZoneNode,
	decodeQueueBacklogAccountNode,
	decodeQueueConsumersAccountNode,
	decodeSettingsResponse,
	decodeWorkersAccountNode,
	decodeZoneAnalyticsEnvelope,
	decodeZoneTagOption,
	DNS_DATASET,
	dnsSelection,
	DO_DATASET,
	durableObjectsSelection,
	FIREWALL_DATASET,
	firewallSelection,
	HTTP_DATASET,
	httpSelection,
	MAX_ZONES_PER_QUERY,
	QUEUE_BACKLOG_DATASET,
	QUEUE_CONSUMERS_DATASET,
	queueBacklogSelection,
	queueConsumersSelection,
	settingsQuery,
	toGraphqlTime,
	WORKERS_DATASET,
	workersSelection,
	zoneAnalyticsDocument,
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
const QUEUE_SERVICE_PREFIX = "cloudflare-queue/"
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

/** Context for mapping one zone/account node's decoded groups to metric rows. */
interface DatasetMapTarget {
	readonly orgId: OrgId
	readonly accountId: string
	/** The state row the node belongs to (zone datasets: that zone's row; account: the anchor row). */
	readonly row: CloudflareAnalyticsStateRow
	/** Live Worker script names (REST enumeration); null when unavailable → no filtering. */
	readonly liveScripts: ReadonlySet<string> | null
}

interface DatasetDef {
	readonly id: string
	readonly scope: "zone" | "account"
	/** Lowercased needles identifying this dataset's quantile fields in GraphQL error text. */
	readonly quantileNeedles: ReadonlyArray<string>
	/** Needle for the settings `availableFields` probe (see {@link quantilesFromAvailableFields}). */
	readonly availableFieldsNeedle: string
	/**
	 * Aliases this dataset's selections use inside the shared `zones`/`accounts` node. Used to
	 * attribute a GraphQL error `path` back to the owning dataset in a batched document.
	 */
	readonly aliases: ReadonlyArray<string>
	/** Selection fragment(s) rendered inside the shared zone/account node of a batched document. */
	readonly selection: (options: { readonly withQuantiles: boolean }) => string
	/** Decode this dataset's aliases out of one zone/account node and map them to metric rows. */
	readonly mapNode: (
		node: unknown,
		target: DatasetMapTarget,
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

const decodeError = (dataset: string) =>
	new IntegrationsPersistenceError({
		message: `Cloudflare GraphQL ${dataset} analytics response had an unexpected shape`,
	})

const httpDataset: DatasetDef = {
	id: HTTP_DATASET,
	scope: "zone",
	quantileNeedles: ["edgetimetofirstbytems", "quantiles"],
	availableFieldsNeedle: "edgetimetofirstbytems",
	aliases: ["groups", "latency"],
	selection: httpSelection,
	mapNode: (node, target) =>
		decodeHttpZoneNode(node).pipe(
			Effect.mapError(() => decodeError("HTTP")),
			Effect.map((decoded) =>
				mapHttpGroups({
					orgId: target.orgId,
					zoneId: target.row.zoneId,
					zoneName: target.row.zoneName ?? target.row.zoneId,
					groups: decoded.groups ?? [],
					latency: decoded.latency ?? [],
				}),
			),
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
	aliases: ["invocations"],
	selection: workersSelection,
	mapNode: (node, target) =>
		decodeWorkersAccountNode(node).pipe(
			Effect.mapError(() => decodeError("workers")),
			Effect.map((decoded) =>
				mapWorkersGroups({
					orgId: target.orgId,
					accountId: target.accountId,
					groups: decoded.invocations ?? [],
					liveScripts: target.liveScripts,
				}),
			),
		),
	settingsNode: (decoded) => decoded.viewer.accounts?.[0]?.settings?.workersInvocationsAdaptive ?? null,
}

const firewallDataset: DatasetDef = {
	id: FIREWALL_DATASET,
	scope: "zone",
	quantileNeedles: [],
	// No quantile fields exist on this dataset; the empty needle keeps `quantilesAvailable` true
	// so its rows batch into the same document group as the HTTP rows.
	availableFieldsNeedle: "",
	aliases: ["firewall"],
	selection: firewallSelection,
	mapNode: (node, target) =>
		decodeFirewallZoneNode(node).pipe(
			Effect.mapError(() => decodeError("firewall")),
			Effect.map((decoded) =>
				mapFirewallGroups({
					orgId: target.orgId,
					zoneId: target.row.zoneId,
					zoneName: target.row.zoneName ?? target.row.zoneId,
					groups: decoded.firewall ?? [],
				}),
			),
		),
	settingsNode: (decoded, row) => {
		const zone = (decoded.viewer.zones ?? []).find((entry) => entry.zoneTag === row.zoneId)
		return zone === undefined ? undefined : (zone.settings?.firewallEventsAdaptiveGroups ?? null)
	},
}

const dnsDataset: DatasetDef = {
	id: DNS_DATASET,
	scope: "zone",
	quantileNeedles: [],
	availableFieldsNeedle: "",
	aliases: ["dns"],
	selection: dnsSelection,
	mapNode: (node, target) =>
		decodeDnsZoneNode(node).pipe(
			Effect.mapError(() => decodeError("DNS")),
			Effect.map((decoded) =>
				mapDnsGroups({
					orgId: target.orgId,
					zoneId: target.row.zoneId,
					zoneName: target.row.zoneName ?? target.row.zoneId,
					groups: decoded.dns ?? [],
				}),
			),
		),
	settingsNode: (decoded, row) => {
		const zone = (decoded.viewer.zones ?? []).find((entry) => entry.zoneTag === row.zoneId)
		return zone === undefined ? undefined : (zone.settings?.dnsAnalyticsAdaptiveGroups ?? null)
	},
}

const queueBacklogDataset: DatasetDef = {
	id: QUEUE_BACKLOG_DATASET,
	scope: "account",
	quantileNeedles: [],
	availableFieldsNeedle: "",
	aliases: ["queueBacklog"],
	selection: queueBacklogSelection,
	mapNode: (node, target) =>
		decodeQueueBacklogAccountNode(node).pipe(
			Effect.mapError(() => decodeError("queue backlog")),
			Effect.map((decoded) =>
				mapQueueBacklogGroups({
					orgId: target.orgId,
					accountId: target.accountId,
					groups: decoded.queueBacklog ?? [],
				}),
			),
		),
	settingsNode: (decoded) => decoded.viewer.accounts?.[0]?.settings?.queueBacklogAdaptiveGroups ?? null,
}

const queueConsumersDataset: DatasetDef = {
	id: QUEUE_CONSUMERS_DATASET,
	scope: "account",
	quantileNeedles: [],
	availableFieldsNeedle: "",
	aliases: ["queueConsumers"],
	selection: queueConsumersSelection,
	mapNode: (node, target) =>
		decodeQueueConsumersAccountNode(node).pipe(
			Effect.mapError(() => decodeError("queue consumers")),
			Effect.map((decoded) =>
				mapQueueConsumersGroups({
					orgId: target.orgId,
					accountId: target.accountId,
					groups: decoded.queueConsumers ?? [],
				}),
			),
		),
	settingsNode: (decoded) =>
		decoded.viewer.accounts?.[0]?.settings?.queueConsumerMetricsAdaptiveGroups ?? null,
}

const durableObjectsDataset: DatasetDef = {
	id: DO_DATASET,
	scope: "account",
	quantileNeedles: ["walltime"],
	availableFieldsNeedle: "walltime",
	aliases: ["durableObjects"],
	selection: durableObjectsSelection,
	mapNode: (node, target) =>
		decodeDurableObjectsAccountNode(node).pipe(
			Effect.mapError(() => decodeError("durable objects")),
			Effect.map((decoded) =>
				mapDurableObjectsGroups({
					orgId: target.orgId,
					accountId: target.accountId,
					groups: decoded.durableObjects ?? [],
					liveScripts: target.liveScripts,
				}),
			),
		),
	settingsNode: (decoded) =>
		decoded.viewer.accounts?.[0]?.settings?.durableObjectsInvocationsAdaptiveGroups ?? null,
}

const DATASETS: ReadonlyArray<DatasetDef> = [
	httpDataset,
	firewallDataset,
	dnsDataset,
	workersDataset,
	queueBacklogDataset,
	queueConsumersDataset,
	durableObjectsDataset,
]
const DATASET_BY_ID = new Map(DATASETS.map((dataset) => [dataset.id, dataset]))
const ZONE_DATASETS = DATASETS.filter((dataset) => dataset.scope === "zone")
const ACCOUNT_DATASETS = DATASETS.filter((dataset) => dataset.scope === "account")

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

// Cloudflare gates analytics datasets/fields by plan tier. A query for a dataset (or field) the
// zone's plan doesn't include comes back as an "access controls" / "does not have access to the
// path|field" GraphQL error (sometimes also tagged extensions.code:"authz"). These are expected
// per-plan degradations, not incidents — they must route to the quiet `disabled` /
// `quantiles-unavailable` paths rather than raising `AnalyticsPollError`.
const isPlanGatedMessage = (message: string): boolean => {
	const lower = message.toLowerCase()
	return (
		lower.includes("does not have access to the path") ||
		lower.includes("does not have access to the field") ||
		lower.includes("access controls")
	)
}

const classifyGraphqlErrors = (
	errors: ReadonlyArray<CloudflareGraphqlError>,
	quantileNeedles: ReadonlyArray<string>,
): GraphqlErrorKind => {
	const messages = errors.map((error) => error.message.toLowerCase())
	// Plan lacks the dataset's timing-quantile fields → the query referenced an "unknown"/"cannot
	// query" field, or Cloudflare reports the plan "does not have access to the field". Degrade to
	// counters-only instead of erroring forever.
	if (
		messages.some(
			(message) =>
				(message.includes("unknown") ||
					message.includes("cannot query") ||
					message.includes("does not have access to the field")) &&
				quantileNeedles.some((needle) => message.includes(needle)),
		)
	) {
		return "quantiles-unavailable"
	}
	// Plan lacks the whole dataset/path → an "access controls" / "does not have access to the path"
	// error. Expected per-plan gating: quietly disable the dataset (stops polling until a settings
	// change / reconnect re-enables it) rather than raising. Checked BEFORE the authz-code branch
	// because Cloudflare tags some plan-gating errors with extensions.code:"authz".
	if (messages.some(isPlanGatedMessage)) {
		return "disabled"
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

const decodeLiveScripts = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

/** Cached live-script enumeration from the workers anchor row; null → unavailable → no filtering. */
const parseLiveScripts = (liveScriptsJson: string | null): ReadonlySet<string> | null =>
	liveScriptsJson == null
		? null
		: Option.match(decodeLiveScripts(liveScriptsJson), {
				onNone: () => null,
				onSome: (scripts) => new Set(scripts),
			})

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

/** Per-query window cap: never exceed {@link MAX_WINDOW_MS}, and honor the plan's `maxDuration`. */
const maxWindowMs = (row: CloudflareAnalyticsStateRow): number => {
	const settings = parseStoredSettings(row.settingsJson)
	return Math.min(MAX_WINDOW_MS, settings.maxDurationMs ?? MAX_WINDOW_MS)
}

/** Oldest bucket the backfill may reach: the 24h floor, further bounded by the plan's `notOlderThan`. */
const backfillFloor = (row: CloudflareAnalyticsStateRow, now: number): number => {
	const settings = parseStoredSettings(row.settingsJson)
	const retentionFloor =
		settings.notOlderThanMs != null ? floorToBucket(now - settings.notOlderThanMs) + BUCKET_MS : null
	const start = floorToBucket(now - SAFETY_LAG_MS - BACKFILL_MS)
	return retentionFloor != null ? Math.max(start, retentionFloor) : start
}

/**
 * HEAD window — the newest un-ingested slice, fetched FIRST every tick so a freshly-connected
 * integration surfaces near-live data within one tick. The first poll (null watermark) grabs just
 * the newest window; steady state is the small `[watermark, horizon]` delta. Null once caught up to
 * the safety-lag horizon.
 */
const headWindow = (row: CloudflareAnalyticsStateRow, now: number): PollWindow | null => {
	const effectiveEnd = floorToBucket(now - SAFETY_LAG_MS)
	const floor = backfillFloor(row, now)
	const window = maxWindowMs(row)
	const watermarkMs = row.watermarkAt == null ? null : dateToMs(row.watermarkAt)
	let start = watermarkMs ?? floorToBucket(effectiveEnd - window)
	if (start < floor) start = floor
	start = floorToBucket(start)
	const end = Math.min(start + window, effectiveEnd)
	if (end <= start) return null
	return { start, end }
}

/**
 * BACKFILL window — the next older history slice, walking DOWN from the backfill frontier toward
 * {@link backfillFloor}. Null until the first head poll seeds `backfillAt`, and once history is
 * complete. Planned after the head pass so it only consumes leftover call budget.
 */
const backfillWindow = (row: CloudflareAnalyticsStateRow, now: number): PollWindow | null => {
	if (row.backfillAt == null) return null
	const floor = backfillFloor(row, now)
	const end = floorToBucket(dateToMs(row.backfillAt))
	if (end <= floor) return null
	const start = Math.max(floorToBucket(end - maxWindowMs(row)), floor)
	if (end <= start) return null
	return { start, end }
}

// ---------------------------------------------------------------------------
// Round planning
// ---------------------------------------------------------------------------

/** One dataset's slice of a batched GraphQL document. */
interface WorkPart {
	readonly dataset: DatasetDef
	readonly rows: CloudflareAnalyticsStateRow[]
}

interface WorkItem {
	readonly scope: "zone" | "account"
	/** Datasets sharing this document, in registry order (stable document shape). */
	readonly parts: ReadonlyArray<WorkPart>
	readonly window: PollWindow
	readonly withQuantiles: boolean
	/** Which frontier this window advances — head items are planned (and thus polled) before backfill. */
	readonly phase: "head" | "backfill"
}

/**
 * Plan one poll round. The HEAD pass (newest windows) is emitted before the BACKFILL pass so the
 * caller spends its per-tick call budget on live data first and history second. Within each pass,
 * all rows sharing an identical (window, quantile-flag) — the steady state — merge into ONE
 * GraphQL document per scope, with each dataset contributing aliased selections: GROUP_LIMIT is
 * per selection, so batching datasets costs nothing on the row cap and keeps the steady-state
 * call count at one zone document per 10-zone chunk plus one account document. A newly-added
 * dataset backfills through its own (differing-window) documents until it converges. Zone-scoped
 * documents are capped at Cloudflare's 10-zones-per-query limit.
 */
const buildWorkItems = (rows: ReadonlyArray<CloudflareAnalyticsStateRow>, now: number): WorkItem[] => {
	const planPass = (
		phase: WorkItem["phase"],
		selectWindow: (row: CloudflareAnalyticsStateRow, now: number) => PollWindow | null,
	): WorkItem[] => {
		const items: WorkItem[] = []
		for (const scope of ["zone", "account"] as const) {
			const groups = new Map<
				string,
				{
					byDataset: Map<string, CloudflareAnalyticsStateRow[]>
					window: PollWindow
					withQuantiles: boolean
				}
			>()
			for (const row of rows) {
				const dataset = DATASET_BY_ID.get(row.dataset)
				if (!dataset || dataset.scope !== scope || !row.enabled) continue
				const window = selectWindow(row, now)
				if (window == null) continue
				const key = `${window.start}:${window.end}:${row.quantilesAvailable}`
				let group = groups.get(key)
				if (!group) {
					group = { byDataset: new Map(), window, withQuantiles: row.quantilesAvailable }
					groups.set(key, group)
				}
				const list = group.byDataset.get(dataset.id)
				if (list) list.push(row)
				else group.byDataset.set(dataset.id, [row])
			}
			const scopeDatasets = scope === "zone" ? ZONE_DATASETS : ACCOUNT_DATASETS
			for (const group of groups.values()) {
				if (scope === "account") {
					const parts = scopeDatasets.flatMap((dataset) => {
						const datasetRows = group.byDataset.get(dataset.id)
						return datasetRows ? [{ dataset, rows: datasetRows }] : []
					})
					if (parts.length > 0) {
						items.push({
							scope,
							parts,
							window: group.window,
							withQuantiles: group.withQuantiles,
							phase,
						})
					}
					continue
				}
				const zoneIds = [
					...new Set([...group.byDataset.values()].flat().map((row) => row.zoneId)),
				].sort()
				for (const chunk of Arr.chunksOf(zoneIds, MAX_ZONES_PER_QUERY)) {
					const chunkSet = new Set(chunk)
					const parts = scopeDatasets.flatMap((dataset) => {
						const datasetRows = (group.byDataset.get(dataset.id) ?? []).filter((row) =>
							chunkSet.has(row.zoneId),
						)
						return datasetRows.length > 0 ? [{ dataset, rows: datasetRows }] : []
					})
					if (parts.length > 0) {
						items.push({
							scope,
							parts,
							window: group.window,
							withQuantiles: group.withQuantiles,
							phase,
						})
					}
				}
			}
		}
		return items
	}
	return [...planPass("head", headWindow), ...planPass("backfill", backfillWindow)]
}

/**
 * Attribute a GraphQL error to the document part that owns it. Execution errors carry a `path`
 * whose string segments include the failing selection's alias; validation errors (e.g. a plan
 * lacking a quantile field rejects the whole document) carry no path, so fall back to matching
 * the dataset's quantile needles against the message. Null → unattributable, applies to every part.
 */
const partForError = (error: CloudflareGraphqlError, parts: ReadonlyArray<WorkPart>): WorkPart | null => {
	if (Array.isArray(error.path)) {
		for (const segment of error.path) {
			if (typeof segment !== "string") continue
			const part = parts.find((candidate) => candidate.dataset.aliases.includes(segment))
			if (part) return part
		}
	}
	const message = error.message.toLowerCase()
	return (
		parts.find((candidate) =>
			candidate.dataset.quantileNeedles.some((needle) => message.includes(needle)),
		) ?? null
	)
}

/**
 * A genuine poll failure — as opposed to an expected per-plan degradation. Carries everything the
 * single observation seam needs to (a) record health onto `cloudflare_analytics_state` and (b) emit
 * an observable signal. A failure therefore CANNOT be constructed without the context needed to see
 * it, which is the whole point: the old context-free `{ kind: "failed" }` sentinel let every failure
 * path silently drop its own message into a DB column with zero telemetry.
 */
interface DatasetPollFailure {
	readonly scope: "zone" | "account"
	readonly datasetId: string
	readonly kind: "authz" | "upstream" | "revoked" | "other"
	readonly message: string
	/** State rows this failure applies to (used for the health write when not org-wide). */
	readonly rowIds: ReadonlyArray<string>
	/** revoked → record on ALL of the org's rows instead of just `rowIds`. */
	readonly orgWide?: boolean
	/** Also flip `enabled = false` (revoked / hard-disabled datasets). */
	readonly disable?: boolean
}

/**
 * Internal-only tagged error — never returned over HTTP. Failing with it inside the
 * `datasetPollFailed` span records an OTel exception event, so a broken integration surfaces in
 * `find_errors` / the errors page through the SAME pipeline as every other error, instead of being
 * buried in `cloudflare_analytics_state.lastError` where nothing watches it.
 */
class CloudflareAnalyticsPollError extends Schema.TaggedErrorClass<CloudflareAnalyticsPollError>()(
	"@maple/cloudflare/AnalyticsPollError",
	{
		message: Schema.String,
		orgId: OrgId,
		dataset: Schema.String,
		kind: Schema.Literals(["authz", "upstream", "revoked", "other"]),
	},
) {}

type PollOutcome =
	| { readonly kind: "advanced"; readonly ingested: number }
	| { readonly kind: "quantiles-downgraded" }
	| { readonly kind: "disabled" }
	| { readonly kind: "failed"; readonly failure: DatasetPollFailure }

/** Typed constructor so each failure site returns `PollOutcome` (widens the failure off `as const`). */
const failedOutcome = (failure: DatasetPollFailure): PollOutcome => ({ kind: "failed", failure })

/** One dataset's outcome from a batched document poll. */
interface PartResult {
	readonly part: WorkPart
	readonly outcome: PollOutcome
}

/** Every part of a document fails the same way (transport-level errors: revoked/upstream). */
const allPartsFailed = (
	item: WorkItem,
	kind: DatasetPollFailure["kind"],
	message: string,
	options?: { readonly orgWide?: boolean; readonly disable?: boolean },
): Array<PartResult> =>
	item.parts.map((part) => ({
		part,
		outcome: failedOutcome({
			scope: part.dataset.scope,
			datasetId: part.dataset.id,
			kind,
			message,
			rowIds: part.rows.map((row) => row.id),
			...options,
		}),
	}))

/**
 * The single seam that turns a poll failure into signal: record health to Postgres (as before) AND
 * record an OTel exception event + ERROR log so the failure is visible in Maple's own tooling. This
 * is the ONLY place that reacts to a `DatasetPollFailure`; every failure path just classifies and
 * returns one, so a new failure path is observable by construction rather than by remembering to
 * instrument it. Expected degradations (`quantiles-downgraded`, `disabled`) never reach here.
 */
const observeDatasetFailure = (orgId: OrgId, failure: DatasetPollFailure) =>
	Effect.gen(function* () {
		yield* Effect.logError("cloudflare-analytics dataset poll failed", {
			orgId,
			dataset: failure.datasetId,
			scope: failure.scope,
			kind: failure.kind,
			affectedRows: failure.rowIds.length,
			error: failure.message,
		})
		// Failing inside the span below is what records the exception event that error_events /
		// find_errors unwrap. Caught immediately after the span boundary so a single bad dataset
		// never fails the org poll.
		yield* Effect.fail(
			new CloudflareAnalyticsPollError({
				message: failure.message,
				orgId,
				dataset: failure.datasetId,
				kind: failure.kind,
			}),
		)
	}).pipe(
		Effect.withSpan("CloudflareAnalyticsService.datasetPollFailed", {
			attributes: {
				orgId,
				"maple.cloudflare.dataset": failure.datasetId,
				"maple.cloudflare.error.kind": failure.kind,
				"maple.cloudflare.error": failure.message,
			},
		}),
		// Swallow after the span boundary so one bad dataset never fails the org poll — the span
		// has already recorded the exception event by the time we get here.
		Effect.ignore,
	)

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
	readonly failures: ReadonlyArray<DatasetPollFailure>
}

interface PollAllOrgsSummary {
	readonly orgs: number
	readonly rowsIngested: number
	readonly failures: number
	readonly skipped: number
	readonly perOrg: ReadonlyArray<{
		readonly orgId: OrgId
		readonly skipped: string | null
		readonly callsMade: number
		readonly rowsIngested: number
		readonly failures: number
	}>
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
	/** Non-deleted Hyperdrive config inventory rows, refreshed by the hourly discovery pass. */
	readonly listHyperdriveConfigs: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<CloudflareHyperdriveConfigRow>, IntegrationsPersistenceError>
	/** Recovery hook for reconnect — see the implementation below for why this exists. */
	readonly resetOrgState: (orgId: OrgId) => Effect.Effect<void, IntegrationsPersistenceError>
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
		const orgClickHouse = yield* OrgClickHouseSettingsService

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

		/**
		 * Advance the HEAD frontier after a live window landed, and seed the backfill frontier on the
		 * first head poll. The `isNull(backfillAt)` guard means a batched re-seed never rewinds
		 * in-progress history for rows that are already backfilling.
		 */
		const advanceHead = (
			rowIds: ReadonlyArray<string>,
			headEndMs: number,
			headStartMs: number,
			now: number,
		) =>
			updateRows(rowIds, {
				watermarkAt: new Date(headEndMs),
				lastSuccessAt: new Date(now),
				lastError: null,
				lastErrorAt: null,
				updatedAt: new Date(now),
			}).pipe(
				Effect.andThen(
					rowIds.length === 0
						? Effect.void
						: dbExecute((db) =>
								db
									.update(cloudflareAnalyticsState)
									.set({ backfillAt: new Date(headStartMs), updatedAt: new Date(now) })
									.where(
										and(
											inArray(cloudflareAnalyticsState.id, [...rowIds]),
											isNull(cloudflareAnalyticsState.backfillAt),
										),
									),
							),
				),
			)

		/** Advance the BACKFILL frontier down after an older history window landed. */
		const advanceBackfill = (rowIds: ReadonlyArray<string>, backfillStartMs: number, now: number) =>
			updateRows(rowIds, {
				backfillAt: new Date(backfillStartMs),
				lastSuccessAt: new Date(now),
				lastError: null,
				lastErrorAt: null,
				updatedAt: new Date(now),
			})

		/**
		 * Ensure one state row per account-scoped dataset exists (zoneId = ""). The workers row
		 * stays the org's lease anchor and gives scope errors somewhere to land even before zone
		 * discovery has ever succeeded; sibling account datasets ride along here.
		 */
		const ensureAccountRows = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db
					.insert(cloudflareAnalyticsState)
					.values(
						ACCOUNT_DATASETS.map((dataset) => ({
							id: randomUUID(),
							orgId,
							dataset: dataset.id,
							zoneId: "",
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})),
					)
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
								// Corrupt-lease escape hatch: a live lease is always bounded by now+LEASE_MS,
								// so anything beyond 2x that is impossible under normal operation (e.g. a
								// clock jump or a crashed writer that left a bogus far-future value) and is
								// safe to reclaim rather than let it wedge the org forever.
								gt(cloudflareAnalyticsState.leaseUntil, new Date(now + 2 * LEASE_MS)),
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
			// Every zone-scoped dataset gets one state row per discovered zone — reconcile them all.
			const byDatasetZone = new Map<string, CloudflareAnalyticsStateRow>()
			for (const row of rows) {
				if (DATASET_BY_ID.get(row.dataset)?.scope === "zone") {
					byDatasetZone.set(`${row.dataset}:${row.zoneId}`, row)
				}
			}

			const missing = ZONE_DATASETS.flatMap((dataset) =>
				zones
					.filter((zone) => !byDatasetZone.has(`${dataset.id}:${zone.id}`))
					.map((zone) => ({
						id: randomUUID(),
						orgId,
						dataset: dataset.id,
						zoneId: zone.id,
						zoneName: zone.name,
						createdAt: new Date(now),
						updatedAt: new Date(now),
					})),
			)
			const inserted =
				missing.length === 0
					? []
					: yield* dbExecute((db) =>
							db
								.insert(cloudflareAnalyticsState)
								.values(missing)
								.onConflictDoNothing()
								.returning(),
						)

			for (const dataset of ZONE_DATASETS) {
				for (const zone of zones) {
					const existing = byDatasetZone.get(`${dataset.id}:${zone.id}`)
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
			}

			const seen = new Set(zones.map((zone) => zone.id))
			const vanished = rows.filter(
				(row) =>
					DATASET_BY_ID.get(row.dataset)?.scope === "zone" && row.enabled && !seen.has(row.zoneId),
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

			const staleZone = stale.filter((row) => DATASET_BY_ID.get(row.dataset)?.scope === "zone")
			const staleAccount = stale.filter((row) => DATASET_BY_ID.get(row.dataset)?.scope === "account")
			// Multiple zone datasets share a zone's settings node — chunk by DISTINCT zoneId so a
			// zone with several stale dataset rows costs one settings slot, not one per dataset.
			const staleZoneIds = [...new Set(staleZone.map((row) => row.zoneId))].sort()
			const zoneIdChunks = Arr.chunksOf(staleZoneIds, MAX_ZONES_PER_QUERY)

			// The account settings ride along with the first zone chunk; with no zones we still
			// need one account-only call for the account-scoped rows.
			const plans: Array<{
				zones: ReadonlyArray<CloudflareAnalyticsStateRow>
				zoneIds: ReadonlyArray<string>
				includeAccount: boolean
			}> =
				zoneIdChunks.length > 0
					? zoneIdChunks.map((zoneIds, index) => {
							const idSet = new Set(zoneIds)
							return {
								zones: staleZone.filter((row) => idSet.has(row.zoneId)),
								zoneIds,
								includeAccount: index === 0 && staleAccount.length > 0,
							}
						})
					: staleAccount.length > 0
						? [{ zones: [], zoneIds: [], includeAccount: true }]
						: []

			for (const plan of plans) {
				if (budget.calls >= MAX_CALLS_PER_ORG_TICK) return wrote
				budget.calls += 1
				const result = yield* graphqlQuery(
					accessToken,
					{
						query: settingsQuery({ withZones: plan.zoneIds.length > 0 }),
						variables: {
							accountTag: accountId,
							...(plan.zoneIds.length > 0 ? { zoneTags: plan.zoneIds } : {}),
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
				for (const row of [...plan.zones, ...(plan.includeAccount ? staleAccount : [])]) {
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
		 * One poll step: query a batched document's window, attribute GraphQL-level errors to their
		 * owning selections (quantile downgrade / dataset disabled / failure per part), decode and
		 * map the clean parts, ingest them as one gateway batch, advance each clean part's frontier.
		 * With a single part this is exactly the old single-dataset behavior.
		 */
		const pollDatasetChunk = Effect.fn("CloudflareAnalyticsService.pollDatasetChunk")(function* (
			item: WorkItem,
			context: {
				readonly orgId: OrgId
				readonly accountId: string
				readonly accessToken: string
				readonly ingestKey: string
				readonly liveScripts: ReadonlySet<string> | null
			},
			now: number,
		) {
			const selections = item.parts.map((part) =>
				part.dataset.selection({ withQuantiles: item.withQuantiles }),
			)
			const zoneTags =
				item.scope === "zone"
					? [...new Set(item.parts.flatMap((part) => part.rows.map((row) => row.zoneId)))].sort()
					: null
			const result = yield* graphqlQuery(
				context.accessToken,
				{
					query:
						item.scope === "zone"
							? zoneAnalyticsDocument(selections)
							: accountAnalyticsDocument(selections),
					variables: {
						...(zoneTags == null ? { accountTag: context.accountId } : { zoneTags }),
						start: toGraphqlTime(item.window.start),
						end: toGraphqlTime(item.window.end),
					},
				},
				apiBaseUrl,
			)

			const results: Array<PartResult> = []
			const errorsByPart = new Map<WorkPart, CloudflareGraphqlError[]>()
			const unattributed: CloudflareGraphqlError[] = []
			for (const error of result.errors) {
				const part = partForError(error, item.parts)
				if (part == null) {
					unattributed.push(error)
					continue
				}
				const list = errorsByPart.get(part)
				if (list) list.push(error)
				else errorsByPart.set(part, [error])
			}

			// Unattributable errors apply to EVERY part; each part classifies its error set with its
			// own quantile needles, so a per-plan degradation only downgrades/disables the dataset
			// that owns the failing selection.
			const failedParts = new Set<WorkPart>()
			for (const part of item.parts) {
				const attributed = errorsByPart.get(part) ?? []
				const partErrors = [...attributed, ...unattributed]
				if (partErrors.length === 0) continue
				failedParts.add(part)
				const rowIds = part.rows.map((row) => row.id)
				let kind = classifyGraphqlErrors(partErrors, part.dataset.quantileNeedles)
				// Disabling is destructive (the dataset stops polling until settings/reconnect
				// re-enable it), so a "disabled"-shaped error that ISN'T attributable to this part's
				// own selection must not cascade across a batched document — one ambiguous error would
				// silently kill every healthy sibling dataset. With a single part the attribution is
				// unambiguous (exactly the old single-dataset behavior); otherwise:
				//   • expected plan-gating ("does not have access to the path/field" / "access
				//     controls") → skip this part silently and retry next round (no disable, no
				//     telemetry). Cloudflare voids the whole batched document when any one selection is
				//     gated, so an unattributed gating error tells us nothing about THIS part — treating
				//     it as a failure is exactly what floods the error pipeline with expected noise.
				//   • anything else → degrade to a retryable failure and let a properly-attributed
				//     error (or the settings probe) do the disabling.
				if (kind === "disabled" && attributed.length === 0 && item.parts.length > 1) {
					if (partErrors.some((error) => isPlanGatedMessage(error.message))) {
						continue
					}
					kind = "other"
				}
				if (kind === "quantiles-unavailable") {
					yield* updateRows(rowIds, { quantilesAvailable: false, updatedAt: new Date(now) })
					// The next round rebuilds the document without the quantile fields — retry.
					results.push({ part, outcome: { kind: "quantiles-downgraded" } })
				} else if (kind === "disabled") {
					// `disabled` is an expected per-plan degradation (the dataset isn't available on
					// this tenant's plan), not an incident — record health quietly and stop polling it.
					yield* recordError(rowIds, graphqlErrorMessage(partErrors), now, { disable: true })
					results.push({ part, outcome: { kind: "disabled" } })
				} else {
					// authz / other → a genuine failure. Hand it to the org-loop seam, which records
					// health AND emits telemetry.
					results.push({
						part,
						outcome: failedOutcome({
							scope: part.dataset.scope,
							datasetId: part.dataset.id,
							kind,
							message: graphqlErrorMessage(partErrors),
							rowIds,
						}),
					})
				}
			}

			const cleanParts = item.parts.filter((part) => !failedParts.has(part))
			if (cleanParts.length === 0) return results
			if (result.data == null) {
				// Errors typically null the whole `data` — clean parts simply didn't advance; retry
				// next round. A null data with NO errors is an upstream contract break.
				if (result.errors.length === 0) {
					return yield* Effect.fail(decodeError("batched"))
				}
				// When every error that nulled `data` is expected per-plan gating, the clean sibling
				// parts weren't the problem — Cloudflare just voids the whole batch when one selection
				// is plan-gated. Don't fail them (and don't emit `AnalyticsPollError` telemetry); treat
				// them like the errorless case above — they didn't advance, retry next round. The
				// gated part itself is handled by its own classification (disabled/quantiles), and once
				// it disables, later rounds stop voiding the batch.
				if (result.errors.every((error) => isPlanGatedMessage(error.message))) {
					return results
				}
				for (const part of cleanParts) {
					results.push({
						part,
						outcome: failedOutcome({
							scope: part.dataset.scope,
							datasetId: part.dataset.id,
							kind: "other",
							message: `GraphQL response carried no data: ${graphqlErrorMessage(result.errors)}`,
							rowIds: part.rows.map((row) => row.id),
						}),
					})
				}
				return results
			}

			const combined: CloudflareMetricRows = { sumRows: [], gaugeRows: [] }
			const countsByPart = new Map<WorkPart, number>()
			const collect = (part: WorkPart, mapped: CloudflareMetricRows) => {
				combined.sumRows.push(...mapped.sumRows)
				combined.gaugeRows.push(...mapped.gaugeRows)
				countsByPart.set(
					part,
					(countsByPart.get(part) ?? 0) + mapped.sumRows.length + mapped.gaugeRows.length,
				)
			}
			if (item.scope === "zone") {
				const envelope = yield* decodeZoneAnalyticsEnvelope(result.data).pipe(
					Effect.mapError(() => decodeError("zone")),
				)
				const nodeByTag = new Map<string, unknown>()
				for (const node of envelope.viewer.zones ?? []) {
					const tag = decodeZoneTagOption(node)
					if (Option.isSome(tag)) nodeByTag.set(tag.value.zoneTag, node)
				}
				for (const part of cleanParts) {
					for (const row of part.rows) {
						const node = nodeByTag.get(row.zoneId)
						if (node === undefined) continue
						collect(
							part,
							yield* part.dataset.mapNode(node, {
								orgId: context.orgId,
								accountId: context.accountId,
								row,
								liveScripts: context.liveScripts,
							}),
						)
					}
				}
			} else {
				const envelope = yield* decodeAccountAnalyticsEnvelope(result.data).pipe(
					Effect.mapError(() => decodeError("account")),
				)
				const node = envelope.viewer.accounts?.[0]
				for (const part of cleanParts) {
					const row = part.rows[0]
					if (node === undefined || row === undefined) continue
					collect(
						part,
						yield* part.dataset.mapNode(node, {
							orgId: context.orgId,
							accountId: context.accountId,
							row,
							liveScripts: context.liveScripts,
						}),
					)
				}
			}

			yield* emitMetrics(context.ingestKey, combined)
			// Frontiers only advance after the gateway accepted the batch above.
			for (const part of cleanParts) {
				const rowIds = part.rows.map((row) => row.id)
				if (item.phase === "head") {
					yield* advanceHead(rowIds, item.window.end, item.window.start, now)
				} else {
					yield* advanceBackfill(rowIds, item.window.start, now)
				}
				results.push({ part, outcome: { kind: "advanced", ingested: countsByPart.get(part) ?? 0 } })
			}
			return results
		})

		// ------------------------------------------------------------------
		// Hyperdrive config inventory (discovery-cadence, service-map consumer)
		// ------------------------------------------------------------------

		/**
		 * Upsert the org's Hyperdrive configs by `(orgId, configId)` and soft-delete rows whose
		 * config disappeared upstream — mirrors the PlanetScale inventory reconcile so identity
		 * is kept if a config re-appears.
		 */
		const reconcileHyperdriveConfigs = Effect.fn(
			"CloudflareAnalyticsService.reconcileHyperdriveConfigs",
		)(function* (orgId: OrgId, configs: ReadonlyArray<CloudflareHyperdriveConfig>, now: number) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.cloudflare.hyperdrive_config_count": configs.length,
			})
			const existingRows = yield* dbExecute((db) =>
				db
					.select()
					.from(cloudflareHyperdriveConfigs)
					.where(eq(cloudflareHyperdriveConfigs.orgId, orgId)),
			)
			const existingByConfigId = new Map(existingRows.map((row) => [row.configId, row]))
			const upstreamIds = new Set(configs.map((config) => config.id))

			yield* Effect.forEach(
				configs,
				(config) => {
					const values = {
						name: config.name,
						originHost: config.origin.host,
						originPort: config.origin.port,
						originScheme: config.origin.scheme,
						originDatabase: config.origin.database,
						originUser: config.origin.user,
						deletedAt: null,
						updatedAt: new Date(now),
					}
					const existing = existingByConfigId.get(config.id)
					return existing !== undefined
						? dbExecute((db) =>
								db
									.update(cloudflareHyperdriveConfigs)
									.set(values)
									.where(eq(cloudflareHyperdriveConfigs.id, existing.id)),
							)
						: dbExecute((db) =>
								db.insert(cloudflareHyperdriveConfigs).values({
									id: randomUUID(),
									orgId,
									configId: config.id,
									createdAt: new Date(now),
									...values,
								}),
							)
				},
				{ concurrency: 4, discard: true },
			)

			yield* Effect.forEach(
				existingRows.filter((row) => !upstreamIds.has(row.configId) && row.deletedAt === null),
				(row) =>
					dbExecute((db) =>
						db
							.update(cloudflareHyperdriveConfigs)
							.set({ deletedAt: new Date(now), updatedAt: new Date(now) })
							.where(eq(cloudflareHyperdriveConfigs.id, row.id)),
					),
				{ concurrency: 4, discard: true },
			)
		})

		const listHyperdriveConfigsForOrg = Effect.fn(
			"CloudflareAnalyticsService.listHyperdriveConfigs",
		)(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			return yield* dbExecute((db) =>
				db
					.select()
					.from(cloudflareHyperdriveConfigs)
					.where(
						and(
							eq(cloudflareHyperdriveConfigs.orgId, orgId),
							isNull(cloudflareHyperdriveConfigs.deletedAt),
						),
					),
			)
		})

		// ------------------------------------------------------------------
		// Per-org poll
		// ------------------------------------------------------------------

		const pollOrg = Effect.fn("CloudflareAnalyticsService.pollOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			// A skip used to be silent — the reason only ever landed in the returned summary, which
			// nothing read for a plain tick. Annotating pollOrg's own span means every skip is now
			// visible on the trace even when the tick rollup below doesn't (yet) escalate it.
			const skip = (reason: string) =>
				Effect.annotateCurrentSpan({
					"maple.cloudflare.skip_reason": reason,
					"maple.cloudflare.calls": 0,
					"maple.cloudflare.rows_ingested": 0,
				}).pipe(
					Effect.as({
						orgId,
						skipped: reason,
						callsMade: 0,
						rowsIngested: 0,
						failures: [],
					} satisfies PollOrgSummary),
				)

			const now = yield* Clock.currentTimeMillis

			// One connection read resolves connected-ness, capability (scope), and a fresh token.
			const tokenResult = yield* Effect.result(oauth.getValidAccessToken(orgId))
			if (
				Result.isFailure(tokenResult) &&
				tokenResult.failure instanceof IntegrationsNotConnectedError
			) {
				return yield* skip("not connected")
			}

			// Claim the tick lease; the anchor row is created lazily the first time an org is polled.
			let claimed = yield* claimLease(orgId, now)
			if (claimed == null) {
				yield* ensureAccountRows(orgId, now)
				claimed = yield* claimLease(orgId, now)
			}
			if (claimed == null) return yield* skip("lease held by another tick")
			const anchor = claimed

			return yield* Effect.gen(function* () {
				// Token failures: revocation disables all rows until reconnect; transient upstream
				// failures record and retry next tick.
				if (Result.isFailure(tokenResult)) {
					const error = tokenResult.failure
					yield* recordOrgError(orgId, error.message, now, {
						disable: error instanceof IntegrationsRevokedError,
					})
					return yield* skip(`token unavailable: ${error._tag}`)
				}
				const { accessToken, accountId, scope } = tokenResult.success

				if (!hasAnalyticsScopes(scope)) {
					yield* recordOrgError(orgId, MISSING_SCOPES_ERROR, now)
					return yield* skip("missing analytics scopes")
				}

				// Zone discovery (REST pagination) is hourly-TTL'd on the anchor row; ticks in
				// between reuse the reconciled state rows.
				let rows: CloudflareAnalyticsStateRow[]
				let liveScripts = parseLiveScripts(anchor.liveScriptsJson)
				if (anchor.discoveredAt == null || now - anchor.discoveredAt.getTime() > DISCOVERY_TTL_MS) {
					const zonesResult = yield* Effect.result(listZones(accessToken, accountId, apiBaseUrl))
					if (Result.isFailure(zonesResult)) {
						const error = zonesResult.failure
						yield* recordOrgError(orgId, error.message, now, {
							disable: error instanceof IntegrationsRevokedError,
						})
						return yield* skip(`zone discovery failed: ${error._tag}`)
					}
					// Newly-registered account datasets get their rows on the discovery cadence —
					// before reconcileZones, whose loadStateRows picks them up for this tick.
					yield* ensureAccountRows(orgId, now)
					rows = yield* reconcileZones(orgId, zonesResult.success, anchor.id, now)
					// Script enumeration rides the same discovery TTL. It filters deleted scripts out of
					// the workers dataset; a failure (typically a pre-workers-scripts.read grant) degrades
					// open — emit everything rather than wedge the org, and keep the last known set.
					const scriptsResult = yield* Effect.result(
						listWorkerScripts(accessToken, accountId, apiBaseUrl),
					)
					if (Result.isFailure(scriptsResult)) {
						yield* Effect.logWarning("cloudflare-analytics script enumeration failed", {
							orgId,
							errorTag: scriptsResult.failure._tag,
							error: scriptsResult.failure.message,
						})
					} else {
						liveScripts = new Set(scriptsResult.success)
						yield* updateRows([anchor.id], {
							liveScriptsJson: JSON.stringify(scriptsResult.success),
							updatedAt: new Date(now),
						})
					}
					// Hyperdrive config inventory rides the same discovery TTL. It only feeds the
					// service map's "what sits behind Hyperdrive" resolution, so a failure (typically
					// a pre-hyperdrive-scope grant surfacing as IntegrationsRevokedError) degrades
					// open — log and keep the last-known rows, never disable the org's analytics.
					const hyperdriveResult = yield* Effect.result(
						listAccountHyperdriveConfigs(accessToken, accountId, apiBaseUrl),
					)
					if (Result.isFailure(hyperdriveResult)) {
						yield* Effect.logWarning("cloudflare-analytics hyperdrive discovery failed", {
							orgId,
							errorTag: hyperdriveResult.failure._tag,
							error: hyperdriveResult.failure.message,
						})
					} else {
						yield* reconcileHyperdriveConfigs(orgId, hyperdriveResult.success, now)
					}
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
					return yield* skip("ingest key unavailable")
				}
				const ingestKey = keyResult.success

				const rowsIngestedRef = yield* Ref.make(0)
				// Set when Cloudflare rejects the token mid-loop — every further call would 401 too.
				const revokedRef = yield* Ref.make(false)
				// Genuine dataset failures this tick (authz/upstream/revoked/other) — the seam pushes
				// here so the org summary carries a failure count and the tick can escalate.
				const datasetFailures: Array<DatasetPollFailure> = []

				// Round-based catch-up: every round advances each behind zone/dataset by one window;
				// loop until caught up or the call budget is spent (backfill resumes next tick).
				while (!(yield* Ref.get(revokedRef)) && budget.calls < MAX_CALLS_PER_ORG_TICK) {
					const work = buildWorkItems(rows, now)
					if (work.length === 0) break
					let progressed = false

					for (const item of work) {
						if (budget.calls >= MAX_CALLS_PER_ORG_TICK || (yield* Ref.get(revokedRef))) break
						budget.calls += 1
						const partResults = yield* pollDatasetChunk(
							item,
							{ orgId, accountId, accessToken, ingestKey, liveScripts },
							now,
						).pipe(
							Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
								// Stop this org's loop; the seam disables + records health org-wide.
								Ref.set(revokedRef, true).pipe(
									Effect.as(
										allPartsFailed(item, "revoked", error.message, {
											orgWide: true,
											disable: true,
										}),
									),
								),
							),
							Effect.catchTag("@maple/http/errors/IntegrationsUpstreamError", (error) =>
								Effect.succeed(allPartsFailed(item, "upstream", error.message)),
							),
						)

						// Mirror the DB writes onto the in-memory rows so the next round re-plans
						// without a per-round SELECT.
						for (const { part, outcome } of partResults) {
							yield* Match.value(outcome).pipe(
								Match.discriminatorsExhaustive("kind")({
									advanced: ({ ingested }) =>
										Ref.update(rowsIngestedRef, (count) => count + ingested).pipe(
											Effect.map(() => {
												progressed = true
												if (item.phase === "head") {
													const watermark = new Date(item.window.end)
													const seed = new Date(item.window.start)
													for (const row of part.rows) {
														row.watermarkAt = watermark
														// Seed the backfill frontier once (mirrors advanceHead's
														// isNull guard) so this tick's later rounds plan history.
														if (row.backfillAt == null) row.backfillAt = seed
													}
												} else {
													const frontier = new Date(item.window.start)
													for (const row of part.rows) row.backfillAt = frontier
												}
											}),
										),
									"quantiles-downgraded": () =>
										Effect.sync(() => {
											progressed = true
											for (const row of part.rows) row.quantilesAvailable = false
										}),
									disabled: () =>
										Effect.sync(() => {
											for (const row of part.rows) row.enabled = false
										}),
									// The one seam: record health to Postgres AND emit an observable signal.
									failed: ({ failure }) =>
										Effect.gen(function* () {
											if (failure.orgWide) {
												yield* recordOrgError(orgId, failure.message, now, {
													disable: failure.disable,
												})
												for (const row of rows)
													if (failure.disable) row.enabled = false
											} else {
												yield* recordError(failure.rowIds, failure.message, now, {
													disable: failure.disable,
												})
											}
											yield* observeDatasetFailure(orgId, failure)
											datasetFailures.push(failure)
										}),
								}),
							)
						}
					}

					if (!progressed) break
				}

				const rowsIngested = yield* Ref.get(rowsIngestedRef)
				// Metrics ship through the ingest gateway (see emitMetrics), so Autumn metering
				// happens there — no self-report here.
				yield* Effect.annotateCurrentSpan("maple.cloudflare.calls", budget.calls)
				yield* Effect.annotateCurrentSpan("maple.cloudflare.rows_ingested", rowsIngested)
				yield* Effect.annotateCurrentSpan("maple.cloudflare.dataset_failures", datasetFailures.length)
				return {
					orgId,
					skipped: null,
					callsMade: budget.calls,
					rowsIngested,
					failures: datasetFailures,
				} satisfies PollOrgSummary
			}).pipe(
				Effect.ensuring(
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((end) =>
							releaseLease(orgId, end).pipe(
								// The ensuring must never fail (that would mask whatever this tick actually
								// did), but a lease release failure is not nothing — it silently wedges the
								// org behind a lease until the corrupt-lease escape hatch reclaims it, so log
								// loudly instead of swallowing it via Effect.ignore.
								Effect.catchCause((cause) =>
									Effect.logWarning("cloudflare-analytics lease release failed", {
										orgId,
										error: Cause.pretty(cause),
									}),
								),
							),
						),
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
			const failuresRef = yield* Ref.make(0)
			// Every org's full summary, including skips — the outage that motivated this had 100%
			// of ticks skip silently for 31 hours because nothing outside pollOrg ever looked at
			// `summary.skipped`. Keeping the whole summary (not just counters) lets the rollup below
			// name which orgs are stuck and why.
			const summariesRef = yield* Ref.make<Array<PollOrgSummary>>([])
			yield* Effect.forEach(
				capable,
				(row) =>
					pollOrg(decodeOrgId(row.orgId)).pipe(
						Effect.tap((summary) =>
							Effect.all(
								[
									Ref.update(rowsIngestedRef, (count) => count + summary.rowsIngested),
									Ref.update(failuresRef, (count) => count + summary.failures.length),
									Ref.update(summariesRef, (list) => [...list, summary]),
								],
								{ discard: true },
							),
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
									}).pipe(
										// A crashed org must still appear in the rollup — otherwise perOrg
										// silently omits it, `skipped` undercounts, and the zero-rows warning
										// below can't see a crash-storm at all.
										Effect.andThen(
											Ref.update(summariesRef, (list) => [
												...list,
												{
													orgId: decodeOrgId(row.orgId),
													skipped:
														"org poll failed — see the warning log for the cause",
													callsMade: 0,
													rowsIngested: 0,
													failures: [],
												} satisfies PollOrgSummary,
											]),
										),
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY, discard: true },
			)
			const rowsIngested = yield* Ref.get(rowsIngestedRef)
			const failures = yield* Ref.get(failuresRef)
			const summaries = yield* Ref.get(summariesRef)
			const skipped = summaries.filter((summary) => summary.skipped != null).length
			const perOrg = summaries.map((summary) => ({
				orgId: summary.orgId,
				skipped: summary.skipped,
				callsMade: summary.callsMade,
				rowsIngested: summary.rowsIngested,
				failures: summary.failures.length,
			}))
			// Per-failure exception events + ERROR logs already fired in the seam; this is the
			// at-a-glance rollup so a failing tick doesn't read as a healthy "complete".
			if (failures > 0) {
				yield* Effect.logWarning("cloudflare-analytics tick completed with dataset failures", {
					failures,
					orgs: capable.length,
				})
			}
			// The outage that motivated this: every capable org skipped every tick, so rowsIngested
			// stayed 0 with no failures either — a tick that "completed" while doing nothing at all.
			// Surface that shape explicitly instead of relying on someone noticing a flat graph.
			// Gated on `skipped > 0` so a genuinely idle tick (orgs caught up / zero traffic —
			// zero rows with zero skips) stays quiet; crashed orgs count as skipped via the
			// synthetic summary above, and pure dataset failures already warn just before this.
			if (capable.length > 0 && rowsIngested === 0 && skipped > 0) {
				yield* Effect.logWarning("cloudflare-analytics tick ingested zero rows", {
					orgs: capable.length,
					skipped,
					reasons: summaries
						.filter((summary) => summary.skipped != null)
						.map((summary) => ({ orgId: summary.orgId, reason: summary.skipped })),
				})
			}
			return {
				orgs: capable.length,
				rowsIngested,
				failures,
				skipped,
				perOrg,
			} satisfies PollAllOrgsSummary
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

			const compiled = CH.compile(
				CH.cloudflareUsageQuery(),
				{
					orgId,
					bucketSeconds: USAGE_BUCKET_SECONDS,
					startTime: toWarehouseDateTime64(windowStart),
					endTime: toWarehouseDateTime64(now),
				},
				// Decode rows through the schema: `requests`/`datapoints` arrive as JSON
				// strings from a BYO-CH org's raw ClickHouse (`FORMAT JSON` quotes 64-bit
				// ints), and `CHNumber` coerces them centrally in `decodeRows`. Without it
				// the string trips a `ParseError` inside `CloudflareUsageBucket` → bare 500.
				{ rowSchema: CH.cloudflareUsageRowSchema },
			)
			// Metrics flow through the ingest gateway, which routes each org to the SAME
			// warehouse the gateway wrote to: a BYO-CH org's own ClickHouse when it is
			// write-ready, otherwise managed Tinybird (the gateway's fallback). Mirror
			// that decision here — pin to the ingest (Tinybird) config exactly when the
			// org is NOT write-ready. Reading the org's CH unconditionally would return
			// empty for drifted/not-ready BYO-CH orgs whose metrics landed in Tinybird.
			const clickHouseReady = yield* orgClickHouse.isWarehouseWriteReady(orgId).pipe(
				Effect.mapError(
					(error) =>
						new IntegrationsPersistenceError({
							message: `Failed to resolve warehouse readiness: ${error.message}`,
						}),
				),
			)
			const rows = yield* warehouse
				.compiledQuery(systemTenant(orgId), compiled, {
					profile: "aggregation",
					context: "cloudflareUsage",
					pinToIngestConfig: !clickHouseReady,
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
				// `requests`/`datapoints` are already decoded to numbers by
				// `cloudflareUsageRowSchema` (`CHNumber` coerces ClickHouse's
				// string-quoted 64-bit ints). Round requests since counts are integers.
				const requests = Math.round(row.requests)
				const datapoints = row.datapoints
				agg.buckets.push(
					new CloudflareUsageBucket({
						bucketStart: Date.parse(row.bucket),
						requests,
						datapoints,
					}),
				)
				agg.totalRequests += requests
				agg.totalDatapoints += datapoints
				const lastMs = Date.parse(row.lastTimeUnix)
				if (Number.isFinite(lastMs)) {
					agg.lastDataAt = agg.lastDataAt == null ? lastMs : Math.max(agg.lastDataAt, lastMs)
				}
				byService.set(row.serviceName, agg)
			}

			const SERVICE_KINDS: ReadonlyArray<readonly ["worker" | "queue" | "zone", string]> = [
				["worker", WORKER_SERVICE_PREFIX],
				["queue", QUEUE_SERVICE_PREFIX],
				["zone", ZONE_SERVICE_PREFIX],
			]
			const KIND_ORDER: Record<"zone" | "worker" | "queue", number> = { zone: 0, worker: 1, queue: 2 }
			const services = [...byService.entries()]
				.map(([serviceName, agg]) => {
					const match = SERVICE_KINDS.find(([, prefix]) => serviceName.startsWith(prefix))
					return new CloudflareServiceUsage({
						serviceName,
						kind: match?.[0] ?? ("zone" as const),
						displayName: match ? serviceName.slice(match[1].length) : serviceName,
						totalRequests: agg.totalRequests,
						totalDatapoints: agg.totalDatapoints,
						lastDataAt: agg.lastDataAt,
						buckets: agg.buckets,
					})
				})
				.sort((a, b) =>
					a.kind === b.kind
						? a.displayName.localeCompare(b.displayName)
						: KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
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

		/**
		 * Recovery hook for reconnect: clears the disabled/error state a revoked-token error left
		 * behind and forces zone re-discovery on the next tick (so any zone that vanished while
		 * disconnected is immediately re-disabled again by the reconcile, rather than reappearing
		 * as falsely healthy). Reconnecting writes fresh tokens, but rows disabled by
		 * `recordOrgError(..., { disable: true })` would otherwise stay dead forever — zone rows
		 * recover via the discovery reconcile once polling resumes, but the account-scoped workers
		 * anchor row has no other re-enable path.
		 */
		const resetOrgState = Effect.fn("CloudflareAnalyticsService.resetOrgState")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db
					.update(cloudflareAnalyticsState)
					.set({
						enabled: true,
						lastError: null,
						lastErrorAt: null,
						discoveredAt: null,
						leaseUntil: null,
						updatedAt: new Date(now),
					})
					.where(eq(cloudflareAnalyticsState.orgId, orgId)),
			)
		})

		return {
			pollAllOrgs,
			pollOrg,
			getStatus,
			getIntegrationStatus,
			getUsage,
			listHyperdriveConfigs: listHyperdriveConfigsForOrg,
			resetOrgState,
		} satisfies CloudflareAnalyticsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

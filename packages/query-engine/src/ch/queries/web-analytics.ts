// ---------------------------------------------------------------------------
// Web Analytics Queries
//
// Product analytics over the browser SDK's session data: unique visitors, page
// views, top pages, acquisition (referrer / UTM), and audience breakdowns
// (country / device / browser / OS / language).
//
// ## Two tables, and three coverage tiers
//
// These queries deliberately read from *both* session tables, because neither
// one alone can answer the page. What matters is that the columns fall into
// three tiers of coverage, and conflating them produces numbers that contradict
// each other on screen:
//
//  1. **`session_events` with `Type = 'navigation'`** — one row per page view,
//     for every session across every SDK build. Knows only SessionId, Timestamp
//     and Url. This is the widest-coverage source there is, and where page views
//     and top pages come from.
//  2. **`session_replays` base columns** — `BrowserName`, `OsName`,
//     `DeviceType`, `Country`, `DurationMs`. Predate migration 0011 and are
//     populated for essentially every session. (`Country` has its own gap: it is
//     derived at the ingest gateway from `Cf-IPCountry` and only when the
//     gateway is configured to trust that header, so it is `''` for traffic
//     received before that was enabled and is never backfilled.)
//  3. **`session_replays` analytics block** (migration 0011) — `VisitorId`,
//     `VisitorIsNew`, `Referrer`, `ReferrerHost`, `Utm*`, `Host`, `EntryPath`,
//     `ExitPath`, `Language`, and in practice `PageViews`. Only sessions from an
//     SDK build that posts the block populate these. Measured against production
//     at the time of writing: one org of seven, ~18% of sessions.
//
// So a page-view count and a visitor count on the same screen describe different
// populations, and the UI is expected to say which — `webAnalyticsSummaryQuery`
// returns `identifiedSessions` alongside `sessions` precisely so the page can
// report the covered share instead of presenting a partial count as the whole.
// Tier 2 needs no such caveat, and attaching one to it is its own bug.
//
// ## ReplacingMergeTree counting
//
// The SDK writes a session twice: Version=1 at session start, Version=2 at
// session end. Reads can see both rows before a background merge collapses
// them, so **every count over `session_replays` here is `uniq`/`uniqIf` on
// SessionId, never `count`/`countIf`** — the same rule
// `sessionReplaysFacetsQuery` follows. `sum(PageViews)` is the one exception and
// is *not* used for the page-view metric for exactly this reason; page views
// come from the append-only `session_events` instead.
//
// Filters only touch version-invariant columns. Every analytics column
// qualifies (the SDK writes them on both the v1 and v2 row — see the invariant
// documented in packages/browser-session/src/meta-row.ts), so they are safe in
// WHERE; the DSL has no HAVING.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param, from, inSubquery, unionAll, compileFnCall } from "@maple-dev/clickhouse-builder"
import type { ColumnAccessor, CHQuery, CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { SessionReplays, SessionEvents } from "../tables"
import type { FacetOutput } from "./query-helpers"

/** The `session_events.Type` value the SDK emits once per page view. */
const NAVIGATION = "navigation"

// assumeNotNull(x) — drops the Nullable wrapper for a caller whose WHERE (or, as
// below, whose `-If` condition) already excludes the NULLs. Generic per call
// site, so declared here rather than via defineFn — same as session-replays.ts.
function assumeNotNull<T>(value: CH.Expr<T | null>): CH.Expr<T> {
	return compileFnCall<T>("assumeNotNull", value)
}

// ifNotFinite(x, fallback) — avg() over an empty set yields nan, which would
// then decode as null through a numeric row schema.
function ifNotFinite(value: CH.Expr<number>, fallback: number): CH.Expr<number> {
	return compileFnCall<number>("ifNotFinite", value, CH.lit(fallback))
}

// ---------------------------------------------------------------------------
// Shared filter surface
// ---------------------------------------------------------------------------

/**
 * The URL-driven filter surface, shared by every query on the page so a facet
 * click narrows all of them identically.
 *
 * `host` / `pagePath` are the two that `session_events` can serve directly off
 * `Url`, and they reach `session_replays` through
 * {@link navigationSessionsSubquery}. The rest are `session_replays` columns and
 * reach `session_events` through {@link matchingSessionsSubquery} — the same
 * semi-join in the other direction.
 */
export interface WebAnalyticsFilters {
	readonly host?: string
	readonly pagePath?: string
	readonly referrerHost?: string
	readonly country?: string
	readonly deviceType?: string
	readonly browserName?: string
	readonly osName?: string
	readonly language?: string
	readonly utmSource?: string
	readonly utmMedium?: string
	readonly utmCampaign?: string
	/** `new` keeps first-ever sessions for a visitor, `returning` the rest. */
	readonly visitorType?: "new" | "returning"
}

/** Which `session_replays` dimensions a facet branch can exclude from its own WHERE. */
export type WebAnalyticsFacetKey =
	| "referrerHost"
	| "country"
	| "deviceType"
	| "browserName"
	| "osName"
	| "language"
	| "utmSource"
	| "utmMedium"
	| "utmCampaign"
	| "entryPath"
	| "exitPath"
	| "host"

type ReplaysAccessor = ColumnAccessor<typeof SessionReplays.columns>

/**
 * `SELECT SessionId FROM session_events WHERE <navigation matching host/path>` —
 * which sessions actually viewed the filtered page or site.
 *
 * This is how the `host` and `pagePath` filters reach `session_replays`, and it
 * is a semi-join rather than an `EntryPath = …` predicate for a reason.
 * `EntryPath`, `ExitPath` and `Host` are all part of the migration-0011
 * analytics block, so on an org whose SDK build predates it they are `''` for
 * every row — filtering them made the KPI rail report **0 sessions** directly
 * beside a top-pages panel showing 27k page views for the very page being
 * filtered on. `session_events` has no such gap, and "sessions that viewed this
 * page" is the better definition anyway: entering or exiting on a page is a
 * narrower thing than visiting it.
 *
 * `only` restricts which of the two filters the subquery honours, so a facet
 * branch can exclude its own dimension (see `replaysWhere`).
 */
function navigationSessionsSubquery(filters: WebAnalyticsFilters, only?: "host" | "pagePath") {
	return from(SessionEvents)
		.select(($) => ({ sessionId: $.SessionId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.Type.eq(NAVIGATION),
			only === "pagePath" ? undefined : CH.when(filters.host, (v: string) => CH.domain_($.Url).eq(v)),
			only === "host" ? undefined : CH.when(filters.pagePath, (v: string) => CH.path_($.Url).eq(v)),
		])
		.groupBy("sessionId")
}

/**
 * WHERE conditions for `session_replays`.
 *
 * `exclude` drops one dimension's own equality filter so its facet branch
 * doesn't collapse to the single selected value — the sidebar has to keep
 * offering the alternatives.
 */
function replaysWhere(
	$: ReplaysAccessor,
	filters: WebAnalyticsFilters,
	exclude?: WebAnalyticsFacetKey,
): Array<CH.Condition | undefined> {
	// `host` and `pagePath` both narrow through one navigation semi-join rather
	// than two, so a page filter and a site filter compose into "sessions that
	// viewed this path on this host" instead of two independent session sets.
	// A facet branch drops its own dimension from the subquery; when that leaves
	// nothing to match on, the subquery isn't built at all.
	const wantsHost = filters.host !== undefined && exclude !== "host"
	const wantsPath = filters.pagePath !== undefined && exclude !== "entryPath" && exclude !== "exitPath"
	const navigationFilter =
		wantsHost || wantsPath
			? inSubquery(
					$.SessionId,
					navigationSessionsSubquery(
						filters,
						wantsHost && wantsPath ? undefined : wantsHost ? "host" : "pagePath",
					),
				)
			: undefined

	return [
		$.OrgId.eq(param.string("orgId")),
		$.StartTime.gte(param.dateTime("startTime")),
		$.StartTime.lte(param.dateTime("endTime")),
		navigationFilter,
		exclude === "referrerHost"
			? undefined
			: CH.when(filters.referrerHost, (v: string) => $.ReferrerHost.eq(v)),
		exclude === "country" ? undefined : CH.when(filters.country, (v: string) => $.Country.eq(v)),
		exclude === "deviceType" ? undefined : CH.when(filters.deviceType, (v: string) => $.DeviceType.eq(v)),
		exclude === "browserName"
			? undefined
			: CH.when(filters.browserName, (v: string) => $.BrowserName.eq(v)),
		exclude === "osName" ? undefined : CH.when(filters.osName, (v: string) => $.OsName.eq(v)),
		exclude === "language" ? undefined : CH.when(filters.language, (v: string) => $.Language.eq(v)),
		exclude === "utmSource" ? undefined : CH.when(filters.utmSource, (v: string) => $.UtmSource.eq(v)),
		exclude === "utmMedium" ? undefined : CH.when(filters.utmMedium, (v: string) => $.UtmMedium.eq(v)),
		exclude === "utmCampaign"
			? undefined
			: CH.when(filters.utmCampaign, (v: string) => $.UtmCampaign.eq(v)),
		CH.when(filters.visitorType, (v: "new" | "returning") =>
			v === "new" ? $.VisitorIsNew.eq(1) : $.VisitorIsNew.eq(0),
		),
	]
}

/** True when any filter can only be evaluated against `session_replays`. */
function needsSessionSemiJoin(filters: WebAnalyticsFilters): boolean {
	return Boolean(
		filters.referrerHost ||
		filters.country ||
		filters.deviceType ||
		filters.browserName ||
		filters.osName ||
		filters.language ||
		filters.utmSource ||
		filters.utmMedium ||
		filters.utmCampaign ||
		filters.visitorType,
	)
}

/**
 * `SELECT SessionId FROM session_replays WHERE <visitor-level filters>` — the
 * semi-join that carries a `session_replays` dimension filter over to
 * `session_events`, mirroring how `sessionReplaysListQuery` semi-joins
 * `sessionEventMatchQuery` in the other direction.
 *
 * `host` and `pagePath` are deliberately left out, which also keeps this from
 * recursing into `navigationSessionsSubquery`: `session_events` filters both
 * directly off `Url`, and routing them through `session_replays` would silently
 * drop the sessions with no analytics block from the page-view numbers.
 */
function matchingSessionsSubquery(filters: WebAnalyticsFilters) {
	return from(SessionReplays)
		.select(($) => ({ sessionId: $.SessionId }))
		.where(($) => replaysWhere($, { ...filters, host: undefined, pagePath: undefined }))
		.groupBy("sessionId")
}

/**
 * WHERE conditions for the page-view queries over `session_events`.
 *
 * `Type = 'navigation'` is served by the `idx_type` set(16) skip index, and the
 * `Timestamp` bounds prune `PARTITION BY toDate(Timestamp)` — `Timestamp` sits
 * third in the sorting key, so partition pruning is what keeps this cheap.
 */
function navigationWhere(
	$: ColumnAccessor<typeof SessionEvents.columns>,
	filters: WebAnalyticsFilters,
): Array<CH.Condition | undefined> {
	return [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		$.Type.eq(NAVIGATION),
		CH.when(filters.host, (v: string) => CH.domain_($.Url).eq(v)),
		CH.when(filters.pagePath, (v: string) => CH.path_($.Url).eq(v)),
		needsSessionSemiJoin(filters)
			? inSubquery($.SessionId, matchingSessionsSubquery(filters))
			: undefined,
	]
}

// ---------------------------------------------------------------------------
// Summary KPIs
// ---------------------------------------------------------------------------

export interface WebAnalyticsSummaryOutput {
	/** Distinct persistent browser ids. 0 when no session carries the analytics block. */
	readonly visitors: number
	/** Distinct sessions — the denominator the UI compares `visitors` against. */
	readonly sessions: number
	/** Sessions whose visitor id had never been seen before, per the client's assertion. */
	readonly newSessions: number
	/**
	 * Sessions with at most one page view, **among identified sessions only** —
	 * divide by `identifiedSessions`, not `sessions`. See the query for why.
	 */
	readonly bouncedSessions: number
	/** Sessions carrying a VisitorId, i.e. the analytics-block coverage numerator. */
	readonly identifiedSessions: number
	/** Mean wall-clock session duration in ms over sessions that ended. */
	readonly avgDurationMs: number
}

/**
 * One row of headline numbers over `session_replays`.
 *
 * Page views are absent on purpose — they come from
 * {@link webAnalyticsPageviewsTimeseriesQuery}, whose coverage is far wider than
 * this table's `PageViews` column. Summing `PageViews` here would also
 * double-count across the v1/v2 rows of an un-merged session.
 *
 * `bouncedSessions` is gated on `VisitorId != ''` — the same predicate as
 * `identifiedSessions`, and load-bearing rather than decorative. `PageViews` is
 * part of the migration-0011 analytics block, so a session from an older SDK
 * build reports `PageViews = 0`; counting those as bounces reported a **100%
 * bounce rate** for an org whose top-pages panel, read from `session_events` on
 * the very same page, plainly showed multi-page sessions. Bounce is only
 * measurable over the population that reports page views, so the numerator and
 * the denominator (`identifiedSessions`) are both confined to it.
 *
 * Within that population `PageViews <= 1` rather than `= 1`, so a session whose
 * only row is still the v1 start row counts as a bounce instead of vanishing
 * from both sides of the ratio.
 */
export function webAnalyticsSummaryQuery(
	filters: WebAnalyticsFilters = {},
): CHQuery<any, WebAnalyticsSummaryOutput, any> {
	return from(SessionReplays)
		.select(($) => ({
			visitors: CH.uniqIf($.VisitorId, $.VisitorId.neq("")),
			sessions: CH.uniq($.SessionId),
			newSessions: CH.uniqIf($.SessionId, $.VisitorIsNew.eq(1)),
			bouncedSessions: CH.uniqIf($.SessionId, $.PageViews.lte(1).and($.VisitorId.neq(""))),
			identifiedSessions: CH.uniqIf($.SessionId, $.VisitorId.neq("")),
			// avgIf over the ended rows only: the v1 row's DurationMs is NULL, and
			// including it would average NULLs into the result.
			avgDurationMs: CH.round_(
				ifNotFinite(CH.avgIf(assumeNotNull($.DurationMs), $.DurationMs.gt(0)), 0),
			),
		}))
		.where(($) => replaysWhere($, filters))
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Visitor timeseries
// ---------------------------------------------------------------------------

export interface WebAnalyticsTimeseriesOpts extends WebAnalyticsFilters {
	readonly bucketSeconds?: number
}

export interface WebAnalyticsTimeseriesOutput {
	readonly bucket: string
	readonly visitors: number
	readonly sessions: number
	readonly newSessions: number
}

/**
 * Visitors / sessions / new sessions per bucket, from `session_replays`.
 *
 * Bucketed on `StartTime`, so a session lands in the bucket it began in rather
 * than being smeared across the buckets it spanned. That matches how every
 * comparable product counts a session and keeps the branch a flat aggregate.
 */
export function webAnalyticsTimeseriesQuery(
	opts: WebAnalyticsTimeseriesOpts = {},
): CHQuery<any, WebAnalyticsTimeseriesOutput, any> {
	const bucketSeconds = opts.bucketSeconds ?? 3600
	return from(SessionReplays)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.StartTime, bucketSeconds),
			visitors: CH.uniqIf($.VisitorId, $.VisitorId.neq("")),
			sessions: CH.uniq($.SessionId),
			newSessions: CH.uniqIf($.SessionId, $.VisitorIsNew.eq(1)),
		}))
		.where(($) => replaysWhere($, opts))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Page-view timeseries
// ---------------------------------------------------------------------------

export interface WebAnalyticsPageviewsTimeseriesOpts extends WebAnalyticsFilters {
	readonly bucketSeconds?: number
}

export interface WebAnalyticsPageviewsTimeseriesOutput {
	readonly bucket: string
	readonly pageViews: number
	readonly sessions: number
}

/**
 * Page views per bucket from `session_events` navigation rows — a plain
 * `count()`, since that table is an append-only MergeTree with no duplicate
 * rows to guard against.
 *
 * Its own query rather than a branch of {@link webAnalyticsTimeseriesQuery}
 * because it reads a different table with a different time column and a
 * narrower filter surface.
 */
export function webAnalyticsPageviewsTimeseriesQuery(
	opts: WebAnalyticsPageviewsTimeseriesOpts = {},
): CHQuery<any, WebAnalyticsPageviewsTimeseriesOutput, any> {
	const bucketSeconds = opts.bucketSeconds ?? 3600
	return from(SessionEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, bucketSeconds),
			pageViews: CH.count(),
			sessions: CH.uniq($.SessionId),
		}))
		.where(($) => navigationWhere($, opts))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Top pages
// ---------------------------------------------------------------------------

export interface WebAnalyticsPagesOpts extends WebAnalyticsFilters {
	readonly limit?: number
}

export interface WebAnalyticsPagesOutput {
	readonly host: string
	readonly pagePath: string
	readonly pageViews: number
	readonly sessions: number
}

/**
 * Most-viewed pages, grouped by `domain(Url)` + `path(Url)`.
 *
 * `path()` returns the pathname only — query string and fragment are already
 * excluded — so grouping on it cannot leak query-parameter PII into a
 * dimension list. Rows whose Url failed to parse (`domain` = '') are dropped
 * rather than collapsed into a blank row.
 */
export function webAnalyticsPagesQuery(
	opts: WebAnalyticsPagesOpts = {},
): CHQuery<any, WebAnalyticsPagesOutput, any> {
	return from(SessionEvents)
		.select(($) => ({
			host: CH.domain_($.Url),
			pagePath: CH.path_($.Url),
			pageViews: CH.count(),
			sessions: CH.uniq($.SessionId),
		}))
		.where(($) => [...navigationWhere($, opts), CH.domain_($.Url).neq("")])
		.groupBy("host", "pagePath")
		.orderBy(["pageViews", "desc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Dimension breakdowns (UNION ALL fan-out)
// ---------------------------------------------------------------------------

export type WebAnalyticsBreakdownsOpts = WebAnalyticsFilters & {
	/** Rows per dimension. Defaults to 50 — enough for a sidebar, small enough to stay cheap. */
	readonly limitPerDimension?: number
}

export type WebAnalyticsBreakdownsOutput = FacetOutput

/**
 * Every audience and acquisition dimension in one round trip, shaped
 * `{ name, count, facetType }` like the other facet queries so the web side can
 * decode it with the shared `extractFacets` helper.
 *
 * Two rules per branch, both inherited from `sessionReplaysFacetsQuery`:
 * `.neq("")` drops sessions that never populated the column (so a dimension
 * nobody sends renders as empty rather than as one giant blank row), and the
 * branch excludes its own filter so selecting a value leaves the alternatives
 * visible.
 *
 * `ReferrerHost = ''` is dropped here along with the rest. That is not a lost
 * "direct traffic" bucket — per the schema comment it also covers internal
 * navigation and `Referrer-Policy`-suppressed referrers, so it is not a
 * meaningful row to show. UTM is the reliable acquisition signal.
 */
export function webAnalyticsBreakdownsQuery(
	opts: WebAnalyticsBreakdownsOpts = {},
): CHUnionQuery<WebAnalyticsBreakdownsOutput> {
	const limit = opts.limitPerDimension ?? 50

	const makeFacet = (facetType: WebAnalyticsFacetKey, column: ($: ReplaysAccessor) => CH.Expr<string>) =>
		from(SessionReplays)
			.select(($) => ({
				name: column($),
				// uniq(SessionId), not count(): the v1/v2 rows of an un-merged session
				// would otherwise weight it twice in every dimension.
				count: CH.uniq($.SessionId),
				facetType: CH.lit(facetType),
			}))
			.where(($) => [...replaysWhere($, opts, facetType), column($).neq("")])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)

	return unionAll(
		makeFacet("referrerHost", ($) => $.ReferrerHost),
		makeFacet("country", ($) => $.Country),
		makeFacet("deviceType", ($) => $.DeviceType),
		makeFacet("browserName", ($) => $.BrowserName),
		makeFacet("osName", ($) => $.OsName),
		makeFacet("language", ($) => $.Language),
		makeFacet("utmSource", ($) => $.UtmSource),
		makeFacet("utmMedium", ($) => $.UtmMedium),
		makeFacet("utmCampaign", ($) => $.UtmCampaign),
		makeFacet("entryPath", ($) => $.EntryPath),
		makeFacet("exitPath", ($) => $.ExitPath),
		makeFacet("host", ($) => $.Host),
	).format("JSON")
}

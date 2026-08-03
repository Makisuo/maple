// ---------------------------------------------------------------------------
// Cloudflare zone filters
//
// The Cloudflare poller stores dimensions as SLICES, not a cube. Each breakdown
// metric carries exactly one dimension (`cloudflare.http.requests.by_path` has a
// path and nothing else), because folding path × host × cacheStatus × status into
// one series would multiply cardinality past what the metrics sorting key can
// carry — see `httpPathsSelection` in the poller for the full argument.
//
// The consequence has to be modelled, not papered over: a path filter genuinely
// cannot narrow the cache-status chart, and nothing at all narrows the latency
// gauges (they carry only `quantile`). {@link CF_FILTERABLE} is that fact encoded
// as data. Every query passes its metric family's row, inapplicable keys are
// dropped here, and the handler reports them back as `ignoredFilters` so the UI
// can mark that panel zone-wide rather than silently lying about its scope.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { MetricsGauge, MetricsSum } from "@maple/query-engine/ch/tables"

/** Filter key → the metric attribute it lives on. */
export const CF_ATTR = {
	host: "server.address",
	cacheStatus: "cache.status",
	statusClass: "http.status_class",
	path: "url.path",
	country: "geo.country_iso_code",
	method: "http.request.method",
	protocol: "network.protocol.version",
	deviceType: "cloudflare.device.type",
	firewallAction: "firewall.action",
	firewallSource: "firewall.source",
	firewallRuleId: "firewall.rule_id",
	dnsQueryName: "dns.query_name",
	dnsResponseCode: "dns.response_code",
} as const

export type CfFilterKey = keyof typeof CF_ATTR

export const CF_METRIC = {
	requests: "cloudflare.http.requests",
	bytes: "cloudflare.http.bytes",
	visits: "cloudflare.http.visits",
	edgeTtfb: "cloudflare.http.edge.ttfb",
	originDuration: "cloudflare.http.origin.duration",
	requestsByPath: "cloudflare.http.requests.by_path",
	errorsByPath: "cloudflare.http.errors.by_path",
	bytesByPath: "cloudflare.http.bytes.by_path",
	requestsByCountry: "cloudflare.http.requests.by_country",
	bytesByCountry: "cloudflare.http.bytes.by_country",
	requestsByClient: "cloudflare.http.requests.by_client",
	firewallEvents: "cloudflare.firewall.events",
	dnsQueries: "cloudflare.dns.queries",
} as const

const HTTP_CUBE_KEYS = ["host", "cacheStatus", "statusClass"] as const satisfies ReadonlyArray<CfFilterKey>

/**
 * Which filter keys actually exist as attributes on each metric family. A key absent from a
 * family's list is inapplicable, not ignorable — see the module header.
 */
export const CF_FILTERABLE: Record<string, ReadonlyArray<CfFilterKey>> = {
	[CF_METRIC.requests]: HTTP_CUBE_KEYS,
	[CF_METRIC.bytes]: HTTP_CUBE_KEYS,
	[CF_METRIC.visits]: HTTP_CUBE_KEYS,
	// Latency arrives as zone-level quantiles: per-(host, status) percentiles cannot be honestly
	// re-aggregated, so the poller asks Cloudflare for the zone number and nothing narrows it.
	[CF_METRIC.edgeTtfb]: [],
	[CF_METRIC.originDuration]: [],
	[CF_METRIC.requestsByPath]: ["path"],
	[CF_METRIC.errorsByPath]: ["path"],
	[CF_METRIC.bytesByPath]: ["path"],
	[CF_METRIC.requestsByCountry]: ["country"],
	[CF_METRIC.bytesByCountry]: ["country"],
	[CF_METRIC.requestsByClient]: ["method", "protocol", "deviceType"],
	[CF_METRIC.firewallEvents]: ["host", "firewallAction", "firewallSource", "firewallRuleId"],
	[CF_METRIC.dnsQueries]: ["dnsQueryName", "dnsResponseCode"],
}

export interface CloudflareFilterOpts {
	readonly hosts?: ReadonlyArray<string>
	readonly cacheStatuses?: ReadonlyArray<string>
	readonly statusClasses?: ReadonlyArray<string>
	readonly paths?: ReadonlyArray<string>
	/** Case-insensitive substring match on the stored path — the "everything under /api" affordance. */
	readonly pathContains?: string
	readonly countries?: ReadonlyArray<string>
	readonly methods?: ReadonlyArray<string>
	readonly protocols?: ReadonlyArray<string>
	readonly deviceTypes?: ReadonlyArray<string>
	readonly firewallActions?: ReadonlyArray<string>
	readonly firewallSources?: ReadonlyArray<string>
	readonly firewallRuleIds?: ReadonlyArray<string>
	readonly dnsQueryNames?: ReadonlyArray<string>
	readonly dnsResponseCodes?: ReadonlyArray<string>
}

/** Filter key → the option field carrying its values, so both directions stay in one table. */
const VALUES_BY_KEY: Record<CfFilterKey, keyof CloudflareFilterOpts> = {
	host: "hosts",
	cacheStatus: "cacheStatuses",
	statusClass: "statusClasses",
	path: "paths",
	country: "countries",
	method: "methods",
	protocol: "protocols",
	deviceType: "deviceTypes",
	firewallAction: "firewallActions",
	firewallSource: "firewallSources",
	firewallRuleId: "firewallRuleIds",
	dnsQueryName: "dnsQueryNames",
	dnsResponseCode: "dnsResponseCodes",
}

const FILTER_KEYS = Object.keys(VALUES_BY_KEY) as ReadonlyArray<CfFilterKey>

const valuesFor = (opts: CloudflareFilterOpts, key: CfFilterKey): ReadonlyArray<string> => {
	const value = opts[VALUES_BY_KEY[key]]
	return Array.isArray(value) ? value : []
}

/** Whether the caller asked for anything at all under this key. */
const isRequested = (opts: CloudflareFilterOpts, key: CfFilterKey): boolean =>
	valuesFor(opts, key).length > 0 || (key === "path" && (opts.pathContains ?? "") !== "")

/**
 * Both metrics tables declare `Attributes` as `Map(String, String)`, so one accessor type serves
 * `metrics_sum` and `metrics_gauge` alike.
 */
export type CloudflareMetricsAccessor =
	| ColumnAccessor<typeof MetricsSum.columns>
	| ColumnAccessor<typeof MetricsGauge.columns>

/**
 * Transitional host accessor: the poller emitted `http.host` before 2026-07-24 (commit 46ee9b129)
 * and `server.address` after. Pre-rename rows age out with the 90d metrics TTL — DELETE THIS
 * COALESCE AFTER 2026-10-24 and read `server.address` directly, here and in every caller. Same
 * precedence the trace MVs use (`packages/domain/src/tinybird/materializations.ts`).
 *
 * Grouping and filtering must go through the *same* expression, or a host picked off a chart built
 * on legacy rows would filter to nothing.
 */
export const cloudflareHostAttr = ($: CloudflareMetricsAccessor): CH.Expr<string> =>
	CH.if_(
		$.Attributes.get(CF_ATTR.host).neq(""),
		$.Attributes.get(CF_ATTR.host),
		$.Attributes.get("http.host"),
	)

/** The expression a filter key matches against — `host` is transitional, everything else is direct. */
const attrExpr = ($: CloudflareMetricsAccessor, key: CfFilterKey): CH.Expr<string> =>
	key === "host" ? cloudflareHostAttr($) : $.Attributes.get(CF_ATTR[key])

/**
 * Attribute predicates for one metric family.
 *
 * @param applicable that family's row from {@link CF_FILTERABLE} — keys outside it are dropped, so
 *   a path filter can never silently zero out a chart built on a family without paths.
 * @param exclude a facet query passes its own key so the facet still lists all of its options,
 *   narrowed only by the *other* dimensions. (`podFacetsQuery` does not do this, which is why
 *   selecting one pod there hides its siblings.)
 */
export const cloudflareFilterConditions = (
	$: CloudflareMetricsAccessor,
	opts: CloudflareFilterOpts,
	applicable: ReadonlyArray<CfFilterKey>,
	exclude?: CfFilterKey,
): Array<CH.Condition | undefined> => {
	const active = (key: CfFilterKey) => applicable.includes(key) && key !== exclude
	const conditions: Array<CH.Condition | undefined> = FILTER_KEYS.map((key) => {
		const values = valuesFor(opts, key)
		return active(key) && values.length > 0 ? CH.inList(attrExpr($, key), values) : undefined
	})
	// `CH.when` only skips null/undefined, so an empty needle would compile to a match-everything
	// predicate — noise in the SQL and a needless change to the query fingerprint.
	if (active("path") && (opts.pathContains ?? "") !== "") {
		conditions.push(CH.positionCaseInsensitive(attrExpr($, "path"), CH.lit(opts.pathContains!)).gt(0))
	}
	return conditions
}

/** Keys the caller asked for that this metric family has no attribute for. */
export const cloudflareIgnoredFilters = (
	opts: CloudflareFilterOpts,
	applicable: ReadonlyArray<CfFilterKey>,
): ReadonlyArray<CfFilterKey> =>
	FILTER_KEYS.filter((key) => isRequested(opts, key) && !applicable.includes(key))

/** Union of {@link cloudflareIgnoredFilters} across every family a panel reads, in table order. */
export const cloudflareIgnoredFiltersFor = (
	opts: CloudflareFilterOpts,
	metricNames: ReadonlyArray<string>,
): ReadonlyArray<CfFilterKey> => {
	const applicable = new Set(metricNames.flatMap((name) => CF_FILTERABLE[name] ?? []))
	return FILTER_KEYS.filter((key) => isRequested(opts, key) && !applicable.has(key))
}

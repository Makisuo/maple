// Pure derivations for the dashboards list rows. Everything here reads only the
// decoded `Dashboard` the list already holds — no queries, no extra plumbing.
// The `Dashboard`-shaped counterpart to templates/template-summary.ts.

import type { DashboardSortOption } from "@/atoms/dashboard-preferences-atoms"
import type { Dashboard } from "@/components/dashboard-builder/types"
import { dataSourceEndpoint, dataSourceQuerySet, dataSourceRawSql } from "@maple/widgets/dashboard"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const widgetCountLabel = (dashboard: Dashboard): string =>
	plural(dashboard.widgets.length, "widget", "widgets")

/**
 * Domain labels for the "reads from" lane, in the order they are shown. Keyed by
 * `dataSource.endpoint` — the registry in data-source-registry.ts maps endpoints
 * to server functions but carries no labels, so this is the one place that
 * decides how an endpoint reads to a human.
 *
 * Only CURATED routes are keyed here. A query-builder widget's domain comes from
 * the signal its drafts actually read ({@link DRAFT_SOURCE_DOMAIN}), and raw SQL
 * from {@link dataSourceRawSql} — both structural, so they keep working once the
 * stored data source has no endpoint to key on.
 *
 * `markdown_static` is deliberately absent: a markdown widget reads from
 * nothing, so it is ignored here unless it is *all* a dashboard has, which
 * {@link readsFromLabel} reports as "static only".
 */
export const ENDPOINT_DOMAIN: Record<string, DashboardDomain> = {
	list_traces: "Traces",
	traces_facets: "Traces",
	traces_duration_stats: "Traces",
	service_overview: "Traces",
	service_overview_time_series: "Traces",
	service_apdex_time_series: "Traces",
	services_facets: "Traces",
	service_usage: "Traces",
	list_logs: "Logs",
	logs_count: "Logs",
	logs_facets: "Logs",
	errors_summary: "Errors",
	errors_by_type: "Errors",
	error_detail_traces: "Errors",
	errors_facets: "Errors",
	error_rate_by_service: "Errors",
	list_metrics: "Metrics",
	metrics_summary: "Metrics",
	custom_timeseries: "Metrics",
	custom_breakdown: "Metrics",
}

/**
 * A query-builder draft's signal, as a domain.
 *
 * This is also a correction: the three `custom_query_builder_*` endpoints used
 * to be keyed to "Metrics" wholesale, so a dashboard of trace charts built in
 * the query builder advertised itself as reading metrics. The draft knows.
 */
const DRAFT_SOURCE_DOMAIN: Record<string, DashboardDomain> = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
}

export type DashboardDomain = "Traces" | "Logs" | "Errors" | "Metrics" | "Raw SQL"

/** Display order, so two dashboards reading the same signals label identically. */
const DOMAIN_ORDER: ReadonlyArray<DashboardDomain> = ["Traces", "Logs", "Errors", "Metrics", "Raw SQL"]

/** How many domains the lane shows before folding the rest into "+N". */
const MAX_DOMAIN_TERMS = 2

/** Every domain one widget reads. A multi-query chart can read more than one. */
const widgetDomains = (dataSource: unknown): ReadonlyArray<DashboardDomain> => {
	if (dataSourceRawSql(dataSource) !== null) return ["Raw SQL"]

	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null) {
		const domains: DashboardDomain[] = []
		for (const query of querySet.queries) {
			const domain = DRAFT_SOURCE_DOMAIN[query?.dataSource]
			if (domain) domains.push(domain)
		}
		return domains
	}

	const endpoint = dataSourceEndpoint(dataSource)
	const domain = endpoint === null ? undefined : ENDPOINT_DOMAIN[endpoint]
	return domain ? [domain] : []
}

export const dashboardDomains = (dashboard: Dashboard): ReadonlyArray<DashboardDomain> => {
	const found = new Set<DashboardDomain>()
	for (const widget of dashboard.widgets) {
		for (const domain of widgetDomains(widget.dataSource)) found.add(domain)
	}
	return DOMAIN_ORDER.filter((domain) => found.has(domain))
}

/** True when the dashboard has widgets but none of them read any signal. */
export const isStaticOnly = (dashboard: Dashboard): boolean =>
	dashboard.widgets.length > 0 && dashboardDomains(dashboard).length === 0

/**
 * "Metrics", "Traces · Logs", "Traces · Logs +1", or the absence vocabulary:
 * "static only" for a markdown-only dashboard, an em dash for an empty one.
 * `full` is the untruncated list for the lane's `title`.
 */
export function readsFromLabel(dashboard: Dashboard): { short: string; full: string } {
	if (dashboard.widgets.length === 0) return { short: "—", full: "No widgets" }

	const domains = dashboardDomains(dashboard)
	if (domains.length === 0) return { short: "static only", full: "Static content only" }

	const full = domains.join(" · ")
	if (domains.length <= MAX_DOMAIN_TERMS) return { short: full, full }

	const shown = domains.slice(0, MAX_DOMAIN_TERMS).join(" · ")
	return { short: `${shown} +${domains.length - MAX_DOMAIN_TERMS}`, full }
}

/** Matches name, description and tags — exactly what the result strip claims. */
export function dashboardMatches(dashboard: Dashboard, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (needle.length === 0) return true
	return (
		dashboard.name.toLowerCase().includes(needle) ||
		(dashboard.description?.toLowerCase().includes(needle) ?? false) ||
		(dashboard.tags?.some((tag) => tag.toLowerCase().includes(needle)) ?? false)
	)
}

/** Every tag in the list, deduped and sorted — the Tags menu's options. */
export function collectTags(dashboards: ReadonlyArray<Dashboard>): string[] {
	const tags = new Set<string>()
	for (const dashboard of dashboards) {
		for (const tag of dashboard.tags ?? []) tags.add(tag)
	}
	return Array.from(tags).sort()
}

/**
 * A dashboard passes the tag filter only if it carries *every* selected tag.
 * An empty selection filters nothing — `every` is vacuously true.
 */
export const matchesTags = (dashboard: Dashboard, tags: ReadonlyArray<string>): boolean =>
	tags.every((tag) => dashboard.tags?.includes(tag) === true)

/**
 * Sorts by the chosen comparator and *only* the chosen comparator. Favorites are
 * deliberately not hoisted: the list renders them as their own section, so
 * pre-sorting them here would double-encode favouriteness and make every sort
 * label ("Name A–Z") a lie about the order actually shown.
 */
export function sortDashboards(
	dashboards: ReadonlyArray<Dashboard>,
	sort: DashboardSortOption,
): ReadonlyArray<Dashboard> {
	return dashboards.toSorted((a, b) => {
		switch (sort) {
			case "name-asc":
				return a.name.localeCompare(b.name)
			case "name-desc":
				return b.name.localeCompare(a.name)
			case "created":
				return Date.parse(b.createdAt) - Date.parse(a.createdAt)
			case "widgets":
				return b.widgets.length - a.widgets.length
			case "updated":
				return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
		}
	})
}

/**
 * The header readout: "12 dashboards · 96 widgets · last edited 2h ago", with a
 * "N with no widgets" clause only when it is non-zero and therefore actionable.
 * `formatEdited` is injected so this stays pure and testable.
 */
export function headerSummary(
	dashboards: ReadonlyArray<Dashboard>,
	formatEdited: (iso: string) => string,
): string {
	if (dashboards.length === 0) return "No dashboards yet"

	const widgets = dashboards.reduce((total, dashboard) => total + dashboard.widgets.length, 0)
	const parts = [plural(dashboards.length, "dashboard", "dashboards"), plural(widgets, "widget", "widgets")]

	const latest = dashboards.reduce<string | null>((newest, dashboard) => {
		if (newest === null) return dashboard.updatedAt
		return Date.parse(dashboard.updatedAt) > Date.parse(newest) ? dashboard.updatedAt : newest
	}, null)
	if (latest !== null) parts.push(`last edited ${formatEdited(latest)}`)

	const empty = dashboards.filter((dashboard) => dashboard.widgets.length === 0).length
	if (empty > 0) parts.push(`${empty} with no widgets`)

	return parts.join(" · ")
}

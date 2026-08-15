/**
 * What a share link's holder is allowed to *see* of a dashboard.
 *
 * Distinct from what they are allowed to *run*. The server owning query
 * construction stops a viewer executing arbitrary queries; it does nothing
 * about the document itself, which is handed to the browser so the page can
 * lay out tiles and pick chart types. Shipped verbatim, that document would
 * publish the org's raw SQL, its where-clauses, its route params and the user
 * ids of whoever edited the board — to anyone holding a public link.
 *
 * So the share transport carries a projection, not the document. This module is
 * the single place that decides which fields survive.
 *
 * The rule is allowlist, never denylist: a field added to the stored schema
 * later is absent from the share until someone deliberately adds it here. A
 * denylist would leak every future field by default, which is exactly the wrong
 * direction for a payload served without a session.
 */
import { dataSourceEndpoint, dataSourceQuerySet, dataSourceRawSql, dataSourceTransform } from "./access"
import type { DashboardVariable } from "./shared/variables"

/**
 * The data source as a viewer sees it: enough to choose a renderer, nothing
 * that describes how the data is fetched.
 *
 * `resultShape` survives because the renderer genuinely needs it — a timeseries
 * and a breakdown draw differently. `transform` survives because it is applied
 * client-side to rows the server already returned, so withholding it would
 * change what the chart shows rather than what the viewer can learn. Neither
 * reveals a query.
 */
export interface RedactedDataSource {
	readonly kind: "query" | "raw_sql" | "route" | "static"
	readonly resultShape?: string
	readonly transform?: unknown
}

export interface RedactedWidget {
	readonly id: string
	readonly visualization: unknown
	readonly display: unknown
	readonly layout: unknown
	readonly sectionId?: string
	readonly tabId?: string
	readonly timeRange?: unknown
	readonly dataSource: RedactedDataSource
}

export interface RedactedDashboard {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly timeRange: unknown
	readonly widgets: ReadonlyArray<RedactedWidget>
	readonly sections?: unknown
	readonly variables?: ReadonlyArray<DashboardVariable>
	readonly refreshIntervalSeconds?: number
}

interface ShareWidgetInput {
	readonly id: string
	readonly visualization: unknown
	readonly display?: unknown
	readonly layout: unknown
	readonly sectionId?: string
	readonly tabId?: string
	readonly timeRange?: unknown
	readonly dataSource: unknown
}

const redactDataSource = (dataSource: unknown): RedactedDataSource => {
	const transform = dataSourceTransform(dataSource)
	const transformField = transform === undefined ? {} : { transform }

	// Reads v2 and v3 alike, via the same accessors the resolver dispatches on,
	// so a legacy stored source cannot slip through as an unrecognised `static`.
	if (dataSourceRawSql(dataSource) !== null) {
		// Deliberately drops `sql`. The stored SQL is the org's own analysis —
		// table names, filters, business logic — and a viewer needs none of it to
		// render rows the server already computed.
		return { kind: "raw_sql", ...transformField }
	}

	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null) {
		// Drops `queries`, `formulas`, `comparison`, `columns`: every one of them
		// describes what is being asked of the warehouse.
		return { kind: "query", resultShape: querySet.resultShape, ...transformField }
	}

	if (dataSourceEndpoint(dataSource) !== null) {
		// Drops both the endpoint name and its params. The name alone would tell a
		// viewer which internal route backs the tile, and the params routinely
		// carry service names and filters the board's author did not publish.
		return { kind: "route", ...transformField }
	}

	return { kind: "static", ...transformField }
}

const redactWidget = (widget: ShareWidgetInput): RedactedWidget => {
	let redacted: RedactedWidget = {
		id: widget.id,
		visualization: widget.visualization,
		display: widget.display ?? {},
		layout: widget.layout,
		dataSource: redactDataSource(widget.dataSource),
	}
	if (widget.sectionId !== undefined) redacted = { ...redacted, sectionId: widget.sectionId }
	if (widget.tabId !== undefined) redacted = { ...redacted, tabId: widget.tabId }
	if (widget.timeRange !== undefined) redacted = { ...redacted, timeRange: widget.timeRange }
	return redacted
}

/**
 * Variable names a widget actually references.
 *
 * Scans the widget's stored form for `$name` / `${name}` rather than reading
 * any one field, because a variable can land in a where-clause, a route param,
 * a formula or a raw-SQL body, and a list that missed one of those would hide a
 * picker the chart needs. `$__`-prefixed built-ins can't match: variable names
 * must begin with a letter.
 */
const referencedVariableNames = (widget: ShareWidgetInput): ReadonlySet<string> => {
	const names = new Set<string>()
	for (const match of JSON.stringify(widget ?? null).matchAll(/\$\{?([A-Za-z][A-Za-z0-9_]*)\}?/g)) {
		const name = match[1]
		if (name !== undefined) names.add(name)
	}
	return names
}

/**
 * The board's variables, narrowed to those one widget uses.
 *
 * A single-chart share publishes its own tile, so it must not also publish the
 * variable list of tiles the viewer cannot see — those names, labels, option
 * values and attribute keys are the board's, not the chart's.
 */
const variablesForWidget = (
	variables: ReadonlyArray<DashboardVariable>,
	widget: ShareWidgetInput,
): ReadonlyArray<DashboardVariable> => {
	const referenced = referencedVariableNames(widget)
	return variables.filter((variable) => referenced.has(variable.name))
}

/**
 * Project a stored dashboard down to what a share may publish.
 *
 * `widgetId` narrows to a single-chart share: the returned document contains
 * that widget alone, with no sections, so a chart link cannot be used to
 * enumerate the rest of the board. Returns `null` when the widget is absent,
 * which the caller reports as "no such share" rather than an empty dashboard.
 *
 * Always dropped, whole-board or not: `createdBy` / `updatedBy` (user ids),
 * `tags` (internal taxonomy), `createdAt` / `updatedAt` (edit activity), and
 * `txid`.
 */
export function redactForShare(
	document: {
		readonly id: string
		readonly name: string
		readonly description?: string
		readonly timeRange: unknown
		readonly widgets: ReadonlyArray<ShareWidgetInput>
		readonly sections?: unknown
		readonly variables?: ReadonlyArray<DashboardVariable>
		readonly refreshIntervalSeconds?: number
	},
	widgetId?: string | null,
): RedactedDashboard | null {
	if (widgetId !== undefined && widgetId !== null) {
		const widget = document.widgets.find((candidate) => candidate.id === widgetId)
		if (widget === undefined) return null
		let redacted: RedactedDashboard = {
			id: document.id,
			name: document.name,
			timeRange: document.timeRange,
			// The tile is lifted out of whatever section held it: a one-widget page
			// has no grid to place it in, and carrying the section tree would leak
			// the names of tabs the viewer cannot see.
			widgets: [redactWidget({ ...widget, sectionId: undefined, tabId: undefined })],
		}
		if (document.description !== undefined) {
			redacted = { ...redacted, description: document.description }
		}
		if (document.variables !== undefined) {
			redacted = { ...redacted, variables: variablesForWidget(document.variables, widget) }
		}
		return redacted
	}

	let redacted: RedactedDashboard = {
		id: document.id,
		name: document.name,
		timeRange: document.timeRange,
		widgets: document.widgets.map(redactWidget),
	}
	if (document.description !== undefined) redacted = { ...redacted, description: document.description }
	if (document.sections !== undefined) redacted = { ...redacted, sections: document.sections }
	if (document.variables !== undefined) redacted = { ...redacted, variables: document.variables }
	if (document.refreshIntervalSeconds !== undefined) {
		redacted = { ...redacted, refreshIntervalSeconds: document.refreshIntervalSeconds }
	}
	return redacted
}

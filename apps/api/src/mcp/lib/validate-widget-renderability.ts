import {
	isWidgetUnit,
	suggestWidgetUnit,
	WIDGET_TYPES,
	WIDGET_UNIT_TOKENS,
	type DashboardWidgetSchema,
	type PanelType,
} from "@maple/domain/http"
import { dataSourceQuerySet, dataSourceRawSql, dataSourceTransform } from "@maple/widgets/dashboard"
import { FUNNEL_MAX_STEPS } from "@maple/query-model"
import { isGroupByRequested } from "./inspect-widget"

type DashboardWidget = typeof DashboardWidgetSchema.Type

/**
 * Structural validation of a widget, before it is persisted.
 *
 * The sibling of `collectBlockingBuilderWarnings`: that one runs the query
 * builder and catches clauses the engine would drop, this one catches
 * combinations the *renderer* cannot draw. Pure and synchronous — it issues no
 * warehouse query — so it is cheap enough to run on every write path.
 *
 * Split by severity, and the split is load-bearing:
 *
 * - `fatal` is for combinations that are never legitimate and always render
 *   wrong. Blocking them turns a silently-broken chart into a corrective error.
 * - `warnings` are heuristics. A `percent` unit on a gauge with a 0-100 range is
 *   *usually* a mistake, but a caller restoring a legacy dashboard through
 *   `update_dashboard --dashboard_json` must not be locked out over one.
 *
 * Which severity a caller *enforces* is the caller's choice: the single-widget
 * and batch-replace paths block on `fatal`, while the whole-document paths go
 * through `collectDocumentRenderWarnings` below and block on nothing.
 */
export interface WidgetRenderIssues {
	readonly fatal: ReadonlyArray<string>
	readonly warnings: ReadonlyArray<string>
}

export interface ValidateWidgetRenderabilityInput {
	readonly widget: Pick<DashboardWidget, "visualization" | "dataSource" | "display">
	/**
	 * The resolved panel type, when the caller knows it. Without a `chartId` a
	 * `visualization: "chart"` is indistinguishable from a line chart, which is
	 * fine — none of the rules below differ across line/bar/area.
	 */
	readonly panelType?: PanelType
}

const panelTypeOf = (input: ValidateWidgetRenderabilityInput): PanelType => {
	if (input.panelType) return input.panelType
	const visualization = input.widget.visualization
	return visualization === "chart" || !(visualization in WIDGET_TYPES)
		? "line"
		: (visualization as PanelType)
}

/** Every unit field a display config can carry, with a label for the message. */
const unitFields = (
	display: DashboardWidget["display"],
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
	const found: Array<{ label: string; value: string }> = []
	if (typeof display.unit === "string" && display.unit) {
		found.push({ label: "display.unit", value: display.unit })
	}
	if (typeof display.xAxis?.unit === "string" && display.xAxis.unit) {
		found.push({ label: "display.xAxis.unit", value: display.xAxis.unit })
	}
	if (typeof display.yAxis?.unit === "string" && display.yAxis.unit) {
		found.push({ label: "display.yAxis.unit", value: display.yAxis.unit })
	}
	for (const column of display.columns ?? []) {
		if (typeof column.unit === "string" && column.unit) {
			found.push({ label: `display.columns["${column.field}"].unit`, value: column.unit })
		}
	}
	return found
}

export const validateWidgetRenderability = (input: ValidateWidgetRenderabilityInput): WidgetRenderIssues => {
	const { widget } = input
	const panelType = panelTypeOf(input)
	const meta = WIDGET_TYPES[panelType]
	const fatal: string[] = []
	const warnings: string[] = []

	const querySet = dataSourceQuerySet(widget.dataSource)
	const rawSql = dataSourceRawSql(widget.dataSource)
	const transform = dataSourceTransform(widget.dataSource)
	const kind = (widget.dataSource as { kind?: unknown }).kind
	const isStatic = kind === "static"

	// --- fatal -------------------------------------------------------------

	// A note renders `display.markdown.content` and issues no request; anything
	// else backing it means the query runs and its result is thrown away.
	if (panelType === "markdown" && !isStatic) {
		fatal.push(
			'A `markdown` note takes no query. Use `data_source_json: {"kind":"static"}` and put the text in `display_json.markdown.content`.',
		)
	}
	if (panelType !== "markdown" && isStatic) {
		fatal.push(
			`\`{"kind":"static"}\` is only for \`panel_type: "markdown"\` notes; a \`${panelType}\` panel needs a \`query\` or \`raw_sql\` data source.`,
		)
	}

	// `list` deliberately has no raw-SQL display type, so the lookup falls back to
	// `"line"` and the widget renders as a line chart. Silent before this check.
	if (panelType === "list" && rawSql !== null) {
		fatal.push(
			'`panel_type: "list"` has no raw-SQL rendering — a list is configured by its `display_json.listDataSource`, not by SQL. For tabular SQL results use `panel_type: "table"`.',
		)
	}

	// A scalar tile reads `data[0].value`; without the reduction it receives a row
	// object and renders `[object Object]`.
	if (meta.isScalar && querySet !== null && transform?.reduceToValue === undefined) {
		fatal.push(
			`\`panel_type: "${panelType}"\` renders a single number and needs a reduction. Add \`transform: { "reduceToValue": { "field": "value", "aggregate": "sum" } }\` to the data source. Valid aggregates: sum, first, count, avg, max, min — there is no \`last\`.`,
		)
	}

	// A product-event funnel definition the query builder cannot compile. These
	// are the same three rules `validate()` in `@maple/query-engine`'s
	// `product-events.ts` enforces, and they have to run HERE, on the write, or
	// the widget persists and then 400s on every render — signed-in and shared
	// alike — with no way to repair it from the tool that created it. The
	// /analytics view and the web widget builder both block on them already.
	const funnelSteps = widget.display.funnel?.steps
	if (
		(funnelSteps === undefined || funnelSteps.length === 0) &&
		(widget.display.funnel?.filters !== undefined || widget.display.funnel?.breakdownBy !== undefined)
	) {
		warnings.push(
			"`display_json.funnel.filters` / `breakdownBy` only apply to a product-event funnel, which needs `display_json.funnel.steps`; without steps the widget draws the query set's group-by rows and ignores them.",
		)
	}
	if (funnelSteps !== undefined && funnelSteps.length > 0) {
		if (funnelSteps.length > FUNNEL_MAX_STEPS) {
			fatal.push(
				`A product-event funnel has at most ${FUNNEL_MAX_STEPS} steps, but \`display_json.funnel.steps\` has ${funnelSteps.length}.`,
			)
		}
		const lateSession = funnelSteps.findIndex((step, index) => index > 0 && step.kind === "session")
		if (lateSession !== -1) {
			fatal.push(
				`A \`{ "kind": "session" }\` funnel step describes how the session was acquired, so it is only valid as step 1 — \`display_json.funnel.steps\` has one at step ${lateSession + 1}.`,
			)
		}
		const windowSeconds = widget.display.funnel?.windowSeconds
		if (windowSeconds !== undefined && (!Number.isFinite(windowSeconds) || windowSeconds <= 0)) {
			fatal.push(
				`\`display_json.funnel.windowSeconds\` is the conversion window and must be a positive number of seconds (got ${JSON.stringify(windowSeconds)}). Omit it to use the default 86400 (24h).`,
			)
		}
	}

	// --- warnings ----------------------------------------------------------

	// The breakdown endpoint is meaningless ungrouped: one bucket per time slice
	// instead of one slice per category. The web editor blocks this; the MCP path
	// did not.
	if (meta.requiresGroupBy && querySet !== null) {
		const grouped = querySet.queries.some((query) => isGroupByRequested(query))
		if (!grouped) {
			warnings.push(
				`\`panel_type: "${panelType}"\` needs a group-by or it renders a single slice. Set \`groupBy: ["service.name"]\` AND \`addOns: { "groupBy": true }\` — without the addOn the groupBy is silently ignored.`,
			)
		}
	}

	// The same gate, reported on its own: a groupBy that looks set but isn't.
	if (querySet !== null) {
		for (const query of querySet.queries) {
			const hasTokens = (query.groupBy ?? []).some((token) => {
				const trimmed = token.trim().toLowerCase()
				return trimmed.length > 0 && trimmed !== "none" && trimmed !== "all"
			})
			if (hasTokens && !query.addOns?.groupBy) {
				warnings.push(
					`Query "${query.name}" sets \`groupBy\` but not \`addOns.groupBy: true\`, so the grouping is silently ignored and the chart shows an ungrouped total.`,
				)
			}
		}
	}

	// A traces percentile without `valueField` is the documented-wrong case: bare
	// `p95` is only valid over a numeric attribute; the duration percentile is
	// `p95_duration`.
	if (querySet !== null) {
		for (const query of querySet.queries) {
			if (query.dataSource !== "traces") continue
			const hasValueField = ((query as { valueField?: string }).valueField ?? "").trim().length > 0
			if (!hasValueField && /^p(50|95|99)$/.test(query.aggregation)) {
				warnings.push(
					`Query "${query.name}" uses \`aggregation: "${query.aggregation}"\` on traces without a \`valueField\`. Bare percentiles only apply to a numeric span attribute; for latency use \`"${query.aggregation}_duration"\`.`,
				)
			}
		}
	}

	// An uncatalogued unit stores fine and renders as a bare number.
	for (const field of unitFields(widget.display)) {
		if (isWidgetUnit(field.value)) continue
		const suggestion = suggestWidgetUnit(field.value)
		warnings.push(
			`\`${field.label}: "${field.value}"\` is not a known unit and will render as a plain number.${
				suggestion ? ` Did you mean \`"${suggestion}"\`?` : ""
			} Known units: ${WIDGET_UNIT_TOKENS.join(", ")}.`,
		)
	}

	// A gauge defaults to a 0-100 arc. On a `percent` unit — which expects a 0-1
	// fraction — the number reads correctly and the needle sits pinned at zero.
	if (panelType === "gauge" && widget.display.unit === "percent") {
		const max = widget.display.gauge?.max
		if (max === undefined || max > 1) {
			warnings.push(
				`This gauge uses \`unit: "percent"\` (a 0–1 fraction) but its arc runs to ${max ?? 100}, so the needle will sit near zero. Set \`display_json.gauge: { "min": 0, "max": 1 }\`, or switch to \`unit: "percent_100"\` if the values are already 0–100.`,
			)
		}
	}

	return { fatal, warnings }
}

/** Formats issues for a tool response. Returns `""` when there is nothing to say. */
export const formatRenderIssues = (issues: WidgetRenderIssues, widgetLabel?: string): string => {
	const prefix = widgetLabel ? `${widgetLabel}: ` : ""
	const lines: string[] = []
	for (const message of issues.fatal) lines.push(`- ${prefix}${message}`)
	for (const message of issues.warnings) lines.push(`- ${prefix}${message}`)
	return lines.join("\n")
}

/**
 * Warnings for a whole document, for the `dashboard_json` replacement paths.
 *
 * Everything is advisory here, including rules that are fatal elsewhere. Those
 * paths accept a complete `PortableDashboardDocument` and are how a dashboard is
 * restored or bulk-edited; a widget that predates a rule must still round-trip.
 * Blocking a restore over a heuristic is a worse failure than the heuristic
 * catching nothing.
 */
export const collectDocumentRenderWarnings = (
	widgets: ReadonlyArray<Pick<DashboardWidget, "id" | "visualization" | "dataSource" | "display">>,
): ReadonlyArray<string> => {
	const collected: string[] = []
	for (const widget of widgets) {
		const issues = validateWidgetRenderability({ widget })
		for (const message of [...issues.fatal, ...issues.warnings]) {
			collected.push(`[${widget.id}] ${message}`)
		}
	}
	return collected
}

import {
	PANEL_TYPES,
	WIDGET_TYPES,
	WIDGET_UNITS,
	type PanelType,
	type WidgetTypeMeta,
} from "@maple/domain/http"
import {
	makeProductEventsFunnelDataSource,
	makeQueryDataSource,
	makeRawSqlDataSource,
	makeStaticDataSource,
	WIDGET_DATA_SOURCE_KINDS,
} from "@maple/widgets/dashboard"
import { AGGREGATIONS_BY_SOURCE, GROUP_BY_TOKENS } from "@maple/query-engine/query-builder"
import { QUERY_BUILDER_METRIC_TYPES, QUERY_BUILDER_SIGNAL_SOURCES } from "@maple/query-model"
import { TRACES_NUMERIC_AGGREGATIONS } from "@maple/query-engine/query-builder"
import { makeQueryDraft } from "@/dashboard-templates/helpers"

/**
 * The agent-facing description of what a dashboard widget can be.
 *
 * Every table below is *derived* from the definitions the runtime enforces —
 * `PANEL_TYPES`, `WIDGET_UNITS`, `AGGREGATIONS_BY_SOURCE`, `GROUP_BY_TOKENS`,
 * `WIDGET_DATA_SOURCE_KINDS` — and every JSON example is produced by CALLING the
 * v3 constructors in `@maple/widgets/dashboard` rather than being typed out.
 *
 * That is the whole point. The previous documentation was hand-written prose in
 * `maple://instructions` and a 4.5 KB tool description, and it drifted: it
 * taught the v2 `{ endpoint, params }` data source for months after the decoders
 * moved to the v3 `kind` union, so an agent following it exactly produced a
 * payload that could not decode. A generated example cannot describe a shape the
 * schema rejects, and `dashboard-schema-doc.test.ts` decodes each one to prove
 * it.
 *
 * The prose that remains — the raw-SQL SELECT shapes, the whereClause grammar —
 * is genuine hand-written knowledge with no machine-readable source, and is
 * marked as such where it appears.
 */

export const DASHBOARD_SCHEMA_SECTIONS = [
	"panel_types",
	"data_sources",
	"units",
	"queries",
	"display",
	"raw_sql",
] as const

export type DashboardSchemaSection = (typeof DASHBOARD_SCHEMA_SECTIONS)[number]

export const isDashboardSchemaSection = (value: string): value is DashboardSchemaSection =>
	DASHBOARD_SCHEMA_SECTIONS.some((section) => section === value)

const json = (value: unknown): string => "```json\n" + JSON.stringify(value, null, 2) + "\n```"

const mcpPanels = (): ReadonlyArray<WidgetTypeMeta> => PANEL_TYPES.filter((meta) => meta.mcpExposed)

// --- panel types ---------------------------------------------------------

const panelTypesSection = (): string => {
	const rows = mcpPanels().map((meta) => {
		const notes: string[] = []
		if (meta.requiresGroupBy) notes.push("needs a group-by")
		if (meta.isScalar) notes.push("needs `transform.reduceToValue`")
		if (meta.rawSqlDisplayType === undefined) notes.push("**no raw-SQL support**")
		return `| \`${meta.panelType}\` | ${meta.label} | \`${meta.visualization}\` | ${
			meta.chartId ? `\`${meta.chartId}\`` : "—"
		} | ${meta.rawSqlDisplayType ? `\`${meta.rawSqlDisplayType}\`` : "—"} | ${
			meta.defaultLayout.w
		}×${meta.defaultLayout.h} | ${notes.join("; ") || "—"} |`
	})

	return [
		"## Panel types",
		"",
		"`panel_type` is the whole answer to “what kind of widget is this”. Pass it and the",
		"persisted `visualization`, the `display.chartId` and the raw-SQL display type are all",
		"derived for you. The legacy `visualization` parameter is still accepted, but it collapses",
		"line/bar/area into `chart` and then needs a `display.chartId` to tell them apart. The two",
		"columns below are what `panel_type` resolves to, and are what you write directly when",
		"authoring an assembled widget rather than calling `add_dashboard_widget`. A panel whose",
		"`chartId` is `—` takes none: the `visualization` alone identifies it.",
		"",
		"| panel_type | Label | `visualization` | `display.chartId` | Raw-SQL type | Default w×h | Requirements |",
		"|---|---|---|---|---|---|---|",
		...rows,
		"",
		"### Choosing one",
		"",
		"- **line / area / bar** — a value over time. `area` and `bar` accept `display.stacked`; `line` does not.",
		"- **hbar** — a ranked “top N by volume”. Each row is labelled with its share of the **total**.",
		"- **funnel** — sequential stages with a drop-off. Labels each bar as a share of the *largest*,",
		"  so an unranked breakdown of four equal things reads “100%” four times. Use `hbar` for that.",
		"- **pie** — composition, few slices. Collapses a long tail into “Other”.",
		"- **stat / gauge** — one number. A gauge adds an arc; set `display.gauge.min`/`max` to match the unit.",
		"- **table** — rows and columns; set `display.columns` for headers and per-column units.",
		"- **list** — recent traces/logs. Configured by `display.listDataSource`, never by SQL.",
		"- **heatmap / histogram** — a distribution. A histogram over traces can bucket raw values client-side.",
		"- **markdown** — a static note. Takes no query at all.",
	].join("\n")
}

// --- data sources --------------------------------------------------------

const exampleQuerySource = () =>
	makeQueryDataSource({
		resultShape: "timeseries",
		queries: [
			makeQueryDraft({
				id: "q1",
				name: "A",
				dataSource: "traces",
				aggregation: "error_rate",
				whereClause: 'service.name = "api"',
				groupBy: ["service.name"],
			}),
		],
	})

const exampleScalarSource = () => ({
	...makeQueryDataSource({
		resultShape: "timeseries",
		queries: [makeQueryDraft({ id: "q1", name: "A", dataSource: "traces", aggregation: "count" })],
	}),
	transform: { reduceToValue: { field: "value", aggregate: "sum" } },
})

const exampleBreakdownSource = () =>
	makeQueryDataSource({
		resultShape: "breakdown",
		limit: 10,
		queries: [
			makeQueryDraft({
				id: "q1",
				name: "A",
				dataSource: "traces",
				aggregation: "count",
				groupBy: ["service.name"],
			}),
		],
	})

/** The steps a product-event funnel example runs; shared by the data-source and widget examples. */
const exampleFunnelDefinition = () => ({
	steps: [
		{ kind: "page" as const, pagePath: "/pricing" },
		{ kind: "event" as const, eventName: "signup_completed" },
		{ kind: "event" as const, eventName: "plan_started", attributeEquals: { plan: "pro" } },
	],
	keyBy: "person" as const,
	windowSeconds: 7 * 24 * 3600,
})

/**
 * A product-event funnel widget in full: the definition on `display.funnel`
 * (what `add_dashboard_widget` reads) and the route data source it derives.
 */
const exampleFunnelWidget = () => {
	const funnel = exampleFunnelDefinition()
	return {
		id: "w-signup-funnel",
		visualization: "funnel",
		dataSource: makeProductEventsFunnelDataSource(funnel),
		display: {
			title: "Signup funnel",
			chartId: "query-builder-funnel",
			funnel: { showStepPercent: true, ...funnel },
		},
		layout: { x: 0, y: 0, w: 6, h: 4 },
	}
}

/**
 * A complete persisted widget, not just its data source.
 *
 * Added because every agent in the documentation A/B flagged the same gap: the
 * sections describe `add_dashboard_widget`'s *parameters*, but
 * `update_dashboard_widget`, `replace_dashboard_widgets` and `dashboard_json` all
 * take a whole widget object, and nothing showed one. Each agent inferred the
 * envelope — `visualization` + `display.chartId` + `layout` — correctly but said
 * it was guessing.
 */
const exampleWidget = () => ({
	id: "w-error-rate",
	visualization: WIDGET_TYPES.line.visualization,
	dataSource: exampleQuerySource(),
	display: {
		title: "Error rate by service",
		chartId: WIDGET_TYPES.line.chartId,
		unit: "percent",
		chartPresentation: { legend: "visible" },
	},
	layout: { x: 0, y: 0, ...WIDGET_TYPES.line.defaultLayout },
})

const dataSourcesSection = (): string =>
	[
		"## Data sources",
		"",
		`A widget's \`dataSource\` is a discriminated union over \`kind\`: ${WIDGET_DATA_SOURCE_KINDS.map(
			(kind) => `\`${kind}\``,
		).join(", ")}. Every arm requires its \`kind\`.`,
		"",
		'> **If you have seen `{ "endpoint": …, "params": … }` anywhere — that is the retired v2 shape',
		"> and it will not decode.** A `query` source spreads `queries`/`formulas` at the TOP LEVEL,",
		"> not under `params`, and requires `resultShape`.",
		"",
		'### `kind: "query"` — the query builder',
		"",
		"`resultShape` is required and is one of `timeseries` (a value over time), `breakdown`",
		"(one row per group) or `list` (raw rows). Optional: `formulas`, `comparison`, `limit`,",
		"`defaultLimit`, `columns`, `transform`.",
		"",
		json(exampleQuerySource()),
		"",
		'### `kind: "raw_sql"` — your own ClickHouse SQL',
		"",
		json(
			makeRawSqlDataSource({
				sql: "SELECT count() AS value FROM logs WHERE $__orgFilter",
				displayType: "stat",
			}),
		),
		"",
		'### `kind: "static"` — a markdown note, no request',
		"",
		json(makeStaticDataSource()),
		"",
		'### `kind: "route"` — a curated built-in panel',
		"",
		'`{ "kind": "route", "endpoint": "service_overview", "params": { … } }`. These back the',
		"prebuilt panels; you rarely author one by hand.",
		"",
		"### Scalar panels need a reduction",
		"",
		"A `stat` or `gauge` reads `data[0].value`. Without `transform.reduceToValue` it renders",
		'`[object Object]`. `add_dashboard_widget` injects `{ field: "value", aggregate: "first" }`',
		"when you omit it; set it explicitly to choose a different reducer. Valid aggregates:",
		"`sum`, `first`, `count`, `avg`, `max`, `min` — **there is no `last`**.",
		"",
		"Which one depends on what the query returns, because the query is bucketed over time and",
		"the reducer collapses those buckets into one number:",
		"",
		"- **A rate or a count** (`count`, a metrics `rate`) → `sum`, for a window total.",
		"- **A latency percentile or an average** (`p95_duration`, `avg_duration`, a gauge metric)",
		"  → `avg` for the typical value over the window, or `max` for the worst bucket. **Not**",
		"  `sum` — adding percentiles together is meaningless, and it is the common wrong choice.",
		"- **A current reading**, where only the newest bucket matters → `first`.",
		"",
		json(exampleScalarSource()),
		"",
		"### The breakdown shape",
		"",
		'`resultShape: "breakdown"` returns one row per group instead of a series over time — the',
		"shape `pie`, `hbar`, `funnel` and `heatmap` need. It requires a group-by, and `limit` caps",
		"the rows (honoured for 1–100).",
		"",
		json(exampleBreakdownSource()),
		"",
		'### Product-event funnels (`panel_type: "funnel"` + `display.funnel.steps`)',
		"",
		"A funnel widget has two modes. Without `display.funnel.steps` it draws a group-by breakdown",
		"as descending stages (the shape above). With them it is a **conversion funnel over product",
		"events** — page views, `track()` events and server-side events, stitched per person — and",
		"the query set is not used at all. Set the definition on `display_json.funnel` and",
		'`add_dashboard_widget` derives the data source (`kind: "route"`,',
		'`endpoint: "product_events_funnel"`) for you; do not pass `data_source_json`.',
		"",
		'- `steps` — 1–10, in order. `{ kind: "event", eventName, attributeEquals? }`,',
		'  `{ kind: "page", pagePath, host? }`, or — **step 1 only** —',
		'  `{ kind: "session", dimension, value }` with `dimension` one of `referrerHost`,',
		"  `utmSource`, `utmMedium`, `utmCampaign`, `country`, `host`.",
		"- `keyBy` — `person` (default; user id, else the visitor's linked user, else the visitor),",
		"  `visitor`, `user`, or `session`.",
		"- `windowSeconds` — the whole chain must complete within this many seconds of step 1",
		"  (default 86400).",
		"- `breakdownBy` — stored for parity with the /analytics Funnels view; the widget renders",
		"  the unsegmented funnel. Use `query_funnel` for a breakdown.",
		"",
		"Use `list_product_events` to see which event names exist, and `query_funnel` to try a",
		"definition before pinning it to a board.",
		"",
		json(exampleFunnelWidget()),
		"",
		"### A complete widget",
		"",
		"The sections above describe `add_dashboard_widget`'s parameters, which it assembles into a",
		"widget for you. `update_dashboard_widget`, `replace_dashboard_widgets` and `dashboard_json`",
		"take the assembled object instead — this is its shape. `timeRange` and `sectionId`/`tabId`",
		"are the only other top-level keys, both optional.",
		"",
		json(exampleWidget()),
	].join("\n")

// --- units ---------------------------------------------------------------

const unitsSection = (): string =>
	[
		"## Units (`display.unit`)",
		"",
		"**The one that bites: Maple's percent tokens are inverted relative to Grafana's.**",
		"",
		"- `percent` expects a **fraction 0–1** and multiplies by 100 on render. (Grafana calls this `percentunit`.)",
		"- `percent_100` expects **0–100** and renders as-is. (Grafana calls *this* one `percent`.)",
		"",
		"The traces `error_rate` aggregation returns a 0–1 ratio, so it pairs with `percent`.",
		"Most exporter metrics named `*_percent`/`*_utilization` already report 0–100 and want",
		"`percent_100`. Getting it backwards renders 100× off with no error anywhere.",
		"",
		"| Token | Label | Expects |",
		"|---|---|---|",
		...WIDGET_UNITS.map((unit) => `| \`${unit.token}\` | ${unit.label} | ${unit.expects} |`),
		"",
		'`display.unit` is stored as an open string, so an unrecognised value like `"ms"`, `"%"`',
		'or `"GB"` **saves successfully and then renders as a plain number**. The write tools warn',
		"when they see one and suggest the right token. The same vocabulary applies to",
		"`display.yAxis.unit`, `display.xAxis.unit` and `display.columns[].unit`.",
		"",
		"A gauge's arc is independent of its unit and defaults to 0–100: on a `percent` gauge set",
		'`display.gauge: { "min": 0, "max": 1 }` or the needle sits pinned at zero.',
	].join("\n")

// --- queries -------------------------------------------------------------

const queriesSection = (): string => {
	const aggRows = (["traces", "logs", "metrics"] as const).map(
		(source) =>
			`| \`${source}\` | ${AGGREGATIONS_BY_SOURCE[source]
				.map((option) => `\`${option.value}\``)
				.join(", ")} |`,
	)

	const groupRows = (["traces", "logs", "metrics"] as const).map((source) => {
		const { literals, prefixes } = GROUP_BY_TOKENS[source]
		return `| \`${source}\` | ${literals.map((token) => `\`${token}\``).join(", ")} | ${
			prefixes.length > 0 ? prefixes.map((prefix) => `\`${prefix}<key>\``).join(", ") : "**none**"
		} |`
	})

	return [
		"## Queries",
		"",
		"A query draft is discriminated on `dataSource` (`traces` / `logs` / `metrics`). The",
		"metric-only fields belong solely to `metrics` queries; do not add them to trace or log",
		"queries:",
		"",
		"- `metricName` — required; discover real names with `list_metrics`.",
		`- \`metricType\` — required, one of ${QUERY_BUILDER_METRIC_TYPES.map((type) => `\`${type}\``).join(", ")}. Anything else fails to decode.`,
		`- \`signalSource\` — optional, one of ${QUERY_BUILDER_SIGNAL_SOURCES.map((source) => `\`${source}\``).join(", ")}. Omit it unless you know you need \`meter\`.`,
		"- `isMonotonic` — optional; `false` marks a Sum as an UpDownCounter, which changes the",
		"  aggregations that make sense (`rate`/`increase` assume a monotonic counter).",
		"",
		"### `addOns` is required, and all five keys must be present",
		"",
		"`addOns: { groupBy, having, orderBy, limit, legend }` — every key, every time. A missing",
		"one fails to decode. Each flag gates whether the matching field is read at all, which is",
		"why `groupBy` without `addOns.groupBy: true` silently does nothing.",
		"",
		"### Aggregations, per source",
		"",
		"| dataSource | Valid `aggregation` |",
		"|---|---|",
		...aggRows,
		"",
		`On traces only, setting \`valueField: "attr.<key>"\` switches the query to numeric-attribute`,
		`mode, where the aggregation is one of ${TRACES_NUMERIC_AGGREGATIONS.map((fn) => `\`${fn}\``).join(", ")}.`,
		"This is the **only** place a bare `p50`/`p95`/`p99` is valid — latency percentiles are",
		"spelled `p95_duration`. Metrics never accept percentiles.",
		"",
		"### Group-by tokens",
		"",
		"**`groupBy` is ignored unless `addOns.groupBy` is `true`.** This is the single most common",
		"silent failure: the array is present, the chart shows an ungrouped total, and nothing errors.",
		"",
		"| dataSource | Literal tokens | Prefixed |",
		"|---|---|---|",
		...groupRows,
		"",
		"Anything outside the literal list must use a supported prefix; unrecognised tokens are",
		"dropped, which makes the write tools reject the widget rather than save a mis-scoped chart.",
		"",
		"### `whereClause` is a custom grammar, not SQL",
		"",
		"Operators — the only ones: `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `!contains`,",
		"`exists`, `!exists`. Clauses join with ` AND `; there is no `OR` and no parentheses.",
		"Values use double quotes. **There is no `IS NULL` / `IS NOT NULL`** — write `<key> exists`",
		"or `<key> !exists`. `exists` means present *and* non-empty, because attributes live in",
		"ClickHouse `Map` columns where a missing key reads back as `''`.",
		"",
		"On `traces` any bare key outside the structured allowlist (`service.name`, `span.name`,",
		"`deployment.environment`, `deployment.commit_sha`, `root_only`, `has_error`) is treated as",
		'a span attribute, so `db.system = "clickhouse"` works directly. Cap: 5 `attr.*` plus 5',
		"`resource.*` filters per query.",
		"",
		"### Formulas and hidden series",
		"",
		"`formulas: [{ id, name, expression, legend }]` references queries by `name` (`A / B`), and",
		"is valid on the **timeseries** shape only. Marking a query `hidden: true` is UI-only in raw",
		'JSON — also add `transform.hideSeries.baseNames: ["A"]` or the auxiliary series renders at',
		"full scale and flattens the axis.",
	].join("\n")
}

// --- display -------------------------------------------------------------

const displaySection = (): string =>
	[
		"## Display config",
		"",
		"| Key | Applies to | Notes |",
		"|---|---|---|",
		"| `title`, `description` | all | |",
		"| `unit` | all | See the `units` section — read it before choosing a percent token. |",
		"| `thresholds` | stat, gauge, charts | `[{ value, color, label? }]`; highest matching value wins. |",
		"| `prefix`, `suffix` | stat, gauge | Wrap the formatted value. |",
		"| `chartPresentation.legend` | charts | `visible` \\| `hidden` \\| `right`. |",
		"| `chartPresentation.seriesStats` | charts | Min/Max/Mean/Last table; costs up to 45% of tile height. |",
		"| `chartPresentation.tooltip` | charts | `visible` \\| `hidden`. |",
		"| `chartPresentation.showPoints` | charts | Omit for auto, `true` always, `false` never. |",
		"| `stacked` | area, bar | Meaningless on `line`. |",
		"| `curveType` | line, area | `linear` \\| `monotone`. |",
		"| `yAxis.logScale`, `softMin`, `softMax`, `fitYAxisToData` | charts | |",
		"| `columns` | table, list | `[{ field, header, unit?, width?, align?, hidden? }]`. |",
		"| `listDataSource`, `listWhereClause`, `listLimit`, `listRootOnly` | list | |",
		"| `pie` | pie | `{ donut, innerRadius, showLabels, showPercent }`. |",
		"| `gauge` | gauge | `{ min, max }` — defaults to 0–100, which is wrong for a `percent` unit. |",
		"| `histogram` | histogram | `{ bucketCount, bucketWidth, logScaleY }`. |",
		"| `heatmap` | heatmap | `{ colorScale, scaleType }`. |",
		"| `funnel` | funnel | `{ showStepPercent, steps?, keyBy?, windowSeconds?, breakdownBy? }` — with `steps` it is a product-event funnel (see Data sources). |",
		"| `markdown` | markdown | `{ content }` — the note body. |",
		"| `sparkline` | stat | `{ enabled, dataSource? }`; embeds a full nested data source. |",
		"",
		"### Stored but not rendered",
		"",
		"These decode and persist, and the chart renderer **ignores them**. Setting one to fix a",
		"problem will look like it worked and change nothing:",
		"`yAxis.min`, `yAxis.max`, every `xAxis` field, `seriesMapping`, `colorOverrides`,",
		"`chartPresentation.fillNulls`, `gauge.style`.",
		"To bound a chart's axis use `yAxis.softMin`/`softMax`.",
		"",
		"### Per-widget time range",
		"",
		"A widget follows the dashboard's range unless it carries its own top-level `timeRange`:",
		'`{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"…","endTime":"…"}`.',
		"Pin one only when the window is part of what the tile means. Because",
		"`update_dashboard_widget` replaces the whole widget, omitting `timeRange` there REMOVES an",
		"existing override.",
	].join("\n")

// --- raw sql -------------------------------------------------------------

const rawSqlSection = (): string =>
	[
		"## Raw SQL widgets",
		"",
		"Pass `sql` to `add_dashboard_widget` and the tool builds the data source for you.",
		"**Call `describe_warehouse_tables` first** — a hallucinated table or column silently",
		"produces an empty chart.",
		"",
		"### Macros",
		"",
		"- `$__orgFilter` → **required**; scopes the query to your org.",
		"- `$__timeFilter(Column)` → a bare column identifier, no expressions. Prefer this in WHERE.",
		"- `$__startTime` / `$__endTime` → `toDateTime(…)` literals for use outside a WHERE comparison.",
		"- `$__interval_s` → bucket size in seconds; only interpolate it if the SQL buckets time.",
		"",
		"### Conventions that catch everyone",
		"",
		"- Columns are PascalCase (`ServiceName`, `Timestamp`) — never snake_case.",
		"- `StatusCode` / `SeverityText` / `SpanKind` values are **Title Case** (`'Error'`, not `'ERROR'`).",
		"  Wrong casing runs fine and matches zero rows.",
		"- Span `Duration` is **nanoseconds**. Divide by `1e6` for ms.",
		"- `SpanAttributes['key']` — square brackets. A missing key returns `''`, not NULL.",
		"- One statement only; writes are rejected; every query is wrapped in `LIMIT 1001`.",
		"",
		"### What to SELECT, per panel type",
		"",
		"The renderer is opinionated. Wrong aliases give an empty chart or `[object Object]`.",
		"",
		"- **line / area / bar** — a DateTime bucket as the FIRST column (alias `bucket`) plus one or",
		"  more **numeric** columns; each becomes a series named after the column. **String columns",
		"  are dropped**, so multi-series must be pivoted in SQL with `countIf(...)` — tall form",
		"  (`bucket, ServiceName, count()`) collapses to one aggregate line.",
		"- **stat / gauge** — one scalar aliased `value`.",
		"- **pie / funnel / hbar** — a string column aliased `name` plus a numeric column. Cap at ~8–10 rows.",
		"- **heatmap** — three columns aliased `x`, `y`, `value`; string-cast numeric `x`/`y`.",
		"- **histogram** — one numeric column aliased `value`, one row per observation; add `LIMIT 5000`.",
		"- **table** — any rows; columns render in order, so use `AS` for readable headers.",
		"- **list** — not supported. A list is configured by `display.listDataSource`.",
		"",
		"```sql",
		"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,",
		"       countIf(SeverityText = 'Error') AS Error,",
		"       countIf(SeverityText = 'Warn')  AS Warn",
		"FROM logs",
		"WHERE $__orgFilter AND $__timeFilter(Timestamp)",
		"GROUP BY bucket",
		"ORDER BY bucket",
		"```",
		"",
		"`granularity_seconds` only matters if the SQL references `$__interval_s`. Either use",
		"`toStartOfInterval(…, INTERVAL $__interval_s SECOND)` with it, or a fixed `toStartOf*`",
		"without it — mixing them means the setting silently does nothing.",
	].join("\n")

const SECTION_RENDERERS = {
	panel_types: panelTypesSection,
	data_sources: dataSourcesSection,
	units: unitsSection,
	queries: queriesSection,
	display: displaySection,
	raw_sql: rawSqlSection,
} satisfies Record<DashboardSchemaSection, () => string>

const SECTION_SUMMARIES = {
	panel_types: "The 13 panel types, what each persists as, and which need a group-by or a reduction.",
	data_sources: "The four `kind` arms of a widget data source, with a decodable example of each.",
	units: "The unit vocabulary — and the percent-vs-percent_100 scale rule.",
	queries: "Aggregations and group-by tokens per source, the whereClause grammar, formulas.",
	display: "Display config keys per panel type, including the ones that are stored but inert.",
	raw_sql: "Macros, ClickHouse conventions, and the SELECT shape each panel type expects.",
} satisfies Record<DashboardSchemaSection, string>

export const renderDashboardSchemaSection = (section: DashboardSchemaSection): string =>
	SECTION_RENDERERS[section]()

/** The no-argument response: an index plus the panel table, which is what most callers want. */
export const renderDashboardSchemaIndex = (): string =>
	[
		"# Dashboard widget schema",
		"",
		'Call this tool again with `section: "<name>"` for any of:',
		"",
		...DASHBOARD_SCHEMA_SECTIONS.map((section) => `- \`${section}\` — ${SECTION_SUMMARIES[section]}`),
		"",
		"Two things to read before authoring anything:",
		"",
		'1. A data source is a `kind`-discriminated union. `{ "endpoint", "params" }` is the retired',
		"   v2 shape and will not decode.",
		"2. `percent` means a 0–1 fraction (multiplied by 100 on render); `percent_100` means 0–100.",
		"   This is inverted from Grafana.",
		"",
		panelTypesSection(),
	].join("\n")

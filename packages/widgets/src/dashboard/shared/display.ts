import { FunnelBreakdownBy, FunnelKeyBy, FunnelStep } from "@maple/query-model"
import { Schema } from "effect"
import { HEATMAP_COLOR_SCALES, HEATMAP_SCALE_TYPES } from "../../widget-types"
import { StringRecord } from "./transform"

const WidgetDisplayColumnSchema = Schema.Struct({
	field: Schema.String,
	header: Schema.String,
	unit: Schema.optional(Schema.String),
	width: Schema.optional(Schema.Number),
	align: Schema.optional(Schema.Literals(["left", "center", "right"])),
	hidden: Schema.optional(Schema.Boolean),
	thresholds: Schema.optional(
		Schema.Array(
			Schema.Struct({
				value: Schema.Number,
				color: Schema.String,
			}),
		),
	),
})

/**
 * The display config is parameterised on the data-source schema because
 * `sparkline.dataSource` embeds a *full* data source. That single field is what
 * makes "closing widget params" a change that propagates display -> widget ->
 * document rather than a leaf edit, and it is the reason this is a factory
 * instead of a const: each schema version passes its own data source in, and
 * every other field below is written once and shared across versions.
 */
export const makeWidgetDisplayConfigSchema = <DataSource extends Schema.Top>(dataSource: DataSource) =>
	Schema.Struct({
		title: Schema.optional(Schema.String),
		description: Schema.optional(Schema.String),
		chartId: Schema.optional(Schema.String),
		chartPresentation: Schema.optional(
			Schema.Struct({
				legend: Schema.optional(Schema.Literals(["visible", "hidden", "right"])),
				seriesStats: Schema.optional(Schema.Boolean),
				tooltip: Schema.optional(Schema.Literals(["visible", "hidden"])),
				showPoints: Schema.optional(Schema.Boolean),
				fillNulls: Schema.optional(Schema.Union([Schema.Number, Schema.Literal(false)])),
				compareToPreviousPeriod: Schema.optional(Schema.Boolean),
			}),
		),
		xAxis: Schema.optional(
			Schema.Struct({
				label: Schema.optional(Schema.String),
				unit: Schema.optional(Schema.String),
				visible: Schema.optional(Schema.Boolean),
			}),
		),
		yAxis: Schema.optional(
			Schema.Struct({
				label: Schema.optional(Schema.String),
				unit: Schema.optional(Schema.String),
				min: Schema.optional(Schema.Number),
				max: Schema.optional(Schema.Number),
				softMin: Schema.optional(Schema.Number),
				softMax: Schema.optional(Schema.Number),
				logScale: Schema.optional(Schema.Boolean),
				// When true, the y-axis lower bound follows the minimum of the
				// displayed data (with padding) instead of being pinned at zero,
				// making small fluctuations between series easier to see. Ignored
				// when `softMin`/`min` or `logScale` are set.
				fitYAxisToData: Schema.optional(Schema.Boolean),
				visible: Schema.optional(Schema.Boolean),
			}),
		),
		seriesMapping: Schema.optional(StringRecord),
		colorOverrides: Schema.optional(StringRecord),
		stacked: Schema.optional(Schema.Boolean),
		curveType: Schema.optional(Schema.Literals(["linear", "monotone"])),
		unit: Schema.optional(Schema.String),
		thresholds: Schema.optional(
			Schema.Array(
				Schema.Struct({
					value: Schema.Number,
					color: Schema.String,
					label: Schema.optional(Schema.String),
				}),
			),
		),
		prefix: Schema.optional(Schema.String),
		suffix: Schema.optional(Schema.String),
		sparkline: Schema.optional(
			Schema.Struct({
				enabled: Schema.Boolean,
				dataSource: Schema.optional(dataSource),
			}),
		),
		columns: Schema.optional(Schema.Array(WidgetDisplayColumnSchema)),

		listDataSource: Schema.optional(Schema.String),
		// LOAD-BEARING NAME: dashboard variable interpolation matches any key ending
		// in "whereclause" (case-insensitive, any depth) — see
		// `packages/query-engine/src/dashboard-variables/interpolate.ts:37`. Renaming
		// this field silently stops `$var` substitution, sending the literal `$service`
		// to the warehouse. Guarded by `params/interpolation-keys.test.ts`.
		listWhereClause: Schema.optional(Schema.String),
		listLimit: Schema.optional(Schema.Number),
		listRootOnly: Schema.optional(Schema.Boolean),

		// Pie-specific
		pie: Schema.optional(
			Schema.Struct({
				donut: Schema.optional(Schema.Boolean),
				innerRadius: Schema.optional(Schema.Number),
				showLabels: Schema.optional(Schema.Boolean),
				showPercent: Schema.optional(Schema.Boolean),
			}),
		),

		// Funnel-specific.
		//
		// `steps`/`keyBy`/`windowSeconds`/`breakdownBy` turn the funnel from a
		// rendering of group-by rows into a product-event funnel: when `steps` is
		// present the widget is fetched through the funnel endpoint instead of the
		// query set. Additive — a funnel without them renders exactly as before,
		// which is what keeps older readers of the document (the mobile app reads
		// this wire) safe.
		funnel: Schema.optional(
			Schema.Struct({
				showStepPercent: Schema.optional(Schema.Boolean),
				steps: Schema.optional(Schema.Array(FunnelStep)),
				keyBy: Schema.optional(FunnelKeyBy),
				windowSeconds: Schema.optional(Schema.Number),
				breakdownBy: Schema.optional(FunnelBreakdownBy),
			}),
		),

		// Histogram-specific
		histogram: Schema.optional(
			Schema.Struct({
				bucketCount: Schema.optional(Schema.Number),
				bucketWidth: Schema.optional(Schema.Number),
				logScaleY: Schema.optional(Schema.Boolean),
			}),
		),

		heatmap: Schema.optional(
			Schema.Struct({
				colorScale: Schema.optional(Schema.Literals(HEATMAP_COLOR_SCALES)),
				scaleType: Schema.optional(Schema.Literals(HEATMAP_SCALE_TYPES)),
			}),
		),

		gauge: Schema.optional(
			Schema.Struct({
				min: Schema.optional(Schema.Number),
				max: Schema.optional(Schema.Number),
				style: Schema.optional(Schema.Literals(["radial", "bar"])),
			}),
		),

		// Markdown-specific
		markdown: Schema.optional(
			Schema.Struct({
				content: Schema.String,
			}),
		),
	})

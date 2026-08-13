import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DashboardWidgetSchema, WidgetDisplayConfigSchema } from "../dashboards"
import { V2DashboardWidget, V2WidgetDisplay } from "./dashboards"

// The v2 public schema is a hand-maintained clone of the stored widget schema:
// the same fields again, differing only by `Schema.encodeKeys` for snake_case.
//
// Nothing else guards it. `routes/v2/dashboards.http.ts` assigns
// `widgets: dashboard.widgets` — INTERNAL widgets into the V2 type — which
// type-checks structurally, so a field added to the shared schema and forgotten
// in the clone is a silent omission from the public API, not a compile error.
//
// This file makes that a build failure both ways: the type assertions below fail
// `tsc` when either side gains a field, and the encode tests fail when a field is
// present in the type but dropped on the wire or spelled differently there.

const snakeCase = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Fails to compile unless `A` is assignable to `B`. */
type AssertAssignable<A extends B, B> = [A, B]

// Bidirectional: a field added to EITHER schema and missed on the other breaks
// the build here rather than silently changing the public API.
export type _DisplayInternalToV2 = AssertAssignable<
	typeof WidgetDisplayConfigSchema.Type,
	typeof V2WidgetDisplay.Type
>
export type _DisplayV2ToInternal = AssertAssignable<
	typeof V2WidgetDisplay.Type,
	typeof WidgetDisplayConfigSchema.Type
>
// The widget is asserted in one direction only, and deliberately.
//
// This is the direction the silent-omission bug actually travels:
// `routes/v2/dashboards.http.ts` assigns `widgets: dashboard.widgets` — internal
// widgets into the V2 type — so internal must satisfy V2. It still catches a
// field added to V2 alone, because a new *required* V2 field would leave internal
// no longer assignable.
//
// The reverse does not hold, and forcing it would be wrong: V2 types an absolute
// `timeRange` as a plain `Timestamp` string while the stored schema brands it
// `IsoDateTimeString`. `toInternalWidgets` in the route re-brands it on the way
// in — which is precisely why that function exists.
export type _WidgetInternalToV2 = AssertAssignable<
	typeof DashboardWidgetSchema.Type,
	typeof V2DashboardWidget.Type
>

/**
 * A display config with EVERY field populated.
 *
 * Not hand-curated: the first test asserts its key set equals the stored
 * schema's own field list, so a field added there fails here until this fixture
 * covers it — which is what keeps the encode assertion below honest. Values only
 * have to decode; the point is key coverage, not realism.
 */
const fullDisplay = {
	title: "Requests",
	description: "per second",
	chartId: "query-builder-line",
	chartPresentation: {
		legend: "visible",
		seriesStats: true,
		tooltip: "visible",
		showPoints: false,
		fillNulls: 0,
		compareToPreviousPeriod: true,
	},
	xAxis: { label: "t", unit: "s", visible: true },
	yAxis: {
		label: "v",
		unit: "ms",
		min: 0,
		max: 10,
		softMin: 1,
		softMax: 9,
		logScale: false,
		fitYAxisToData: true,
		visible: true,
	},
	seriesMapping: { a: "b" },
	colorOverrides: { a: "#fff" },
	stacked: true,
	curveType: "monotone",
	unit: "ms",
	thresholds: [{ value: 1, color: "#f00", label: "warn" }],
	prefix: "~",
	suffix: "/s",
	sparkline: { enabled: true, dataSource: { endpoint: "custom_query_builder_timeseries" } },
	columns: [
		{
			field: "name",
			header: "Name",
			unit: "ms",
			width: 10,
			align: "left",
			hidden: false,
			thresholds: [{ value: 1, color: "#f00" }],
		},
	],
	listDataSource: "traces",
	listWhereClause: "service.name = $service",
	listLimit: 50,
	listRootOnly: true,
	pie: { donut: true, innerRadius: 2, showLabels: true, showPercent: true },
	funnel: { showStepPercent: true },
	histogram: { bucketCount: 10, bucketWidth: 2, logScaleY: false },
	heatmap: { colorScale: "amber", scaleType: "linear" },
	gauge: { min: 0, max: 100, style: "radial" },
	markdown: { content: "# note" },
}

describe("the v2 widget display mirrors the stored one", () => {
	it("covers every field the stored display declares", () => {
		expect(Object.keys(fullDisplay).sort()).toEqual(Object.keys(WidgetDisplayConfigSchema.fields).sort())
	})

	// The failure this exists for: a field present in the stored schema that the
	// v2 clone never declared is silently dropped by `Schema.Struct` on encode, so
	// the public API just stops returning it.
	it("puts every stored field on the wire, in mechanical snake_case", () => {
		const encoded = Schema.encodeUnknownSync(V2WidgetDisplay)(fullDisplay)

		expect(Object.keys(encoded).sort()).toEqual(
			Object.keys(WidgetDisplayConfigSchema.fields).map(snakeCase).sort(),
		)
	})

	// A nested object is just as easy to forget as a top-level one, and the
	// key-set check above only sees the top level.
	it("snake_cases nested keys too", () => {
		const encoded = Schema.encodeUnknownSync(V2WidgetDisplay)(fullDisplay)

		expect(encoded).toMatchObject({
			chart_presentation: {
				series_stats: true,
				show_points: false,
				fill_nulls: 0,
				compare_to_previous_period: true,
			},
			y_axis: { soft_min: 1, soft_max: 9, log_scale: false, fit_y_axis_to_data: true },
			pie: { inner_radius: 2, show_labels: true, show_percent: true },
			histogram: { bucket_count: 10, bucket_width: 2, log_scale_y: false },
			heatmap: { color_scale: "amber", scale_type: "linear" },
			funnel: { show_step_percent: true },
			sparkline: { data_source: { endpoint: "custom_query_builder_timeseries" } },
			list_where_clause: "service.name = $service",
			list_root_only: true,
		})
	})

	// LOAD-BEARING: dashboard variable interpolation matches any key ending in
	// "whereclause" (case-insensitive, any depth) — see
	// `packages/query-engine/src/dashboard-variables/interpolate.ts`. The stored
	// schema carries a comment saying so; the v2 clone does not, so pin it here.
	it("keeps the interpolation-sensitive listWhereClause name on both sides", () => {
		expect(WidgetDisplayConfigSchema.fields).toHaveProperty("listWhereClause")
		const encoded = Schema.encodeUnknownSync(V2WidgetDisplay)(fullDisplay)
		expect(Object.keys(encoded)).toContain("list_where_clause")
	})
})

describe("the v2 widget mirrors the stored one", () => {
	const fullWidget = {
		id: "w1",
		visualization: "chart",
		dataSource: {
			endpoint: "custom_query_builder_timeseries",
			params: { queries: [] },
			transform: {
				fieldMap: { a: "b" },
				hideSeries: { baseNames: ["x"] },
				flattenSeries: { valueField: "value" },
				reduceToValue: { field: "value", aggregate: "first" },
				computeRatio: { numeratorName: "n", denominatorNames: ["d"] },
				limit: 10,
				sortBy: { field: "value", direction: "desc" },
			},
		},
		display: fullDisplay,
		layout: { x: 0, y: 0, w: 4, h: 6, minW: 2, minH: 2, maxW: 12, maxH: 12 },
		timeRange: { type: "relative", value: "12h" },
		sectionId: "sec-1",
		tabId: "tab-1",
	}

	it("covers every field the stored widget declares", () => {
		expect(Object.keys(fullWidget).sort()).toEqual(Object.keys(DashboardWidgetSchema.fields).sort())
	})

	it("puts every stored field on the wire, in mechanical snake_case", () => {
		const encoded = Schema.encodeUnknownSync(V2DashboardWidget)(fullWidget)

		expect(Object.keys(encoded).sort()).toEqual(
			Object.keys(DashboardWidgetSchema.fields).map(snakeCase).sort(),
		)
	})

	it("mirrors the transform, which has its own set of renamed keys", () => {
		const encoded = Schema.encodeUnknownSync(V2DashboardWidget)(fullWidget)

		expect(encoded).toMatchObject({
			data_source: {
				transform: {
					field_map: { a: "b" },
					hide_series: { base_names: ["x"] },
					flatten_series: { value_field: "value" },
					reduce_to_value: { field: "value", aggregate: "first" },
					compute_ratio: { numerator_name: "n", denominator_names: ["d"] },
					sort_by: { field: "value", direction: "desc" },
				},
			},
			layout: { min_w: 2, min_h: 2, max_w: 12, max_h: 12 },
		})
	})
})

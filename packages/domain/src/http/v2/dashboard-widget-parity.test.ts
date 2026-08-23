import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WIDGET_DATA_SOURCE_KINDS } from "@maple/widgets/dashboard"
import { DashboardWidgetSchema, WidgetDisplayConfigSchema } from "../dashboards"
import { V2DashboardWidget, V2WidgetDataSource, V2WidgetDisplay } from "./dashboards"

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

// The three structural assignability assertions that used to live here are gone,
// and deliberately.
//
// They asserted that the stored widget/display types were mutually assignable
// with the v2 ones — which held only while the v2 schemas were a field-for-field
// clone of storage. Schema v3 ends that: `dataSource.queries` is a typed array of
// query drafts in storage and an opaque `UnknownRecord` on the wire, because the
// wire representation of a query has always been opaque (it lived inside the
// untyped `params` bag) and typing it now would be a second, larger breaking
// change to the published spec.
//
// So assignability is genuinely false, and forcing it would mean either leaking
// storage types into the public contract or weakening storage to match the wire.
// What the assertions actually PROTECTED — "you cannot extend the internal schema
// without deciding what the public API does" — is preserved by the kind-coverage
// test at the bottom of this file, which fails when an arm is added to the stored
// union and not mirrored here.
export type _DisplayFieldsCovered = AssertAssignable<
	keyof typeof V2WidgetDisplay.Type,
	keyof typeof WidgetDisplayConfigSchema.Type
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
	sparkline: { enabled: true, dataSource: { kind: "route", endpoint: "list_traces" } },
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
	funnel: {
		showStepPercent: true,
		steps: [
			{ kind: "session", dimension: "utmSource", value: "twitter" },
			{ kind: "page", pagePath: "/pricing", host: "example.com" },
			{ kind: "event", eventName: "signup_completed", attributeEquals: { plan: "pro" } },
		],
		keyBy: "person",
		windowSeconds: 86400,
		breakdownBy: "attribute:plan",
		filters: { country: "DE", utmSource: "twitter", visitorType: "new" },
	},
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
			funnel: {
				show_step_percent: true,
				key_by: "person",
				window_seconds: 86400,
				breakdown_by: "attribute:plan",
				filters: { country: "DE", utm_source: "twitter", visitor_type: "new" },
				// Steps are the query-engine contract and stay camelCase inside.
				steps: [
					{ kind: "session", dimension: "utmSource", value: "twitter" },
					{ kind: "page", pagePath: "/pricing", host: "example.com" },
					{ kind: "event", eventName: "signup_completed", attributeEquals: { plan: "pro" } },
				],
			},
			sparkline: { data_source: { kind: "route", endpoint: "list_traces" } },
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
			kind: "query",
			resultShape: "timeseries",
			queries: [],
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

// The structural successor to the deleted assignability assertions.
//
// A fifth arm added to the stored data-source union fails here until someone has
// decided what `/v2/dashboards` does with it — which is the question the old type
// assertions forced, and the only one worth forcing.
describe("the v2 data source covers every stored kind", () => {
	const decode = Schema.decodeUnknownSync(V2WidgetDataSource)

	it.each(WIDGET_DATA_SOURCE_KINDS)("declares an arm for kind %s", (kind) => {
		const fixture: Record<string, unknown> = {
			query: { kind: "query", result_shape: "timeseries", queries: [] },
			raw_sql: { kind: "raw_sql", sql: "SELECT 1" },
			route: { kind: "route", endpoint: "list_traces" },
			static: { kind: "static" },
		}[kind]!

		expect(() => decode(fixture)).not.toThrow()
	})

	it("snake_cases the scalar fields the union added", () => {
		const wire = Schema.encodeUnknownSync(V2WidgetDataSource)({
			kind: "query",
			resultShape: "breakdown",
			queries: [],
			defaultLimit: 20,
		}) as Record<string, unknown>

		expect(wire).toHaveProperty("result_shape", "breakdown")
		expect(wire).toHaveProperty("default_limit", 20)
	})
})

import { describe, expect, it } from "vitest"
import {
	makeProductEventsFunnelDataSource,
	makeQueryDataSource,
	makeRawSqlDataSource,
	makeStaticDataSource,
} from "@maple/widgets/dashboard"
import { makeQueryDraft } from "@/dashboard-templates/helpers"
import type { PanelType } from "@maple/domain/http"
import { collectDocumentRenderWarnings, validateWidgetRenderability } from "./validate-widget-renderability"

const querySource = (
	overrides: Parameters<typeof makeQueryDraft>[0] extends never
		? never
		: Partial<Parameters<typeof makeQueryDraft>[0]> = {},
) =>
	makeQueryDataSource({
		resultShape: "timeseries",
		queries: [
			makeQueryDraft({
				id: "q1",
				name: "A",
				dataSource: "traces",
				aggregation: "count",
				...overrides,
			}),
		],
	})

const widget = (panelType: PanelType, dataSource: unknown, display: Record<string, unknown> = {}) => ({
	panelType,
	widget: {
		visualization:
			panelType === "line" || panelType === "bar" || panelType === "area"
				? ("chart" as const)
				: (panelType as never),
		dataSource: dataSource as never,
		display: display as never,
	},
})

describe("fatal — combinations that always render wrong", () => {
	it("a markdown note backed by a query", () => {
		const { fatal } = validateWidgetRenderability(widget("markdown", querySource()))
		expect(fatal.join(" ")).toContain('{"kind":"static"}')
	})

	it("a non-markdown panel backed by a static source", () => {
		const { fatal } = validateWidgetRenderability(widget("line", makeStaticDataSource()))
		expect(fatal.join(" ")).toContain("static")
	})

	it("a list backed by raw SQL — silently rendered as a line chart before this check", () => {
		const source = makeRawSqlDataSource({ sql: "SELECT 1", displayType: "table" })
		const { fatal } = validateWidgetRenderability(widget("list", source))
		expect(fatal.join(" ")).toContain('panel_type: "table"')
	})

	it("a stat with no reduceToValue — renders [object Object]", () => {
		const { fatal } = validateWidgetRenderability(widget("stat", querySource()))
		expect(fatal.join(" ")).toContain("reduceToValue")
	})

	it("a gauge with a reduceToValue is accepted", () => {
		const source = { ...querySource(), transform: { reduceToValue: { field: "value" } } }
		expect(validateWidgetRenderability(widget("gauge", source)).fatal).toEqual([])
	})

	it("a plain line chart with a query source is clean", () => {
		const issues = validateWidgetRenderability(widget("line", querySource()))
		expect(issues.fatal).toEqual([])
		expect(issues.warnings).toEqual([])
	})

	// A funnel definition the query builder rejects would persist and then 400 on
	// every render, signed-in and shared alike, with nothing in the authoring
	// tool able to repair it. These are the builder's own three rules.
	describe("a product-event funnel definition the builder cannot compile", () => {
		const funnelWidget = (funnel: Record<string, unknown>) =>
			widget("funnel", makeProductEventsFunnelDataSource({ steps: [] as never }), { funnel })
		const step = (eventName: string) => ({ kind: "event", eventName })

		it("more than ten steps", () => {
			const steps = Array.from({ length: 11 }, (_, i) => step(`e${i}`))
			expect(validateWidgetRenderability(funnelWidget({ steps })).fatal.join(" ")).toContain(
				"at most 10 steps",
			)
		})

		it("a session step past step 1", () => {
			const steps = [
				step("signup_completed"),
				{ kind: "session", dimension: "utmSource", value: "twitter" },
			]
			expect(validateWidgetRenderability(funnelWidget({ steps })).fatal.join(" ")).toContain(
				"only valid as step 1",
			)
		})

		it("a non-positive conversion window", () => {
			const steps = [step("a"), step("b")]
			expect(
				validateWidgetRenderability(funnelWidget({ steps, windowSeconds: 0 })).fatal.join(" "),
			).toContain("windowSeconds")
		})

		it("a valid definition, and a funnel with no steps at all, are clean", () => {
			const steps = [{ kind: "session", dimension: "utmSource", value: "x" }, step("signup")]
			expect(validateWidgetRenderability(funnelWidget({ steps, windowSeconds: 3600 })).fatal).toEqual(
				[],
			)
			// No steps: the widget is the original group-by breakdown drawn as a
			// funnel, and none of these rules apply to it.
			expect(validateWidgetRenderability(funnelWidget({ showStepPercent: true })).fatal).toEqual([])
		})
	})
})

describe("warnings — heuristics that must not block a restore", () => {
	it("a breakdown panel with no group-by", () => {
		const { warnings, fatal } = validateWidgetRenderability(widget("pie", querySource()))
		expect(fatal).toEqual([])
		expect(warnings.join(" ")).toContain("group-by")
	})

	it("a breakdown panel with a real group-by is clean", () => {
		const source = querySource({ groupBy: ["service.name"] })
		expect(validateWidgetRenderability(widget("pie", source)).warnings).toEqual([])
	})

	it("groupBy set without addOns.groupBy — the silent-drop trap", () => {
		// `makeQueryDraft` sets the addOn from the array, so build the draft that
		// an agent hand-writing JSON actually produces.
		const draft = {
			...makeQueryDraft({ id: "q1", name: "A", dataSource: "traces", aggregation: "count" }),
			groupBy: ["service.name"],
		}
		const source = makeQueryDataSource({ resultShape: "timeseries", queries: [draft] })
		const { warnings } = validateWidgetRenderability(widget("line", source))
		expect(warnings.join(" ")).toContain("addOns.groupBy")
	})

	it("an uncatalogued unit, with a suggestion", () => {
		const { warnings } = validateWidgetRenderability(widget("line", querySource(), { unit: "GB" }))
		expect(warnings.join(" ")).toContain('"bytes"')
	})

	it("suggests duration_ms for a bare ms unit", () => {
		const { warnings } = validateWidgetRenderability(widget("line", querySource(), { unit: "ms" }))
		expect(warnings.join(" ")).toContain('"duration_ms"')
	})

	it("flags a column unit too", () => {
		const { warnings } = validateWidgetRenderability(
			widget("table", querySource(), {
				columns: [{ field: "latency", header: "Latency", unit: "seconds" }],
			}),
		)
		expect(warnings.join(" ")).toContain('"duration_s"')
	})

	it("a percent gauge left on the default 0-100 arc pins the needle at zero", () => {
		const source = { ...querySource(), transform: { reduceToValue: { field: "value" } } }
		const { warnings } = validateWidgetRenderability(widget("gauge", source, { unit: "percent" }))
		expect(warnings.join(" ")).toContain('"max": 1')
	})

	it("a percent gauge with a 0-1 arc is clean", () => {
		const source = { ...querySource(), transform: { reduceToValue: { field: "value" } } }
		const issues = validateWidgetRenderability(
			widget("gauge", source, { unit: "percent", gauge: { min: 0, max: 1 } }),
		)
		expect(issues.warnings).toEqual([])
	})

	it("a bare p95 on traces without valueField", () => {
		const { warnings } = validateWidgetRenderability(widget("line", querySource({ aggregation: "p95" })))
		expect(warnings.join(" ")).toContain("p95_duration")
	})
})

describe("document paths never block", () => {
	// `update_dashboard --dashboard_json` is the restore escape hatch. A legacy
	// board with an ungrouped pie and a "GB" unit has to round-trip, so even the
	// fatal rules come back as advisory text there.
	it("reports fatal and warning issues alike, as plain strings", () => {
		const warnings = collectDocumentRenderWarnings([
			{
				id: "w1",
				visualization: "stat" as never,
				dataSource: querySource() as never,
				display: { unit: "GB" } as never,
			},
			{
				id: "w2",
				visualization: "pie" as never,
				dataSource: querySource() as never,
				display: {} as never,
			},
		])
		expect(warnings.join(" ")).toContain("[w1]")
		expect(warnings.join(" ")).toContain("reduceToValue")
		expect(warnings.join(" ")).toContain("[w2]")
	})

	it("returns nothing for a clean document", () => {
		expect(
			collectDocumentRenderWarnings([
				{
					id: "w1",
					visualization: "chart" as never,
					dataSource: querySource() as never,
					display: { unit: "number" } as never,
				},
			]),
		).toEqual([])
	})
})

describe("a legacy widget stays editable", () => {
	// The regression this guards: making "scalar with no reduceToValue" fatal
	// would lock a stored stat widget that predates the check out of
	// `update_dashboard_widget` — you could not even fix its title. That path
	// repairs the widget instead, so the fatal rule only ever fires on a widget
	// being authored fresh.
	it("a stat gains the default reduction rather than failing validation", async () => {
		const { withScalarReduction } = await import("./raw-sql-widget")
		const repaired = withScalarReduction(querySource() as never, true)
		expect(validateWidgetRenderability(widget("stat", repaired)).fatal).toEqual([])
	})

	it("an existing reduction is left alone", async () => {
		const { withScalarReduction } = await import("./raw-sql-widget")
		const explicit = {
			...querySource(),
			transform: { reduceToValue: { field: "errors", aggregate: "max" } },
		}
		expect(withScalarReduction(explicit as never, true)).toBe(explicit)
	})

	it("a non-scalar panel is never given one", async () => {
		const { withScalarReduction } = await import("./raw-sql-widget")
		const source = querySource()
		expect(withScalarReduction(source as never, false)).toBe(source)
	})
})

describe("all three write paths agree on scalar repair", () => {
	// Review finding: the batch tool validated without first applying the repair
	// that `add` and `update` both apply, so it was the strictest of the three —
	// a get_dashboard -> replace_dashboard_widgets round trip over a board holding
	// one legacy stat failed outright and saved nothing. That is the tool the docs
	// recommend over incremental calls, which made it the worst place to be strict.
	it("a scalar with no reduction is repaired, not rejected, on every path", async () => {
		const { withScalarReduction } = await import("./raw-sql-widget")
		const { resolvePanelType } = await import("./panel-type")

		for (const visualization of ["stat", "gauge"] as const) {
			const panel = resolvePanelType({ visualization })
			expect(panel.ok).toBe(true)
			if (!panel.ok) continue

			// Unrepaired: fatal, which is what every path would have returned.
			expect(
				validateWidgetRenderability(widget(visualization, querySource())).fatal.length,
			).toBeGreaterThan(0)

			// Repaired the way each path now does it: clean.
			const repaired = withScalarReduction(querySource() as never, panel.resolved.meta.isScalar)
			expect(validateWidgetRenderability(widget(visualization, repaired)).fatal).toEqual([])
		}
	})
})

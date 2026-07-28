import { describe, expect, it } from "@effect/vitest"
import { DashboardTemplatePreviewKind } from "@maple/domain/http"
import { DASHBOARD_TEMPLATES, buildTemplatePreview, listTemplateMetadata } from "./index"

const PREVIEW_KINDS = new Set<string>(DashboardTemplatePreviewKind.literals)

describe("dashboard template previews", () => {
	it("derives one preview widget per built widget, for every template", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			const preview = buildTemplatePreview(template)
			const built = template.build({})
			expect(preview.length, template.id).toBe(built.widgets.length)
			for (const widget of preview) {
				expect(PREVIEW_KINDS.has(widget.kind), `${template.id}: ${widget.kind}`).toBe(true)
				expect(widget.w, template.id).toBeGreaterThan(0)
				expect(widget.h, template.id).toBeGreaterThan(0)
				expect(widget.x, template.id).toBeGreaterThanOrEqual(0)
				expect(widget.y, template.id).toBeGreaterThanOrEqual(0)
			}
		}
	})

	// Template `y` coordinates are hand-authored and have to be recomputed by hand
	// whenever a widget's height changes. The grid's vertical compactor papers over
	// a mistake on the canvas, but the preview SVG does not — it would render
	// tiles stacked on top of each other.
	it("lays every template out as gapless, non-overlapping full-width rows", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			const widgets = template.build({}).widgets
			if (widgets.length === 0) continue

			const rows = new Map<number, typeof widgets>()
			for (const widget of widgets) {
				const row = rows.get(widget.layout.y) ?? []
				row.push(widget)
				rows.set(widget.layout.y, row)
			}

			let expectedY = 0
			for (const [y, row] of [...rows].sort(([a], [b]) => a - b)) {
				expect(y, `${template.id}: row starts at ${y}, expected ${expectedY}`).toBe(expectedY)

				const heights = new Set(row.map((w) => w.layout.h))
				expect(heights.size, `${template.id}: row y=${y} mixes heights`).toBe(1)

				const width = row.reduce((sum, w) => sum + w.layout.w, 0)
				expect(width, `${template.id}: row y=${y} spans ${width} of 12 columns`).toBe(12)

				const spans = [...row].sort((a, b) => a.layout.x - b.layout.x)
				spans.reduce((edge, w) => {
					expect(w.layout.x, `${template.id}: row y=${y} overlaps at x=${w.layout.x}`).toBe(edge)
					return edge + w.layout.w
				}, 0)

				expectedY += row[0].layout.h
			}
		}
	})

	it("exposes previews through listTemplateMetadata", () => {
		const metadata = listTemplateMetadata()
		expect(metadata.length).toBe(DASHBOARD_TEMPLATES.length)
		for (const meta of metadata) {
			const template = DASHBOARD_TEMPLATES.find((t) => t.id === meta.id)
			expect(template).toBeDefined()
			expect(meta.preview.length, meta.id).toBe(template!.build({}).widgets.length)
		}
	})

	it("maps chart display ids to line/area/bar kinds", () => {
		const postgres = DASHBOARD_TEMPLATES.find((t) => t.id === "postgres-overview")!
		const kinds = buildTemplatePreview(postgres).map((w) => w.kind)
		expect(kinds).toContain("line")
		expect(kinds).toContain("area")
	})

	// `seriesStats` is opt-in, so an omitted flag silently means "no Min/Max/Mean/
	// Last table". Templates state it outright instead, both to keep exported
	// dashboards self-describing and to force a new template author to make the
	// call: on for line charts (levels — the answer is a number), off for area/bar
	// (stacked rates and breakdowns read for shape).
	it("states seriesStats explicitly on every chart widget, per chart kind", () => {
		const EXPECTED: Record<string, boolean> = {
			"query-builder-line": true,
			"query-builder-area": false,
			"query-builder-bar": false,
		}

		let checked = 0
		for (const template of DASHBOARD_TEMPLATES) {
			for (const widget of template.build({}).widgets) {
				if (widget.visualization !== "chart") continue
				const chartId = widget.display.chartId
				const expected = chartId ? EXPECTED[chartId] : undefined
				if (expected === undefined) continue // pie/histogram/heatmap ignore the flag

				expect(
					widget.display.chartPresentation?.seriesStats,
					`${template.id}/${widget.id} (${chartId}) must state seriesStats`,
				).toBe(expected)
				checked += 1
			}
		}
		expect(checked, "expected chart widgets to check").toBeGreaterThan(0)
	})

	it("gives the blank template an empty preview", () => {
		const blank = DASHBOARD_TEMPLATES.find((t) => t.id === "blank")!
		expect(buildTemplatePreview(blank)).toEqual([])
	})
})

describe("dashboard template requirements", () => {
	// The picker states the requirement twice: a short `missing` beside the
	// template name and the `collector` in the detail panel. Both are authored
	// here rather than recovered from prose by the client, so both have to hold
	// for every template or a row renders a blank status lane.
	it("states a requirement on every template but blank", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			if (template.id === "blank") {
				expect(template.requirement, "blank needs nothing").toBeUndefined()
				continue
			}
			expect(template.requirement, template.id).toBeDefined()
			expect(template.requirement!.label.length, template.id).toBeGreaterThan(0)
			expect(template.requirement!.collector.length, template.id).toBeGreaterThan(0)
		}
	})

	it("pairs each requirement kind with the gate it actually checks", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			const requirement = template.requirement
			if (!requirement) continue
			const prefixes = template.requiredMetricPrefixes ?? []

			if (requirement.kind === "telemetry") {
				// Never gated, so it needs no short label and no call to action.
				expect(prefixes, `${template.id} is telemetry but declares prefixes`).toEqual([])
				continue
			}

			// Gated kinds must be reachable: something to check, a short status for
			// the row, and a noun for the "Set up …" button.
			expect(
				prefixes.length,
				`${template.id} is ${requirement.kind} but has no prefixes`,
			).toBeGreaterThan(0)
			expect(requirement.setupLabel, `${template.id} needs a setupLabel`).toBeDefined()

			if (requirement.kind === "integration") {
				expect(requirement.missing, `${template.id} needs an explicit missing label`).toBeDefined()
			}
			// `metrics` may omit `missing`; the picker derives `no <prefix>*`. It may
			// not omit it when the prefix is the "any metric" sentinel, which would
			// derive the meaningless "no *".
			if (requirement.kind === "metrics" && prefixes.includes("")) {
				expect(
					requirement.missing,
					`${template.id} uses the "" prefix and must state missing`,
				).toBeDefined()
			}
		}
	})

	it("derives the public requirements array from the structured requirement", () => {
		for (const meta of listTemplateMetadata()) {
			const template = DASHBOARD_TEMPLATES.find((t) => t.id === meta.id)!
			expect(meta.requirement, meta.id).toEqual(template.requirement ?? null)
			expect(meta.requirements, meta.id).toEqual(
				template.requirement ? [template.requirement.label] : [],
			)
		}
	})
})

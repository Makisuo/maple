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
		const metadata = listTemplateMetadata({ includeInternal: true })
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

	it("gives the blank template an empty preview", () => {
		const blank = DASHBOARD_TEMPLATES.find((t) => t.id === "blank")!
		expect(buildTemplatePreview(blank)).toEqual([])
	})
})

describe("internal template visibility", () => {
	// Maple-internal templates read cross-org telemetry written under Maple's own
	// org. `requiredMetricPrefixes` would only grey the card out, so customers
	// would still see the template exists — hence a hard filter, defaulting to the
	// customer-facing set so a new call site cannot leak them by omission.
	it("hides internal templates by default and reveals them on request", () => {
		const internalIds = DASHBOARD_TEMPLATES.filter((t) => t.internal).map((t) => t.id)
		expect(internalIds.length, "expected at least one internal template").toBeGreaterThan(0)

		const customerFacing = listTemplateMetadata().map((t) => t.id)
		for (const id of internalIds) {
			expect(customerFacing, `${id} must not reach customers`).not.toContain(id)
		}

		const withInternal = listTemplateMetadata({ includeInternal: true }).map((t) => t.id)
		for (const id of internalIds) {
			expect(withInternal, `${id} must be visible to the internal org`).toContain(id)
		}
		expect(withInternal.length).toBe(customerFacing.length + internalIds.length)
	})
})

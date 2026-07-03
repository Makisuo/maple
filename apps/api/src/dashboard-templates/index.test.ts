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

	it("gives the blank template an empty preview", () => {
		const blank = DASHBOARD_TEMPLATES.find((t) => t.id === "blank")!
		expect(buildTemplatePreview(blank)).toEqual([])
	})
})

import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import type { BuildSpecResult } from "@maple/query-engine/query-builder"
import { DASHBOARD_TEMPLATES } from "./index"
import type { TemplateDefinition, TemplateParameterValues } from "./types"

// "Templates never rot" guard (mirrors the widget-preset guard in
// apps/web/src/components/dashboard-builder/widgets/widget-definitions.test.ts):
// every query-builder-backed widget in every dashboard template must decode as
// a valid query draft and lower to a QuerySpec with no warnings. The original
// bug — the Node.js/JVM runtime templates using `p95_duration` on a metrics
// query, which the engine rejects outright — shipped widgets that could never
// render, and nothing caught it.

const decodeQueryDraft = Schema.decodeUnknownSync(QueryBuilderQueryDraftSchema)

function sampleParams(template: TemplateDefinition): TemplateParameterValues {
	const values: TemplateParameterValues = {}
	for (const param of template.parameters) {
		if (param.required) {
			values[param.key] = param.placeholder ?? "sample"
		}
	}
	return values
}

// Optional params usually thread scoping filters (host_name, cluster_name,
// namespace, …) into where clauses. Building with every param filled ensures
// those clauses actually lower — an optional filter the engine ignores with a
// warning (e.g. an unsupported key) must fail the guard, not silently no-op.
function allParams(template: TemplateDefinition): TemplateParameterValues {
	const values: TemplateParameterValues = {}
	for (const param of template.parameters) {
		values[param.key] = param.placeholder ?? "sample"
	}
	return values
}

function specBuilderFor(
	endpoint: string,
): ((query: Parameters<typeof buildTimeseriesQuerySpec>[0]) => BuildSpecResult) | null {
	if (endpoint === "custom_query_builder_timeseries") return buildTimeseriesQuerySpec
	if (endpoint === "custom_query_builder_breakdown") return buildBreakdownQuerySpec
	return null
}

describe("dashboard template query specs", () => {
	function checkTemplate(template: TemplateDefinition, params: TemplateParameterValues, variant: string) {
		const built = template.build(params)
		for (const widget of built.widgets) {
			const buildSpec = specBuilderFor(widget.dataSource.endpoint)
			if (!buildSpec) continue

			const rawQueries = widget.dataSource.params?.queries
			expect(Array.isArray(rawQueries), `${template.id}/${widget.id}: params.queries`).toBe(true)
			if (!Array.isArray(rawQueries)) continue
			expect(rawQueries.length, `${template.id}/${widget.id}`).toBeGreaterThan(0)

			for (const raw of rawQueries) {
				const query = decodeQueryDraft(raw)
				const result = buildSpec(query)
				const label = `${template.id}/${widget.id}/${query.name} (${variant})`
				expect(result.query, `${label}: ${result.error ?? ""}`).not.toBeNull()
				expect(result.warnings, label).toEqual([])
			}
		}
	}

	for (const template of DASHBOARD_TEMPLATES) {
		it(`${template.id} query-builder widgets lower to valid query specs`, () => {
			checkTemplate(template, sampleParams(template), "required params")
			// Second pass with every optional param filled: scoping params must
			// emit where clauses the engine actually honors — an ignored filter
			// surfaces as a warning and fails here.
			if (template.parameters.some((p) => !p.required)) {
				checkTemplate(template, allParams(template), "all params")
			}
		})
	}

	// If the query-builder endpoints are ever renamed, the loop above would
	// silently skip everything and the guard would pass vacuously. Recount here
	// (template building is pure) instead of sharing a mutable counter across
	// tests — that breaks under shuffle, sharding, and `it.only`.
	it("exercises at least one query-builder widget across templates", () => {
		let queryBuilderQueries = 0
		for (const template of DASHBOARD_TEMPLATES) {
			const built = template.build(sampleParams(template))
			for (const widget of built.widgets) {
				if (!specBuilderFor(widget.dataSource.endpoint)) continue
				const rawQueries = widget.dataSource.params?.queries
				if (Array.isArray(rawQueries)) queryBuilderQueries += rawQueries.length
			}
		}
		expect(queryBuilderQueries).toBeGreaterThan(0)
	})

	it("uses PlanetScale's canonical discovery label keys", () => {
		const template = DASHBOARD_TEMPLATES.find((candidate) => candidate.id === "planetscale")
		expect(template).toBeDefined()
		const encoded = JSON.stringify(template?.build({ database: "shop" }))
		expect(encoded).toContain("attr.planetscale_database_name")
		expect(encoded).toContain("attr.planetscale_branch_name")
		expect(encoded).not.toContain('"attr.planetscale_database"')
		expect(encoded).not.toContain('"attr.planetscale_branch"')
	})
})

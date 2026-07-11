import { describe, expect, it } from "vitest"
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { buildBreakdownQuerySpec, buildListQuerySpec } from "@/lib/query-builder/model"
import {
	funnelPresets,
	heatmapPresets,
	histogramPresets,
	listPresets,
	piePresets,
	statPresets,
	tablePresets,
	type WidgetPresetDefinition,
} from "./widget-definitions"

// "Presets never rot" guard (MAP-49): every query-builder-backed preset must
// produce a valid QuerySpec. The original bug — presets carrying group-by
// tokens the engine rejected — made every pie/funnel/histogram/heatmap preset
// render empty, and nothing caught it.

const allPresets: WidgetPresetDefinition[] = [
	...statPresets,
	...listPresets,
	...piePresets,
	...funnelPresets,
	...histogramPresets,
	...heatmapPresets,
	...tablePresets,
]

function presetQueries(preset: WidgetPresetDefinition): QueryBuilderQueryDraftPayload[] {
	const params = preset.dataSource.params as { queries?: QueryBuilderQueryDraftPayload[] } | undefined
	return params?.queries ?? []
}

describe("widget preset query specs", () => {
	for (const preset of allPresets.filter(
		(p) => p.dataSource.endpoint === "custom_query_builder_breakdown",
	)) {
		it(`${preset.id} builds a valid breakdown spec for every query`, () => {
			const queries = presetQueries(preset)
			expect(queries.length).toBeGreaterThan(0)
			for (const query of queries) {
				const result = buildBreakdownQuerySpec(query)
				expect(result.query, `${preset.id}/${query.name}: ${result.error ?? ""}`).not.toBeNull()
				expect(result.warnings, `${preset.id}/${query.name}`).toEqual([])
			}
		})
	}

	for (const preset of allPresets.filter((p) => p.dataSource.endpoint === "custom_query_builder_list")) {
		it(`${preset.id} builds a valid list spec`, () => {
			const queries = presetQueries(preset)
			expect(queries.length).toBeGreaterThan(0)
			for (const query of queries) {
				const result = buildListQuerySpec(query)
				expect(result.query, `${preset.id}/${query.name}: ${result.error ?? ""}`).not.toBeNull()
				expect(result.warnings, `${preset.id}/${query.name}`).toEqual([])
			}
		})
	}

	it("heatmap preset labels its queries Errors/OK (axis labels, not A/B)", () => {
		const heatmap = heatmapPresets.find((p) => p.id === "heatmap-errors-by-service")
		expect(heatmap).toBeDefined()
		const legends = presetQueries(heatmap!).map((q) => q.legend)
		expect(legends).toEqual(["Errors", "OK"])
	})

	it("histogram duration preset queries raw durations, not a category breakdown", () => {
		const histogram = histogramPresets.find((p) => p.id === "histogram-trace-duration")
		expect(histogram).toBeDefined()
		expect(histogram!.dataSource.endpoint).toBe("custom_query_builder_list")
		expect((histogram!.dataSource.params as { columns?: string[] }).columns).toEqual(["durationMs"])
		expect(histogram!.display.unit).toBe("duration_ms")
	})
})

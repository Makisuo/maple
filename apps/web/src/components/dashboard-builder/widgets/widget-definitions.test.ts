import { describe, expect, it } from "vitest"
import type { QueryResultContract } from "@maple/query-model"
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { buildBreakdownQuerySpec, buildListQuerySpec } from "@maple/query-engine/query-builder"
import { toInitialState } from "@/lib/query-builder/widget-builder-utils"
import {
	funnelPresets,
	hbarPresets,
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
	...hbarPresets,
	...histogramPresets,
	...heatmapPresets,
	...tablePresets,
]

function presetQueries(preset: WidgetPresetDefinition): QueryBuilderQueryDraftPayload[] {
	const dataSource = preset.dataSource
	return dataSource.kind === "query" ? [...dataSource.queries] : []
}

/**
 * v3 replaced the `custom_query_builder_*` endpoint names with `kind: "query"`
 * plus a `resultShape`, so the presets are selected by resultKind here rather than by
 * endpoint string.
 */
const hasResultKind = (preset: WidgetPresetDefinition, resultKind: QueryResultContract): boolean =>
	preset.dataSource.kind === "query" && preset.dataSource.resultShape === resultKind

describe("widget preset query specs", () => {
	for (const preset of allPresets.filter((p) => hasResultKind(p, "breakdown"))) {
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

	for (const preset of allPresets.filter((p) => hasResultKind(p, "list"))) {
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

	// The panel exists because a ranked breakdown is not a funnel. A preset that
	// forgot its group-by would lower to a single bar and quietly become one.
	it("every horizontal-bar preset groups by a category", () => {
		expect(hbarPresets.length).toBeGreaterThan(0)
		for (const preset of hbarPresets) {
			expect(hasResultKind(preset, "breakdown"), preset.id).toBe(true)
			for (const query of presetQueries(preset)) {
				expect(query.addOns?.groupBy, preset.id).toBe(true)
				expect(query.groupBy?.length ?? 0, preset.id).toBeGreaterThan(0)
			}
		}
	})

	it("histogram duration preset queries raw durations, not a category breakdown", () => {
		const histogram = histogramPresets.find((p) => p.id === "histogram-trace-duration")
		expect(histogram).toBeDefined()
		const source = histogram!.dataSource
		if (source.kind !== "query") throw new Error("expected a query data source")
		expect(source.resultShape).toBe("list")
		expect(source.columns).toEqual(["durationMs"])
		expect(histogram!.display.unit).toBe("duration_ms")
	})
})

describe("product-event funnel preset", () => {
	it("opens the editor on the Product events source with no steps yet", () => {
		const preset = funnelPresets.find((candidate) => candidate.id === "funnel-product-events")
		expect(preset).toBeDefined()
		if (!preset) return
		expect(preset.dataSource).toEqual({
			kind: "route",
			endpoint: "product_events_funnel",
			params: { steps: [] },
		})
		const state = toInitialState({
			id: "w",
			visualization: preset.visualization,
			dataSource: preset.dataSource,
			display: preset.display,
			layout: { x: 0, y: 0, w: 6, h: 4 },
		})
		expect(state.funnel.source).toBe("product_events")
		expect(state.funnel.steps).toEqual([])
	})
})

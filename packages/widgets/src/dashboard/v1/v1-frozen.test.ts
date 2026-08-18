import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DashboardWidgetV2 } from "../v2/widget"
import { WidgetDataSourceV1 } from "./data-source"
import { DashboardDocumentV1 } from "./document"
import { DashboardWidgetV1, WidgetDisplayConfigV1 } from "./widget"

// v1 has no runtime consumer: `parseStoredDashboard` migrates a stored payload
// to the current version and decodes it as v2, and migrations operate on plain
// JSON, so even a v1 snapshot out of `dashboard_versions` never touches these
// classes. They exist to *pin* the shape every pre-versioning document is stored
// in — and a frozen schema nothing exercises is just a comment that can rot.
//
// So this is what freezes it. If a change to the shared factories alters what v1
// accepts, it fails here rather than silently changing how a legacy document
// reads.

/** A pre-versioning document, exactly as such a row is stored. */
const v1Document = {
	id: "3f1b7c62-5a1e-4d0f-9a3b-6c2e8d4f1a90",
	name: "Legacy board",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "widget-1",
			visualization: "chart",
			dataSource: {
				endpoint: "custom_query_builder_timeseries",
				params: { queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }] },
			},
			display: { title: "Requests" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("the frozen v1 schema", () => {
	it("still decodes a pre-versioning document", () => {
		const decoded = Schema.decodeUnknownSync(DashboardDocumentV1)(v1Document)

		expect(decoded.name).toBe("Legacy board")
		expect(decoded.widgets).toHaveLength(1)
		// Absent `schemaVersion` is the only signal a pre-versioning row carries.
		expect(decoded.schemaVersion).toBeUndefined()
	})

	// `display.sparkline.dataSource` embeds a full data source, which is why the
	// display schema is version-parameterised at all. v1's has to keep taking v1's
	// opaque params, or a legacy sparkline stops reading.
	it("keeps a sparkline's embedded data source on the v1 shape", () => {
		const decoded = Schema.decodeUnknownSync(WidgetDisplayConfigV1)({
			title: "Requests",
			sparkline: { enabled: true, dataSource: { endpoint: "legacy_endpoint", params: { any: 1 } } },
		})

		expect(decoded.sparkline?.dataSource?.params).toEqual({ any: 1 })
	})

	it("carries widget params through as an opaque bag", () => {
		const decoded = Schema.decodeUnknownSync(WidgetDataSourceV1)({
			endpoint: "anything_at_all",
			params: { arbitrary: { nested: [1, "two", null] } },
		})

		expect(decoded.params).toEqual({ arbitrary: { nested: [1, "two", null] } })
	})

	// The whole reason a v2 exists. These are the values v1 allowed and v2 closed;
	// the v1 -> v2 migration is what reconciles them, so both halves of this
	// asymmetry need to stay true for that migration to remain meaningful.
	it.each([
		["a panel type stored as a visualization", { visualization: "bar" }],
		["an unknown visualization", { visualization: "sankey" }],
		[
			"an aggregate outside the closed set",
			{
				dataSource: {
					endpoint: "x",
					transform: { reduceToValue: { field: "value", aggregate: "median" } },
				},
			},
		],
		[
			"a sort direction outside the closed set",
			{
				dataSource: {
					endpoint: "x",
					transform: { sortBy: { field: "value", direction: "descending" } },
				},
			},
		],
	])("accepts %s, which v2 rejects", (_label, override) => {
		const widget = { ...v1Document.widgets[0], ...override }

		expect(() => Schema.decodeUnknownSync(DashboardWidgetV1)(widget)).not.toThrow()
		expect(() => Schema.decodeUnknownSync(DashboardWidgetV2)(widget)).toThrow()
	})
})

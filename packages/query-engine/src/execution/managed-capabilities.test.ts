import { describe, expect, it } from "vitest"
import { attributeIndexMode, logBodySearchMode } from "../capabilities"
import { managedWarehouseCapabilities } from "./managed-capabilities"

describe("managed warehouse capabilities", () => {
	/**
	 * The regression this guards: production capability inspection failed on
	 * every request (Tinybird answers `403` for `system.columns` and
	 * `system.data_skipping_indices`; its gateway takes ~2.2s, over the 2s
	 * budget), so every log and trace search ran with the prefilters off even
	 * though the indices are deployed. If this test says "none"/"scan" again,
	 * the managed schema is being read wrong.
	 */
	it("enables the bloom and tokenbf prefilters that the deployed schema carries", () => {
		const capabilities = managedWarehouseCapabilities()

		expect(capabilities.metadataAvailable).toBe(true)
		expect(attributeIndexMode(capabilities, "logs")).toBe("bloom")
		expect(attributeIndexMode(capabilities, "traces")).toBe("bloom")
		expect(logBodySearchMode(capabilities)).toBe("tokenbf")
	})

	it("parses the generated snapshot rather than a hand-maintained list", () => {
		const capabilities = managedWarehouseCapabilities()

		// Index rows carry the parsed type and expression, not just a name.
		expect(capabilities.indexes.get("traces.idx_span_attr_keys")).toEqual({
			table: "traces",
			name: "idx_span_attr_keys",
			type: "bloom_filter(0.01)",
			expression: "mapKeys(SpanAttributes)",
		})
		expect(capabilities.indexes.get("logs.idx_lower_body")?.type).toBe("tokenbf_v1(32768, 3, 0)")

		// Columns come from the same parse, and index lines must not leak in.
		expect(capabilities.columns.has("logs.Body")).toBe(true)
		expect(capabilities.columns.has("traces.SpanAttributes")).toBe(true)
		expect([...capabilities.columns].some((key) => key.includes("INDEX"))).toBe(false)
	})

	it("keeps full-text search unavailable — managed backends reject setting overrides", () => {
		expect(managedWarehouseCapabilities().fullTextSearchSetting).toBe("unavailable")
	})
})

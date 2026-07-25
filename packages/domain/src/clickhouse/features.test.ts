import { describe, expect, it } from "vitest"
import { clickHouseSchemaFeatures, clickHouseVersionAtLeast, featureSupportedByVersion } from "./features"

describe("ClickHouse schema features", () => {
	it("compares stable and suffixed ClickHouse versions", () => {
		expect(clickHouseVersionAtLeast("26.2.1.12", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.2.0-beta", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.1.9", "26.2.0")).toBe(false)
	})

	it("keeps text indexes version-gated and projections portable", () => {
		const text = clickHouseSchemaFeatures.find((feature) => feature.id === "search_text_v1")!
		const projection = clickHouseSchemaFeatures.find(
			(feature) => feature.id === "logs_time_projection_v1",
		)!

		expect(featureSupportedByVersion(text, "24.8.12")).toBe(false)
		expect(featureSupportedByVersion(text, "26.2.0")).toBe(true)
		expect(text.statements.join("\n")).toContain("TYPE text(tokenizer = 'array')")
		expect(text.statements.join("\n")).toContain("MATERIALIZE INDEX idx_lower_body_text")
		expect(featureSupportedByVersion(projection, "24.8.12")).toBe(true)
		expect(projection.statements.join("\n")).toContain("SELECT *")
		expect(projection.statements.join("\n")).not.toContain("OPTIMIZE TABLE")
	})
})

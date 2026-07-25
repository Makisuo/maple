import { describe, expect, it } from "vitest"
import { clickHouseSchemaFeatures, clickHouseVersionAtLeast, featureSupportedByVersion } from "./features"

describe("ClickHouse schema features", () => {
	it("compares stable and suffixed ClickHouse versions", () => {
		expect(clickHouseVersionAtLeast("26.2.1.12", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.2.0-beta", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.1.9", "26.2.0")).toBe(false)
	})

	it("keeps text indexes version-gated without automatic legacy backfills", () => {
		const text = clickHouseSchemaFeatures.find((feature) => feature.id === "search_text_v1")!

		expect(featureSupportedByVersion(text, "24.8.12")).toBe(false)
		expect(featureSupportedByVersion(text, "26.2.0")).toBe(true)
		expect(text.statements.join("\n")).toContain("TYPE text(tokenizer = 'array')")
		expect(text.statements.join("\n")).not.toContain("MATERIALIZE")
		expect(clickHouseSchemaFeatures.some((feature) => feature.id === "logs_time_projection_v1")).toBe(
			false,
		)
	})
})

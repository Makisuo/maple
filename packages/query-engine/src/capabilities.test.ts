import { describe, expect, it } from "vitest"
import {
	attributeIndexMode,
	baselineWarehouseCapabilities,
	deriveWarehouseCapabilities,
	logBodySearchMode,
} from "./capabilities"

const logsTextIndexes = [
	{ table: "logs", name: "idx_lower_body_text", type: "text", expression: "lower(Body)" },
	{ table: "logs", name: "idx_resource_attr_items_text", type: "text", expression: "" },
	{ table: "logs", name: "idx_scope_attr_items_text", type: "text", expression: "" },
	{ table: "logs", name: "idx_log_attr_items_text", type: "text", expression: "" },
] as const

const logsTextColumns = [
	{ table: "logs", name: "ResourceAttributeItems" },
	{ table: "logs", name: "ScopeAttributeItems" },
	{ table: "logs", name: "LogAttributeItems" },
] as const

describe("warehouse capabilities", () => {
	it("uses the conservative scan baseline when metadata is unavailable", () => {
		const capabilities = baselineWarehouseCapabilities()
		expect(logBodySearchMode(capabilities)).toBe("scan")
		expect(attributeIndexMode(capabilities, "logs")).toBe("none")
	})

	it("does not select a text query plan unless the server setting is usable", () => {
		const capabilities = deriveWarehouseCapabilities({
			serverVersion: "26.2.1",
			indexes: logsTextIndexes,
			columns: logsTextColumns,
			settings: [{ name: "enable_full_text_index", value: "0" }],
			allowSettingOverrides: false,
		})

		expect(logBodySearchMode(capabilities)).toBe("scan")
		expect(attributeIndexMode(capabilities, "logs")).toBe("none")
		expect(capabilities.fullTextSearchSetting).toBe("unavailable")
	})

	it("selects text plans when the setting is enabled or safely overridable", () => {
		for (const input of [
			{ value: "1", allowSettingOverrides: false },
			{ value: "0", allowSettingOverrides: true },
		] as const) {
			const capabilities = deriveWarehouseCapabilities({
				indexes: logsTextIndexes,
				columns: logsTextColumns,
				settings: [{ name: "enable_full_text_index", value: input.value }],
				allowSettingOverrides: input.allowSettingOverrides,
			})
			expect(logBodySearchMode(capabilities)).toBe("text")
			expect(attributeIndexMode(capabilities, "logs")).toBe("text")
		}
	})

	it("falls back from text to portable bloom and token indexes", () => {
		const capabilities = deriveWarehouseCapabilities({
			indexes: [
				{ table: "logs", name: "idx_lower_body", type: "tokenbf_v1(32768, 3, 0)" },
				...[
					"idx_resource_attr_keys",
					"idx_resource_attr_vals",
					"idx_scope_attr_keys",
					"idx_scope_attr_vals",
					"idx_log_attr_keys",
					"idx_log_attr_vals",
				].map((name) => ({ table: "logs", name, type: "bloom_filter(0.01)" })),
			],
			columns: [],
		})

		expect(logBodySearchMode(capabilities)).toBe("tokenbf")
		expect(attributeIndexMode(capabilities, "logs")).toBe("bloom")
	})
})

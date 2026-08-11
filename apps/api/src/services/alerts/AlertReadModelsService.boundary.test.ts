import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

describe("AlertReadModelsService boundary", () => {
	it("depends on persistence and warehouse reads, not scheduler or delivery capabilities", () => {
		const imports = importSpecifiers(readModule("./AlertReadModelsService.ts"))

		expect(imports).toContain("@/platform/DatabaseLive")
		expect(imports).toContain("@/services/warehouse/WarehouseQueryService")
		for (const forbidden of [
			"AlertDestinationsService",
			"AlertRuntime",
			"EmailService",
			"Env",
			"OrgClickHouseSettingsService",
			"QueryEngineService",
			"SlackBotTokenResolver",
		]) {
			expect(imports.some((specifier) => specifier.endsWith(`/${forbidden}`))).toBe(false)
		}
	})

	it("is the capability consumed by incident, delivery, and check read handlers", () => {
		for (const path of [
			"../../routes/v2/alert-incidents.http.ts",
			"../../routes/v2/alert-deliveries.http.ts",
			"../../mcp/tools/list-alert-incidents.ts",
			"../../mcp/tools/get-incident-timeline.ts",
			"../../mcp/tools/list-alert-checks.ts",
		]) {
			const imports = importSpecifiers(readModule(path))
			expect(imports).toContain("@/services/alerts/AlertReadModelsService")
			expect(imports).not.toContain("@/services/alerts/AlertsService")
		}

		const alertRulesImports = importSpecifiers(readModule("../../routes/v2/alert-rules.http.ts"))
		expect(alertRulesImports).toContain("@/services/alerts/AlertReadModelsService")
		expect(alertRulesImports).toContain("@/services/alerts/AlertsService")
	})
})

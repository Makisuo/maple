import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

describe("AlertDestinationsService boundary", () => {
	it("stays independent from alert evaluation and warehouse services", () => {
		const source = readModule("./AlertDestinationsService.ts")
		const imports = importSpecifiers(source)

		expect(imports.filter((specifier) => specifier.startsWith("@maple/query-engine"))).toEqual([])
		for (const forbidden of [
			"QueryEngineService",
			"WarehouseQueryService",
			"OrgClickHouseSettingsService",
			"AnomalyDetectionService",
			"ErrorsService",
		]) {
			expect(imports.some((specifier) => specifier.endsWith(`/${forbidden}`))).toBe(false)
		}
		expect(source).not.toContain("WorkerEnvironment")
	})

	it("is the capability consumed by the destination HTTP group", () => {
		const source = readModule("../../routes/v2/alert-destinations.http.ts")
		const imports = importSpecifiers(source)

		expect(imports).toContain("@/services/alerts/AlertDestinationsService")
		expect(imports).not.toContain("@/services/alerts/AlertsService")
	})
})

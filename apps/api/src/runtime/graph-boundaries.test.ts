import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

const layerMembers = (source: string, name: string): ReadonlyArray<string> => {
	const block = new RegExp(`const ${name} = Layer\\.mergeAll\\(([\\s\\S]*?)\\n\\)`).exec(source)?.[1]
	if (block === undefined) throw new Error(`Layer ${name} was not found`)
	return block
		.split("\n")
		.map((line) => line.trim().replace(/,$/, ""))
		.filter((line) => line !== "")
}

describe("API runtime graph boundaries", () => {
	it("keeps the service composition root free of HTTP routes and schemas", () => {
		const imports = importSpecifiers(readModule("./service-graph.ts"))

		expect(imports.filter((specifier) => specifier.includes("/routes/"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("@maple/domain/http"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("effect/unstable/http"))).toEqual([])
	})

	it("keeps runtime entrypoints off the compatibility facade", () => {
		const runtimeEntrypoints: ReadonlyArray<
			readonly [
				source: string,
				expectedImports: ReadonlyArray<string>,
				expectedRoots: ReadonlyArray<string>,
			]
		> = [
			[
				readModule("../chat/turn-runner.ts"),
				["../runtime/mcp-service-graph"],
				["InvestigationServicesLive"],
			],
			[
				readModule("../mcp/__evals__/eval-runtime.ts"),
				["@/runtime/mcp-service-graph"],
				["McpServicesLive"],
			],
			[
				readModule("../worker.ts"),
				["./runtime/service-graph", "./runtime/mcp-service-graph"],
				["HttpServicesLive", "InvestigationServicesLive"],
			],
			[
				readModule("../workflows/InvestigationFanoutWorkflow.run.ts"),
				["../runtime/mcp-service-graph"],
				["McpServicesLive"],
			],
		]

		for (const [source, expectedImports, expectedRoots] of runtimeEntrypoints) {
			for (const expectedImport of expectedImports)
				expect(importSpecifiers(source)).toContain(expectedImport)
			expect(importSpecifiers(source).some((specifier) => /(?:^|\/)app$/.test(specifier))).toBe(false)
			for (const root of expectedRoots) expect(source).toContain(root)
			expect(source).not.toMatch(/\{\s*MainLive\s*\}/)
		}
	})

	it("keeps the headless MCP root limited to registered tool requirements", () => {
		const source = readModule("./mcp-service-graph.ts")
		const imports = importSpecifiers(source)

		expect(layerMembers(source, "McpRuntimeServicesLive")).toEqual([
			"AlertReadModelsServiceLive",
			"AlertsServiceLive",
			"DashboardPersistenceService.layer",
			"ErrorActorsServiceLive",
			"ErrorIssueWorkflowServiceLive",
			"ErrorsServiceLive",
			"QueryEngineServiceLive",
			"RecommendationIssueServiceLive",
			"SetupAuditServiceLive",
			"VcsSourceServiceLive",
			"WarehouseQueryServiceLive",
		])
		expect(source).toContain(
			"export const InvestigationServicesLive = Layer.mergeAll(McpServicesLive, InvestigationServiceLive)",
		)
		expect(imports).not.toContain("@/runtime/service-graph")
		for (const routeOnlyService of [
			"DailySpendService",
			"CloudflareAnalyticsService",
			"AnomalyDetectionService",
			"AiTriageService",
			"DigestService",
			"DemoService",
			"SlackIntegrationService",
		]) {
			expect(imports.some((specifier) => specifier.endsWith(`/${routeOnlyService}`))).toBe(false)
		}
	})
})

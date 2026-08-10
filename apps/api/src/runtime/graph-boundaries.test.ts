import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

describe("API runtime graph boundaries", () => {
	it("keeps the service composition root free of HTTP routes and schemas", () => {
		const imports = importSpecifiers(readModule("./service-graph.ts"))

		expect(imports.filter((specifier) => specifier.includes("/routes/"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("@maple/domain/http"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("effect/unstable/http"))).toEqual([])
	})

	it("keeps runtime entrypoints off the compatibility facade", () => {
		const runtimeEntrypoints: ReadonlyArray<readonly [source: string, expectedImport: string]> = [
			[readModule("../chat/turn-runner.ts"), "../runtime/service-graph"],
			[readModule("../mcp/__evals__/eval-runtime.ts"), "@/runtime/service-graph"],
			[readModule("../worker.ts"), "./runtime/service-graph"],
			[readModule("../workflows/InvestigationFanoutWorkflow.run.ts"), "../runtime/service-graph"],
		]

		for (const [source, expectedImport] of runtimeEntrypoints) {
			expect(importSpecifiers(source)).toContain(expectedImport)
			expect(importSpecifiers(source).some((specifier) => /(?:^|\/)app$/.test(specifier))).toBe(false)
		}
	})
})

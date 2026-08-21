import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./expected-failures"

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url))

const sourceFiles = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return sourceFiles(path)
		return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []
	})

describe("MCP expected failures", () => {
	it("lists every tag the dispatcher records as an expected 4xx", () => {
		// The suppression only works if the identifier the SDK matches on is the
		// same string the failure carries.
		expect([...MCP_ANTICIPATED_ERROR_IDENTIFIERS].sort()).toEqual([
			"@maple/mcp/decode-error",
			"@maple/mcp/errors/McpAuthInvalidError",
			"@maple/mcp/errors/McpAuthMissingError",
		])
	})

	// A runtime that builds MCP services but configures its tracer WITHOUT these
	// identifiers reports anticipated 4xx tool failures as Error spans carrying an
	// exception event, so they land in error tracking as unexpected errors. That is
	// exactly what `InvestigationFanoutWorkflow.run.ts` did: the auto-investigation
	// agent's decode failures were the top `investigation.hypothesis` error in
	// production, and none of them were bugs. The two facts live in different files,
	// so nothing but this test ties them together.
	it("spreads the MCP identifiers into every tracer that can run MCP tools", () => {
		const offenders = sourceFiles(SRC_ROOT).filter((path) => {
			const source = readFileSync(path, "utf8")
			const configuresTracer = source.includes("MapleCloudflareSDK.make(")
			const buildsMcpServices =
				source.includes("McpServicesLive") || source.includes("mcp-service-graph")
			if (!configuresTracer || !buildsMcpServices) return false
			return !source.includes("MCP_ANTICIPATED_ERROR_IDENTIFIERS")
		})

		expect(offenders.map((path) => path.slice(SRC_ROOT.length))).toEqual([])
	})
})

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { isDisabledToolSentinel } from "eve/tools"

/**
 * Proves the framework-tool lockdown in agent/tools/ actually takes effect.
 *
 * eve enables ten framework tools by default — including `bash`, `web_fetch`
 * (no SSRF protection, runs in the HOST process) and the sandbox file tools —
 * and none of them pass through #lib/approval.js, which only answers for
 * `maple__*` names. Since this agent reads attacker-influenced customer
 * telemetry, "which tools survive resolution" is a security boundary, not a
 * config detail, and it is decided by FILENAMES. This test reconstructs eve's
 * own resolution instead of trusting that the files were named right:
 *
 *   - the framework tool list comes from eve's real
 *     `runtime/framework-tools/index.js` (not a hand-copied list);
 *   - the slug comes from the filename, exactly as eve's `compileToolEntry`
 *     derives it (logicalPath minus `tools/`, minus extension, `/` → `-`);
 *   - "is this a disable sentinel" is eve's real `isDisabledToolSentinel`
 *     applied to the module's actual default export;
 *   - the final set applies eve's filter from `resolveRuntimeAgentGraph`:
 *     framework tools minus authored overrides minus disabled, plus authored.
 *
 * If eve renames a tool, changes the slug rule, or someone adds
 * `agent/tools/web-fetch.ts` (kebab — a file that disables nothing), this
 * fails. That matters more than usual: this app sits outside CI.
 */

const require_ = createRequire(import.meta.url)
const eveRoot = new URL(".", `file://${require_.resolve("eve/package.json")}`).href

const frameworkTools = (await import(`${eveRoot}dist/src/runtime/framework-tools/index.js`)) as {
	getAllFrameworkToolNames(): Set<string>
	getFrameworkToolDefinitions(input: { hasConnections: boolean }): ReadonlyArray<{ name: string }>
}

/** Every name eve accepts in a `disableTool()` filename. */
const ALL_FRAMEWORK_TOOL_NAMES = frameworkTools.getAllFrameworkToolNames()
/** The set eve would register for this agent (it declares a connection). */
const REGISTERED_FRAMEWORK_TOOL_NAMES = frameworkTools
	.getFrameworkToolDefinitions({ hasConnections: true })
	.map((tool) => tool.name)

const TOOLS_DIR = join(import.meta.dir, "..", "tools")

/** Mirrors eve's `compileToolEntry` slug derivation for a flat tools/ dir. */
function slugOf(fileName: string): string {
	return fileName.replace(/\.ts$/u, "")
}

const toolFiles = readdirSync(TOOLS_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))

const disabled = new Set<string>()
const authored = new Set<string>()

for (const fileName of toolFiles) {
	const slug = slugOf(fileName)
	if (!ALL_FRAMEWORK_TOOL_NAMES.has(slug)) {
		authored.add(slug)
		continue
	}
	// Framework-named file: import it and ask eve whether the default export is
	// a real sentinel (a plain `{ kind: "eve:disabled-tool" }` literal is not —
	// eve brands it).
	const module_ = (await import(join(TOOLS_DIR, fileName))) as {
		default: unknown
	}
	if (isDisabledToolSentinel(module_.default)) disabled.add(slug)
	else authored.add(slug)
}

/** eve's filter in `resolveRuntimeAgentGraph`. */
const resolvedToolNames = new Set<string>([
	...REGISTERED_FRAMEWORK_TOOL_NAMES.filter((name) => !authored.has(name) && !disabled.has(name)),
	...authored,
])

describe("framework tool lockdown", () => {
	test("every disable file names a tool eve actually knows", () => {
		// eve throws at boot for an unknown name; catching it here is the cheap
		// version of that, and it also catches a `disableTool()` hiding behind a
		// filename eve will treat as a brand-new authored tool.
		for (const fileName of toolFiles) {
			const source = readFileSync(join(TOOLS_DIR, fileName), "utf8")
			if (!source.includes("disableTool()")) continue
			expect(
				[...ALL_FRAMEWORK_TOOL_NAMES],
				`agent/tools/${fileName} exports disableTool() but "${slugOf(fileName)}" is not a framework tool name`,
			).toContain(slugOf(fileName))
		}
	})

	test("the dangerous defaults are gone from the resolved tool set", () => {
		for (const name of ["bash", "glob", "grep", "read_file", "write_file", "web_fetch", "web_search"]) {
			expect(disabled, `${name} must have a disableTool() file`).toContain(name)
			expect(resolvedToolNames, `${name} must not survive tool resolution`).not.toContain(name)
		}
	})

	test("the tools the agent genuinely needs survive", () => {
		// ask_question = the HITL clarifying-question prompt Slack renders;
		// todo = durable per-session task list, app-runtime only, no egress;
		// load_skill = how agent/skills/* reach the model at all.
		for (const name of ["ask_question", "todo", "load_skill"]) {
			expect(resolvedToolNames).toContain(name)
		}
	})

	test("no framework tool is enabled without being accounted for", () => {
		// Forces a decision when eve adds a default: either disable it or list it
		// here with a reason.
		const KNOWN_ENABLED = new Set(["ask_question", "todo", "load_skill"])
		const unexpected = REGISTERED_FRAMEWORK_TOOL_NAMES.filter(
			(name) => resolvedToolNames.has(name) && !KNOWN_ENABLED.has(name),
		)
		expect(unexpected).toEqual([])
	})

	test("authored tools keep the names the prompts call them by", () => {
		// eve derives the tool name from the FILENAME, with no kebab→snake
		// normalization — `render-chart.ts` would register as `render-chart` and
		// instructions.md would be telling the model to call a tool that does not
		// exist.
		const instructions = readFileSync(join(import.meta.dir, "..", "instructions.md"), "utf8")
		const referenced = [...instructions.matchAll(/`([a-z][a-z0-9_]*)` tool/gu)].map((match) => match[1]!)
		expect(referenced.length).toBeGreaterThan(0)
		for (const name of referenced) {
			expect(resolvedToolNames, `instructions.md tells the model to call \`${name}\``).toContain(name)
		}
	})
})

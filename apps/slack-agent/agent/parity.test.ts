import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Sanity checks on the prompt + skill files ported from apps/chat-flue: the
// files exist, carry routing descriptions, use eve's `maple__` tool prefix,
// and left none of chat-flue's web-only syntax behind.

const agentDir = import.meta.dir

const read = (...parts: string[]): string => readFileSync(join(agentDir, ...parts), "utf8")

const PROMPT_FILES = {
	"instructions.md": read("instructions.md"),
	"skills/dashboard-builder/SKILL.md": read("skills", "dashboard-builder", "SKILL.md"),
	"skills/incident-investigation/SKILL.md": read("skills", "incident-investigation", "SKILL.md"),
} as const

describe("prompt files", () => {
	test("instructions.md declares the maple__ tool prefix", () => {
		expect(PROMPT_FILES["instructions.md"]).toContain("`maple__<tool>`")
		expect(PROMPT_FILES["instructions.md"]).toContain("maple__find_errors")
	})

	test("packaged skills carry description frontmatter as a routing hint", () => {
		for (const file of [
			"skills/dashboard-builder/SKILL.md",
			"skills/incident-investigation/SKILL.md",
		] as const) {
			const content = PROMPT_FILES[file]
			expect(content.startsWith("---\n")).toBe(true)
			const frontmatter = content.split("---")[1] ?? ""
			expect(frontmatter).toMatch(/description:\s*Use when/)
		}
	})

	test("no chat-flue web-only syntax remains", () => {
		for (const [file, content] of Object.entries(PROMPT_FILES)) {
			expect(content, `${file} must not use the Flue MCP prefix`).not.toContain("mcp__maple__")
			expect(content, `${file} must not use inline reference cards`).not.toContain("<<maple:")
			expect(content, `${file} must not reference submit_diagnosis (web-only tool)`).not.toContain(
				"submit_diagnosis",
			)
		}
	})

	test("skills tell the model the short names need the maple__ prefix", () => {
		expect(PROMPT_FILES["skills/dashboard-builder/SKILL.md"]).toContain("maple__")
		expect(PROMPT_FILES["skills/incident-investigation/SKILL.md"]).toContain("maple__")
	})

	test("instructions.md keeps the not-linked fallback guidance", () => {
		expect(PROMPT_FILES["instructions.md"]).toContain("Integrations → Slack")
	})
})

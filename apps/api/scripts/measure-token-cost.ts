/**
 * Measure the token cost of the MCP tool definitions (name + description +
 * input JSON schema). Tool descriptions are a real context-budget cost; this
 * makes growth visible and lets CI diff PRs against main.
 *
 *   bun run measure-tokens            # print a sorted table
 *   bun run measure-tokens -- -o token-stats.json   # also write JSON
 */
import { writeFileSync } from "node:fs"
import { encode } from "gpt-tokenizer"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"

interface ToolTokens {
	readonly name: string
	readonly tokens: number
	readonly descriptionTokens: number
	readonly schemaTokens: number
}

const measure = (): { total: number; tools: ToolTokens[] } => {
	const tools = mapleToolCatalog.map((definition): ToolTokens => {
		const schema = JSON.stringify(toInputSchema(definition.schema))
		const nameTokens = encode(definition.name).length
		const descriptionTokens = encode(definition.description).length
		const schemaTokens = encode(schema).length
		return {
			name: definition.name,
			descriptionTokens,
			schemaTokens,
			tokens: nameTokens + descriptionTokens + schemaTokens,
		}
	})
	tools.sort((a, b) => b.tokens - a.tokens)
	const total = tools.reduce((sum, t) => sum + t.tokens, 0)
	return { total, tools }
}

const args = process.argv.slice(2)
const outIndex = args.indexOf("-o")
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined

const { total, tools } = measure()

if (outFile) {
	writeFileSync(outFile, `${JSON.stringify({ total, toolCount: tools.length, tools }, null, 2)}\n`)
}

const pad = (value: string, width: number): string => value.padEnd(width)
console.log(pad("tool", 32) + pad("total", 8) + pad("desc", 8) + "schema")
console.log("-".repeat(56))
for (const tool of tools) {
	console.log(
		pad(tool.name, 32) +
			pad(String(tool.tokens), 8) +
			pad(String(tool.descriptionTokens), 8) +
			String(tool.schemaTokens),
	)
}
console.log("-".repeat(56))
console.log(`${pad("TOTAL", 32)}${total}  (${tools.length} tools)`)

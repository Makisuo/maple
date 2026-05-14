import { optionalStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { describeWarehouseTable, listWarehouseTables } from "../lib/warehouse-catalog"

const TOOL = "describe_warehouse_tables"

export function registerDescribeWarehouseTablesTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Discover ClickHouse tables and columns available for the `raw_sql_chart` widget path of `add_dashboard_widget` (and any other ad-hoc warehouse SQL). Call with no arguments to list every table (name, description, column count). Pass `table` to get the full column list (`name`, `type`, optional `jsonPath`) plus hand-curated notes (enum casing, units, sort-key hints) for that table. Use this BEFORE writing raw SQL so you don't hallucinate table or column names.",
		Schema.Struct({
			table: optionalStringParam(
				"Optional table name. If provided, returns full column list and notes for that table. If omitted, lists every available table with a short description.",
			),
		}),
		Effect.fn("McpTool.describeWarehouseTables")(function* ({ table }) {
			if (typeof table === "string" && table.trim().length > 0) {
				const info = describeWarehouseTable(table.trim())
				if (!info) {
					const all = listWarehouseTables()
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `No table named "${table}". Available tables: ${all
									.map((t) => t.name)
									.join(", ")}.`,
							},
						],
					}
				}

				const lines: string[] = [`## \`${info.name}\``]
				if (info.description) lines.push("", info.description)

				lines.push("", "### Columns")
				for (const c of info.columns) {
					lines.push(
						`- \`${c.name}\` — ${c.type}${c.jsonPath ? ` (jsonPath: \`${c.jsonPath}\`)` : ""}`,
					)
				}

				if (info.sortingKey) {
					const key = Array.isArray(info.sortingKey)
						? info.sortingKey.join(", ")
						: info.sortingKey
					lines.push("", `### Sorting key`, `\`(${key})\` — filter on these for fast queries.`)
				}

				if (info.notes && info.notes.length > 0) {
					lines.push("", "### Notes")
					for (const n of info.notes) lines.push(`- ${n}`)
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
				}
			}

			const tables = listWarehouseTables()
			const lines = [
				`## Warehouse tables (${tables.length})`,
				"",
				"| Table | Description | Columns |",
				"|---|---|---|",
				...tables.map(
					(t) =>
						`| \`${t.name}\` | ${t.description ?? "—"} | ${t.columnCount} |`,
				),
				"",
				`Call this tool with \`table: "<name>"\` to get the full column list and notes for one table.`,
			]
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
			}
		}),
	)
}

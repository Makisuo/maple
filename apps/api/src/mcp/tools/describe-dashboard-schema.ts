import { optionalStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import {
	DASHBOARD_SCHEMA_SECTIONS,
	isDashboardSchemaSection,
	renderDashboardSchemaIndex,
	renderDashboardSchemaSection,
} from "@/mcp/lib/dashboard-schema-doc"

const TOOL = "describe_dashboard_schema"

export function registerDescribeDashboardSchemaTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Discover what a dashboard widget can be: every panel type, the four data-source kinds, the unit vocabulary, valid aggregations and group-by tokens, and the display config. Call it before authoring or editing widgets — the tables are generated from the live schema, so unlike a remembered example they cannot be out of date.",
		Schema.Struct({
			section: optionalStringParam(
				`Optional section: ${DASHBOARD_SCHEMA_SECTIONS.join(", ")}. Omit for an index plus the panel-type table.`,
			),
		}),
		Effect.fn("McpTool.describeDashboardSchema")(function* ({ section }) {
			const requested = section?.trim()
			if (requested) {
				if (!isDashboardSchemaSection(requested)) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `No section named "${requested}". Available sections: ${DASHBOARD_SCHEMA_SECTIONS.join(", ")}. Omit \`section\` for the index.`,
							},
						],
					}
				}
				return {
					content: [{ type: "text" as const, text: renderDashboardSchemaSection(requested) }],
				}
			}

			return { content: [{ type: "text" as const, text: renderDashboardSchemaIndex() }] }
		}),
	)
}

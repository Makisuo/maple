import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { McpSection } from "@/components/settings/mcp-section"

export const Route = createFileRoute("/mcp")({
	component: McpPage,
})

// Standalone page for the same MCP setup UI rendered by /settings?tab=mcp.
// Both render <McpSection /> so the endpoint, generated client configs, and the
// key-creation flow can't drift apart.
function McpPage() {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "MCP" }]}
			title="MCP Server"
			description="Connect your AI coding assistant to Maple's observability data via the Model Context Protocol."
		>
			<McpSection />
		</DashboardLayout>
	)
}

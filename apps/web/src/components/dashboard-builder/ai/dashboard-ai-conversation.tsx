import type { DashboardWidget } from "@/components/dashboard-builder/types"

interface DashboardAiConversationProps {
	dashboardName: string
	widgets: DashboardWidget[]
}

/**
 * Dashboard AI is temporarily disabled while the chat backbone is being
 * migrated to Electric Agents. The Maple-specific tools (test_widget_query,
 * add_dashboard_widget, etc.) need to be re-wrapped as Electric Agents tools
 * before this panel can come back. Use the main /chat page for general
 * questions in the meantime.
 */
export function DashboardAiConversation(_props: DashboardAiConversationProps) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
				Dashboard AI
			</p>
			<p className="max-w-xs text-sm text-muted-foreground">
				The dashboard widget builder is being upgraded to the new agent
				runtime. Use the main <span className="font-medium">/chat</span> page
				for general questions, or add widgets manually for now.
			</p>
		</div>
	)
}

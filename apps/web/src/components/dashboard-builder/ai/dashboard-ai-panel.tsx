import { ChatBubbleSparkleIcon, XmarkIcon } from "@/components/icons"
import { DashboardAiConversation } from "./dashboard-ai-conversation"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

interface DashboardAiPanelProps {
	onOpenChange: (open: boolean) => void
	dashboardName: string
	widgets: DashboardWidget[]
}

export function DashboardAiPanel({ onOpenChange, dashboardName, widgets }: DashboardAiPanelProps) {
	return (
		<div className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
			<div className="flex items-center gap-2 border-b px-4 py-3">
				<ChatBubbleSparkleIcon className="size-4" />
				<h2 className="text-sm font-medium">Dashboard AI</h2>
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
				>
					<XmarkIcon className="size-4" />
				</button>
			</div>
			<div className="flex-1 min-h-0">
				<DashboardAiConversation dashboardName={dashboardName} widgets={widgets} />
			</div>
		</div>
	)
}

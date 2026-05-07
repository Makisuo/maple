import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { CircleWarningIcon } from "@/components/icons"

const TOOL_LABELS: Record<string, string> = {
	create_dashboard: "Create dashboard",
	update_dashboard: "Update dashboard",
	add_dashboard_widget: "Add dashboard widget",
	update_dashboard_widget: "Update dashboard widget",
	remove_dashboard_widget: "Remove dashboard widget",
	reorder_dashboard_widgets: "Reorder dashboard widgets",
	create_alert_rule: "Create alert rule",
	transition_error_issue: "Transition error issue",
	claim_error_issue: "Claim error issue",
	release_error_issue: "Release error issue",
	comment_on_error_issue: "Comment on error issue",
	propose_fix: "Propose fix",
	update_error_notification_policy: "Update error notification policy",
}

interface ApprovalCardProps {
	toolName: string
	input: unknown
	approvalId: string
	onApprove: (approvalId: string) => void | PromiseLike<void>
	onDeny: (approvalId: string) => void | PromiseLike<void>
}

export function ApprovalCard({ toolName, input, approvalId, onApprove, onDeny }: ApprovalCardProps) {
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
	const label = TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ")

	const handle = (action: "approve" | "deny") => async () => {
		setBusy(action)
		try {
			if (action === "approve") await onApprove(approvalId)
			else await onDeny(approvalId)
		} finally {
			setBusy(null)
		}
	}

	const inputJson = (() => {
		try {
			return JSON.stringify(input, null, 2)
		} catch {
			return String(input)
		}
	})()

	return (
		<div className="my-2 overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/5 text-xs">
			<div className="flex items-center gap-2 px-3 py-2">
				<CircleWarningIcon className="size-3.5 shrink-0 text-amber-500" />
				<span className="font-medium">Approval required: {label}</span>
			</div>
			<div className="border-t border-amber-500/20 bg-background/50 p-3">
				<div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Input</div>
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
					{inputJson}
				</pre>
				<div className="mt-3 flex gap-2">
					<Button
						type="button"
						size="sm"
						onClick={handle("approve")}
						disabled={busy !== null}
					>
						{busy === "approve" ? "Approving…" : "Approve"}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={handle("deny")}
						disabled={busy !== null}
					>
						{busy === "deny" ? "Denying…" : "Deny"}
					</Button>
				</div>
			</div>
		</div>
	)
}

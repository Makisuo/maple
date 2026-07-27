import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
} from "@/components/icons"
import { toolLabel } from "@/components/ai-elements/tool-metadata"
import { ApprovalSummary, safeStringify } from "./approval-renderers"


interface ApprovalCardProps {
	toolName: string
	input: unknown
	/** Terminal state once the user has acted. Applies happen out-of-band (no agent round-trip). */
	resolved?: "applied" | "denied"
	onApprove: () => void | Promise<void>
	onDeny: () => void | Promise<void>
}

export function ApprovalCard({ toolName, input, resolved, onApprove, onDeny }: ApprovalCardProps) {
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
	const [showRaw, setShowRaw] = useState(false)
	const label = toolLabel(toolName)

	const handle = (action: "approve" | "deny") => async () => {
		setBusy(action)
		try {
			if (action === "approve") await onApprove()
			else await onDeny()
		} finally {
			setBusy(null)
		}
	}

	return (
		<div className="my-2 overflow-hidden rounded-xl border border-warning/40 bg-warning/5 text-xs">
			<div className="flex items-center gap-2 px-3 py-2">
				<CircleWarningIcon className="size-3.5 shrink-0 text-warning" />
				<span className="font-medium">Approval required: {label}</span>
			</div>
			<div className="border-t border-warning/20 bg-background/50 p-3">
				<ApprovalSummary toolName={toolName} input={input} />

				<button
					type="button"
					onClick={() => setShowRaw((v) => !v)}
					className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
				>
					{showRaw ? (
						<ChevronDownIcon className="size-3" />
					) : (
						<ChevronRightIcon className="size-3" />
					)}
					{showRaw ? "Hide raw input" : "Show raw input"}
				</button>
				{showRaw ? (
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
						{safeStringify(input)}
					</pre>
				) : null}

				{resolved === "applied" ? (
					<div className="mt-3 flex items-center gap-1.5 font-medium text-success">
						<CircleCheckIcon className="size-3.5 shrink-0" />
						Applied
					</div>
				) : resolved === "denied" ? (
					<div className="mt-3 flex items-center gap-1.5 font-medium text-muted-foreground">
						<CircleXmarkIcon className="size-3.5 shrink-0" />
						Denied
					</div>
				) : (
					<div className="mt-3 flex gap-2">
						<Button type="button" size="sm" onClick={handle("approve")} disabled={busy !== null}>
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
				)}
			</div>
		</div>
	)
}

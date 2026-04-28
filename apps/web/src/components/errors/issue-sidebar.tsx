import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { getServiceColorClass } from "@maple/ui/lib/colors"

import { PRIORITY_LABEL, PriorityBarsIcon } from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"

import { ActorChip } from "./actor-chip"
import { clampPriority, shortIssueId } from "./issue-id"
import { IssueNotesCallout } from "./issue-notes-callout"
import { LeaseHud } from "./lease-hud"
import { StateSelect } from "./state-select"

type Busy = "state" | "claim" | "release" | "heartbeat" | "comment" | null

interface IssueSidebarProps {
	issue: ErrorIssueDocument
	totalInWindow: number
	busy: Busy
	onTransition: (next: WorkflowState) => void
	onClaim: () => void
	onHeartbeat: () => void
	onRelease: () => void
}

export function IssueSidebar({
	issue,
	totalInWindow,
	busy,
	onTransition,
	onClaim,
	onHeartbeat,
	onRelease,
}: IssueSidebarProps) {
	const priority = clampPriority(issue.priority)
	const isTerminal = issue.workflowState === "cancelled" || issue.workflowState === "done"
	const canClaim = !issue.leaseHolder && !isTerminal

	return (
		<div className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<SidebarGroup label="Details">
				<Row label="Status">
					<StateSelect
						current={issue.workflowState}
						disabled={busy === "state"}
						onChange={onTransition}
					/>
				</Row>
				<Row label="Priority">
					<span className="flex items-center gap-2">
						<PriorityBarsIcon level={priority} size={12} />
						<span className="text-sm text-foreground">{PRIORITY_LABEL[priority]}</span>
					</span>
				</Row>
				<Row label="Assignee">
					<ActorChip actor={issue.assignedActor} />
				</Row>
				<Row label="Service" title={issue.serviceName}>
					<span className="flex min-w-0 items-center gap-2">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								getServiceColorClass(issue.serviceName),
							)}
						/>
						<span className="truncate text-sm text-foreground">{issue.serviceName}</span>
					</span>
				</Row>
				<Row label="Issue ID">
					<code className="font-mono text-xs tabular-nums text-muted-foreground">
						{shortIssueId(issue.id)}
					</code>
				</Row>
			</SidebarGroup>

			<SidebarGroup label="Lease">
				{issue.leaseHolder && issue.leaseExpiresAt ? (
					<div className="space-y-2">
						<LeaseHud
							leaseHolder={issue.leaseHolder}
							leaseExpiresAt={issue.leaseExpiresAt}
							claimedAt={issue.claimedAt}
						/>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								className="flex-1"
								onClick={onHeartbeat}
								disabled={busy === "heartbeat"}
							>
								Heartbeat
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="flex-1"
								onClick={onRelease}
								disabled={busy === "release"}
							>
								Release
							</Button>
						</div>
					</div>
				) : canClaim ? (
					<Button size="sm" className="w-full" onClick={onClaim} disabled={busy === "claim"}>
						Claim
					</Button>
				) : (
					<p className="text-xs text-muted-foreground">Unclaimed</p>
				)}
			</SidebarGroup>

			<SidebarGroup label="Activity">
				<Row label="Events (total)">
					<span className="text-right tabular-nums text-foreground">
						{issue.occurrenceCount.toLocaleString()}
					</span>
				</Row>
				<Row label="Events (window)">
					<span className="text-right tabular-nums text-foreground">
						{totalInWindow.toLocaleString()}
					</span>
				</Row>
				<Row label="First seen" title={new Date(issue.firstSeenAt).toLocaleString()}>
					<span className="text-right tabular-nums text-muted-foreground">
						{formatRelativeTime(issue.firstSeenAt)}
					</span>
				</Row>
				<Row label="Last seen" title={new Date(issue.lastSeenAt).toLocaleString()}>
					<span className="text-right tabular-nums text-foreground">
						{formatRelativeTime(issue.lastSeenAt)}
					</span>
				</Row>
			</SidebarGroup>

			{issue.notes ? (
				<SidebarGroup label="Notes">
					<IssueNotesCallout notes={issue.notes} />
				</SidebarGroup>
			) : null}
		</div>
	)
}

function SidebarGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-b border-border/40 p-4 last:border-b-0">
			<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
	return (
		<div title={title} className="grid min-h-8 grid-cols-[88px_1fr] items-center gap-x-3 py-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}

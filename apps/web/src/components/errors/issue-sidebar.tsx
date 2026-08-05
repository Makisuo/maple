import type { ErrorIssueDocument, IssueSeverity, WorkflowState } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { PRIORITY_LABEL, PriorityBarsIcon } from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { normalizeTimestampInput } from "@/lib/timezone-format"

import { ActorChip } from "./actor-chip"
import { clampPriority, shortIssueId } from "./issue-id"
import { IssueNotesCallout } from "./issue-notes-callout"
import { LeaseHud } from "./lease-hud"
import { SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_SOURCE_LABEL, SEVERITY_TONE } from "./severity-badge"
import { StateSelect } from "./state-select"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { DetailRail } from "@maple/ui/components/detail-rail"

type Busy = "state" | "claim" | "release" | "heartbeat" | "comment" | "severity" | "investigation" | null

const SEVERITY_NONE = "none" as const

interface IssueSidebarProps {
	issue: ErrorIssueDocument
	totalInWindow: number
	busy: Busy
	onTransition: (next: WorkflowState) => void
	onClaim: () => void
	onHeartbeat: () => void
	onRelease: () => void
	onSetSeverity: (next: IssueSeverity | null) => void
}

export function IssueSidebar({
	issue,
	totalInWindow,
	busy,
	onTransition,
	onClaim,
	onHeartbeat,
	onRelease,
	onSetSeverity,
}: IssueSidebarProps) {
	const priority = clampPriority(issue.priority)
	const isTerminal = issue.workflowState === "cancelled" || issue.workflowState === "done"
	const canClaim = !issue.leaseHolder && !isTerminal

	return (
		<div className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<DetailRail.Group label="Details">
				<DetailRail.Row label="Status">
					<StateSelect
						current={issue.workflowState}
						disabled={busy === "state"}
						onChange={onTransition}
					/>
				</DetailRail.Row>
				<DetailRail.Row label="Severity">
					<div className="flex w-full flex-col items-end gap-0.5">
						<Select
							value={issue.severity ?? SEVERITY_NONE}
							disabled={busy === "severity"}
							onValueChange={(value) =>
								onSetSeverity(value === SEVERITY_NONE ? null : (value as IssueSeverity))
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Severity" />
							</SelectTrigger>
							<SelectContent>
								{SEVERITY_ORDER.map((value) => (
									<SelectItem key={value} value={value}>
										<span className={cn("rounded px-1", SEVERITY_TONE[value])}>
											{SEVERITY_LABEL[value]}
										</span>
									</SelectItem>
								))}
								<SelectItem value={SEVERITY_NONE}>Not set</SelectItem>
							</SelectContent>
						</Select>
						{issue.severitySource ? (
							<span className="text-[11px] text-muted-foreground">
								{SEVERITY_SOURCE_LABEL[issue.severitySource]}
							</span>
						) : null}
					</div>
				</DetailRail.Row>
				<DetailRail.Row label="Priority">
					<span className="flex items-center gap-2">
						<PriorityBarsIcon level={priority} size={12} />
						<span className="text-sm text-foreground">{PRIORITY_LABEL[priority]}</span>
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Assignee">
					<ActorChip actor={issue.assignedActor} />
				</DetailRail.Row>
				<DetailRail.Row label="Service" title={issue.serviceName}>
					<span className="flex min-w-0 items-center gap-2">
						<ServiceDot serviceName={issue.serviceName} className="size-1.5" />
						<span className="truncate text-sm text-foreground">{issue.serviceName}</span>
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Issue ID">
					<code className="font-mono text-xs tabular-nums text-muted-foreground">
						{shortIssueId(issue.id)}
					</code>
				</DetailRail.Row>
			</DetailRail.Group>

			<DetailRail.Group label="Lease">
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
			</DetailRail.Group>

			<DetailRail.Group label="Activity">
				<DetailRail.Row label="Events (total)">
					<span className="text-right tabular-nums text-foreground">
						{issue.occurrenceCount.toLocaleString()}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Events (window)">
					<span className="text-right tabular-nums text-foreground">
						{totalInWindow.toLocaleString()}
					</span>
				</DetailRail.Row>
				<DetailRail.Row
					label="First seen"
					title={new Date(normalizeTimestampInput(issue.firstSeenAt)).toLocaleString()}
				>
					<span className="text-right tabular-nums text-muted-foreground">
						{formatRelativeTime(issue.firstSeenAt)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row
					label="Last seen"
					title={new Date(normalizeTimestampInput(issue.lastSeenAt)).toLocaleString()}
				>
					<span className="text-right tabular-nums text-foreground">
						{formatRelativeTime(issue.lastSeenAt)}
					</span>
				</DetailRail.Row>
			</DetailRail.Group>

			{issue.notes ? (
				<DetailRail.Group label="Notes">
					<IssueNotesCallout notes={issue.notes} />
				</DetailRail.Group>
			) : null}
		</div>
	)
}

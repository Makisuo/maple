import type { ErrorIssueDocument, IssueSeverity, WorkflowState } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"

import { PRIORITY_LABEL, PriorityBarsIcon } from "@/components/icons"

import { ActorChip } from "./actor-chip"
import { clampPriority, shortIssueId } from "./issue-id"
import { IssueNotesCallout } from "./issue-notes-callout"
import { LeaseHud } from "./lease-hud"
import { SEVERITY_SOURCE_LABEL } from "./severity-badge"
import { SeveritySelect } from "./severity-select"
import { StateSelect } from "./state-select"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { DetailRail } from "@maple/ui/components/detail-rail"

type Busy = "state" | "claim" | "release" | "heartbeat" | "comment" | "severity" | "investigation" | null

interface IssueSidebarProps {
	issue: ErrorIssueDocument
	busy: Busy
	onTransition: (next: WorkflowState) => void
	onClaim: () => void
	onHeartbeat: () => void
	onRelease: () => void
	onSetSeverity: (next: IssueSeverity | null) => void
}

export function IssueSidebar({
	issue,
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
		// No width, no border, no scroller: `PageLayout.RightSidebar` already applies
		// all three. Setting them again drew a second rule, and below `lg` — where the
		// rail becomes a `w-80` sheet — the inner `w-72` fought the sheet it was in.
		<div className="flex flex-col bg-card/30">
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
						<SeveritySelect
							value={issue.severity}
							disabled={busy === "severity"}
							onChange={onSetSeverity}
							includeNotSet
							className="w-full"
						/>
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
				{issue.resolvedVersions.length > 0 ? (
					<DetailRail.Row label="Resolved in" title={issue.resolvedVersions.join(", ")}>
						<span className="truncate font-mono text-xs text-foreground">
							{issue.resolvedVersions.join(", ")}
						</span>
					</DetailRail.Row>
				) : null}
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

			{issue.notes ? (
				<DetailRail.Group label="Notes">
					<IssueNotesCallout notes={issue.notes} />
				</DetailRail.Group>
			) : null}
		</div>
	)
}

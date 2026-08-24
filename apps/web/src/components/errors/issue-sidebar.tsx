import type {
	ErrorIssueDocument,
	ErrorIssueEnvironment,
	IssueSeverity,
	IssueSeveritySource,
	WorkflowState,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { CopyIndicator } from "@maple/ui/components/ui/copy-button"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { cn } from "@maple/ui/lib/utils"

import { PRIORITY_LABEL, PriorityBarsIcon } from "@/components/icons"

import { ActorChip } from "./actor-chip"
import { clampPriority, shortIssueId } from "./issue-id"
import { IssueNotesCallout } from "./issue-notes-callout"
import { LeaseHud } from "./lease-hud"
import { SeveritySelect } from "./severity-select"
import { StateSelect } from "./state-select"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { DetailRail } from "@maple/ui/components/detail-rail"

type Busy =
	| "state"
	| "claim"
	| "release"
	| "heartbeat"
	| "comment"
	| "severity"
	| "investigation"
	| "pull-request"
	| null

interface IssueSidebarProps {
	issue: ErrorIssueDocument
	/**
	 * Environments the fingerprint was seen in over the page's window, busiest
	 * first. The issue row has none of its own — one fingerprint spans
	 * environments — so this is window-scoped warehouse truth, not a property.
	 */
	environments: ReadonlyArray<ErrorIssueEnvironment>
	busy: Busy
	onTransition: (next: WorkflowState) => void
	onClaim: () => void
	onHeartbeat: () => void
	onRelease: () => void
	onSetSeverity: (next: IssueSeverity | null) => void
}

/**
 * Editable rail values dress as values, not as form fields. A bordered,
 * full-width Select in a column of quiet label/value rows is the one thing in
 * the rail drawn at form weight, so two of them stacked read as a form with
 * some text under it. The trigger keeps its chevron and gains a hover wash, so
 * it still announces itself as a control the moment a pointer reaches it.
 */
const GHOST_TRIGGER = cn(
	"-mr-1.5 h-7 min-h-0 w-auto min-w-0 max-w-full gap-1.5 px-1.5 text-sm font-medium",
	"border-transparent bg-transparent shadow-none before:hidden dark:bg-transparent",
	"hover:bg-muted/60 data-popup-open:bg-muted/60",
)

/**
 * Who set the severity, short enough for the rail's 88px label column — a
 * longer form like "set by AI triage" truncates there.
 */
const SEVERITY_SOURCE_HINT: Record<IssueSeveritySource, string> = {
	detector: "by detector",
	ai: "by AI triage",
	manual: "set by hand",
} satisfies Record<IssueSeveritySource, string>

export function IssueSidebar({
	issue,
	environments,
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
						className={GHOST_TRIGGER}
					/>
				</DetailRail.Row>
				<DetailRail.Row
					label="Severity"
					hint={issue.severitySource ? SEVERITY_SOURCE_HINT[issue.severitySource] : undefined}
				>
					<SeveritySelect
						value={issue.severity}
						disabled={busy === "severity"}
						onChange={onSetSeverity}
						includeNotSet
						className={GHOST_TRIGGER}
					/>
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
			</DetailRail.Group>

			<DetailRail.Group label="Scope">
				<DetailRail.Field label="Service" title={issue.serviceName}>
					<span className="flex min-w-0 items-center gap-2">
						<ServiceDot serviceName={issue.serviceName} className="size-1.5 shrink-0" />
						<span className="truncate text-sm text-foreground">{issue.serviceName}</span>
					</span>
				</DetailRail.Field>
				<DetailRail.Field
					label="Environment"
					hint={environments.length > 0 ? "in this window" : undefined}
					title={environments
						.map((env) => `${env.name} · ${env.count.toLocaleString()}`)
						.join("\n")}
				>
					<EnvironmentValue environments={environments} />
				</DetailRail.Field>
				{issue.resolvedVersions.length > 0 ? (
					<DetailRail.Row label="Resolved in" title={issue.resolvedVersions.join(", ")}>
						<span className="truncate font-mono text-xs text-foreground">
							{issue.resolvedVersions.join(", ")}
						</span>
					</DetailRail.Row>
				) : null}
				<DetailRail.Row label="Issue ID">
					<IssueIdCopy id={issue.id} />
				</DetailRail.Row>
			</DetailRail.Group>

			<DetailRail.Group label="Lease">
				{issue.leaseHolder && issue.leaseExpiresAt ? (
					<div className="flex flex-col gap-2">
						<LeaseHud
							leaseHolder={issue.leaseHolder}
							leaseExpiresAt={issue.leaseExpiresAt}
							claimedAt={issue.claimedAt}
						/>
						<div className="flex justify-end gap-1">
							<Button
								size="xs"
								variant="ghost"
								onClick={onHeartbeat}
								disabled={busy === "heartbeat"}
							>
								Extend
							</Button>
							<Button
								size="xs"
								variant="ghost"
								onClick={onRelease}
								disabled={busy === "release"}
							>
								Release
							</Button>
						</div>
					</div>
				) : (
					<DetailRail.Row label={canClaim ? "Unclaimed" : "Closed"}>
						{canClaim ? (
							<Button
								size="xs"
								variant="outline"
								className="-mr-0.5"
								onClick={onClaim}
								disabled={busy === "claim"}
							>
								Claim
							</Button>
						) : (
							<span className="text-xs text-muted-foreground">No lease needed</span>
						)}
					</DetailRail.Row>
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

/** Lines shown before the rail collapses the tail into "+N more" (the tooltip has them all). */
const ENVIRONMENT_ROWS_SHOWN = 4

/**
 * Every environment on its own line with its occurrence count — "production +1"
 * hid the one thing you open this row for, which is *where else* it's firing
 * and how much. Busiest first (the query orders by count). Empty (no telemetry
 * in the window, or no `deployment.environment` set) is the Assignee dash.
 */
function EnvironmentValue({ environments }: { environments: ReadonlyArray<ErrorIssueEnvironment> }) {
	if (environments.length === 0) return <span className="text-xs text-muted-foreground">–</span>
	const shown = environments.slice(0, ENVIRONMENT_ROWS_SHOWN)
	const hidden = environments.length - shown.length
	return (
		<ul className="flex w-full min-w-0 flex-col items-stretch gap-0.5">
			{shown.map((env) => (
				<li key={env.name} className="flex min-w-0 items-baseline justify-between gap-3">
					<span className="truncate text-sm text-foreground">{env.name}</span>
					<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
						{env.count.toLocaleString()}
					</span>
				</li>
			))}
			{hidden > 0 ? (
				<li className="text-right text-[11px] text-muted-foreground">+{hidden} more</li>
			) : null}
		</ul>
	)
}

/**
 * The short ID, and one click copies the full one. The ID was already in the
 * row; a separate copy affordance would be a second thing to find for a value
 * whose only use is being pasted somewhere else.
 */
function IssueIdCopy({ id }: { id: string }) {
	const { copy, status } = useCopy({ label: "Issue ID" })
	return (
		<button
			type="button"
			onClick={() => void copy(id)}
			title="Copy issue ID"
			className="group/copy -mr-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{shortIssueId(id)}
			<CopyIndicator
				status={status}
				size={12}
				className="opacity-0 transition-opacity group-hover/copy:opacity-100 data-[copy-status=copied]:opacity-100"
			/>
		</button>
	)
}

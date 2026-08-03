import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { cn } from "@maple/ui/lib/utils"

import { ActorAvatar } from "./actor-chip"
import { IssueContextMenu } from "./issue-context-menu"
import { IssueKindBadge } from "./kind-badge"
import { SeverityBadge } from "./severity-badge"
import { WorkflowBadge } from "./workflow-badge"
import type { IssueMutations } from "./use-issue-mutations"
import { formatNumber } from "@maple/ui/lib/format"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { ServiceDot } from "@maple/ui/components/service-dot"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function formatLastSeen(iso: string): string {
	const d = new Date(normalizeTimestampInput(iso))
	if (Number.isNaN(d.getTime())) return iso
	const diffMs = Date.now() - d.getTime()
	if (diffMs < 60_000) return "now"
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`
	if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`
	if (diffMs < WEEK_MS) return `${Math.floor(diffMs / 86_400_000)}d`
	const sameYear = d.getFullYear() === new Date().getFullYear()
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	})
}

export interface SelectToggleEvent {
	shiftKey: boolean
	metaKey: boolean
	ctrlKey: boolean
}

export interface IssueRowProps {
	issue: ErrorIssueDocument
	mutations: IssueMutations
	selected: boolean
	focused: boolean
	onSelectToggle: (id: string, event: SelectToggleEvent) => void
	onFocus: (id: string) => void
}

export function IssueRow({ issue, mutations, selected, focused, onSelectToggle, onFocus }: IssueRowProps) {
	const holderOrAssignee = issue.leaseHolder ?? issue.assignedActor
	const href = `/errors/issues/${issue.id}`

	return (
		<IssueContextMenu
			issue={issue}
			mutations={mutations}
			issueUrl={href}
			onOpenInNewTab={() => window.open(href, "_blank", "noopener,noreferrer")}
		>
			<div
				data-issue-id={issue.id}
				data-focused={focused || undefined}
				data-selected={selected || undefined}
				onMouseEnter={() => onFocus(issue.id)}
				className={cn(
					"group/row relative flex h-10 items-center gap-2 pr-3 pl-2 text-sm",
					"hover:bg-muted/50",
					"data-focused:bg-muted/40",
					"data-selected:bg-primary/10 data-selected:hover:bg-primary/15",
					"transition-colors",
				)}
			>
				<Link
					to="/errors/issues/$issueId"
					params={{ issueId: issue.id }}
					aria-label={`Open ${issue.exceptionType || "issue"}`}
					className="absolute inset-0 focus-visible:outline-none"
					tabIndex={-1}
				/>

				<span
					className={cn(
						"relative z-10 flex w-4 shrink-0 items-center justify-center",
						"opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100",
						selected && "opacity-100",
					)}
					onClick={(e) => {
						e.stopPropagation()
						e.preventDefault()
						onSelectToggle(issue.id, {
							shiftKey: e.shiftKey,
							metaKey: e.metaKey,
							ctrlKey: e.ctrlKey,
						})
					}}
				>
					<Checkbox
						aria-label={`Select issue ${issue.exceptionType || issue.id}`}
						checked={selected}
						tabIndex={-1}
						onClick={(e) => e.preventDefault()}
					/>
				</span>

				<span
					className="relative z-10 flex w-[60px] shrink-0 items-center"
					title={issue.severity ? `Severity: ${issue.severity}` : "Severity not set"}
				>
					<SeverityBadge
						severity={issue.severity}
						className="h-5 max-w-full truncate px-1.5 text-[10px]"
					/>
				</span>

				<span className="relative z-10 w-[58px] shrink-0" title={`Source: ${issue.kind}`}>
					<IssueKindBadge kind={issue.kind} className="h-5 px-1.5 text-[10px]" />
				</span>

				<span className="relative z-0 min-w-0 flex-1 truncate text-foreground">
					{issue.exceptionType || "Unknown issue"}
					{issue.exceptionMessage ? (
						<span className="ml-2 text-muted-foreground">{issue.exceptionMessage}</span>
					) : null}
				</span>

				<span
					className="relative z-10 hidden w-[120px] shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex"
					title={issue.serviceName}
				>
					<ServiceDot serviceName={issue.serviceName} className="size-1.5" />
					<span className="truncate">{issue.serviceName}</span>
				</span>

				<span className="relative z-10 hidden w-[84px] shrink-0 lg:block">
					{issue.hasOpenIncident ? (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
							<span className="size-1.5 rounded-full bg-destructive" />
							Open incident
						</span>
					) : (
						<WorkflowBadge state={issue.workflowState} />
					)}
				</span>

				<span
					className="relative z-10 hidden shrink-0 text-right text-xs tabular-nums text-muted-foreground md:inline-block md:w-[88px]"
					title={`${issue.occurrenceCount.toLocaleString()} occurrences`}
				>
					{formatNumber(issue.occurrenceCount)}
				</span>

				<span className="relative z-10 shrink-0">
					<ActorAvatar actor={holderOrAssignee} />
				</span>

				<span
					className="relative z-10 w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
					title={`Last seen ${new Date(normalizeTimestampInput(issue.lastSeenAt)).toLocaleString()}`}
				>
					{formatLastSeen(issue.lastSeenAt)}
				</span>
			</div>
		</IssueContextMenu>
	)
}

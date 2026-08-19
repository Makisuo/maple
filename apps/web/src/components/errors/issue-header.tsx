import { Link } from "@tanstack/react-router"

import type { ErrorIssueDocument, ErrorIssueId } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { useCopy } from "@maple/ui/hooks/use-copy"

import { CopyIcon, DotsVerticalIcon, LinkIcon, PulseIcon } from "@/components/icons"
import { OpenAnomalyBadge } from "@/components/anomalies/related-anomalies-section"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { TimeRange } from "@/components/time-range-picker/types"
import { liveInvestigationSummary, resolveSignalState } from "@/lib/models/error-signal"

import { agentPromptFromIssue } from "./agent-debug-prompt"
import { SeverityBadge } from "./severity-badge"
import { SignalStateChip } from "./signal-state-chip"

/**
 * The issue's identity, its one state chip, and its one action.
 *
 * The header used to carry five badges — kind, severity, workflow, a hand-rolled
 * "Incident open" pill and the anomaly badge — plus a button and an overflow
 * menu, all in the actions slot, flat, in that order. Nothing had precedence, so
 * nothing read as important; it is the same four-badge problem `SignalStateChip`
 * was written to solve on the list, and this reaches for the same solution
 * rather than a second one.
 *
 * Shape follows `investigations/investigation-header.tsx`, whose own comment
 * says every page should: identity chips live in the title stack, and the
 * actions slot holds exactly one labelled primary plus one overflow menu.
 */
export interface IssueHeaderProps {
	issue: ErrorIssueDocument
	issueId: ErrorIssueId
	investigation: V2Investigation | null
	search: { startTime?: string; endTime?: string; timePreset?: string }
	onTimeChange: (range: TimeRange) => void
	onStartInvestigation: () => void
	startingInvestigation: boolean
}

export function IssueHeader({
	issue,
	issueId,
	investigation,
	search,
	onTimeChange,
	onStartInvestigation,
	startingInvestigation,
}: IssueHeaderProps) {
	const headline = issue.exceptionType || issue.errorLabel || "Unlabelled error"
	// Same precedence the row uses: an open incident outranks a live pass, which
	// outranks where a human left it. The linked-investigation panel below carries
	// the pass in full, so the chip losing to an incident costs nothing here.
	const state = resolveSignalState(issue, liveInvestigationSummary(investigation))

	return (
		<DashboardLayout.Header
			titleContent={
				<div className="min-w-0 space-y-2.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
						<span className="truncate">{issue.serviceName || "Unknown service"}</span>
						{/* Absorbs `IssueKindBadge`. A plain error is the default and says
						    nothing here; an alert- or integration-backed issue is worth
						    knowing before you read the title. */}
						{issue.kind === "error" ? null : (
							<>
								<span aria-hidden className="text-muted-foreground/40">
									·
								</span>
								<span>{issue.kind}</span>
							</>
						)}
					</div>
					<DashboardLayout.Title title={headline}>{headline}</DashboardLayout.Title>
					<div className="flex flex-wrap items-center gap-2">
						<SeverityBadge severity={issue.severity} />
						<SignalStateChip state={state} />
						<OpenAnomalyBadge issueId={issueId} />
					</div>
				</div>
			}
		>
			<div className="flex items-center gap-2">
				<TimeRangeHeaderControls
					startTime={search.startTime}
					endTime={search.endTime}
					presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
					onTimeChange={onTimeChange}
				/>
				{investigation ? (
					<Button
						size="sm"
						render={<Link to="/investigations/$id" params={{ id: investigation.id }} />}
					>
						<PulseIcon className="size-3.5" />
						Open investigation
					</Button>
				) : (
					<Button size="sm" disabled={startingInvestigation} onClick={onStartInvestigation}>
						<PulseIcon className="size-3.5" />
						Investigate
					</Button>
				)}
				<IssueOverflowMenu issue={issue} issueId={issueId} />
			</div>
		</DashboardLayout.Header>
	)
}

/**
 * Everything that used to be a badge or a bare text link. `useCopy` per item
 * rather than `CopyButton`, because a menu item closes the menu on click and the
 * drawn check would never be seen — the toast is the confirmation here.
 */
function IssueOverflowMenu({ issue, issueId }: { issue: ErrorIssueDocument; issueId: ErrorIssueId }) {
	const promptCopy = useCopy({ label: "Agent prompt" })
	const fingerprintCopy = useCopy({ label: "Fingerprint" })
	const linkCopy = useCopy({ label: "Issue link" })
	const ruleId = typeof issue.sourceRef?.ruleId === "string" ? issue.sourceRef.ruleId : null

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="outline" size="icon-sm" />}
				aria-label="More issue actions"
			>
				<DotsVerticalIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{issue.kind === "error" ? (
					<DropdownMenuItem onClick={() => void promptCopy.copy(agentPromptFromIssue(issue))}>
						<CopyIcon className="size-3.5" />
						Copy agent prompt
					</DropdownMenuItem>
				) : null}
				{issue.fingerprintHash ? (
					<DropdownMenuItem onClick={() => void fingerprintCopy.copy(issue.fingerprintHash)}>
						<CopyIcon className="size-3.5" />
						Copy fingerprint
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem
					onClick={() => {
						// Absolute, because the thing you paste a link into is never this app.
						const origin = typeof window === "undefined" ? "" : window.location.origin
						void linkCopy.copy(`${origin}/errors/issues/${issueId}`)
					}}
				>
					<LinkIcon className="size-3.5" />
					Copy link to issue
				</DropdownMenuItem>
				{ruleId ? (
					<DropdownMenuItem render={<Link to="/alerts/$ruleId" params={{ ruleId }} />}>
						<PulseIcon className="size-3.5" />
						View alert rule
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

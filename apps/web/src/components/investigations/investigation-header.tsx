import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueSeverity } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"

import { ArrowPathIcon, DotsVerticalIcon } from "@/components/icons"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { investigationHeadline, investigationScope } from "./investigation-display"
import { InvestigationStatusBadge, investigationKindLabel } from "./investigation-status"

/** Only the four canonical severities render as a badge; anything else is unset. */
const asIssueSeverity = (value: string | null | undefined): IssueSeverity | null =>
	value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null

/**
 * Eyebrow, headline, state chips — and the lifecycle actions, which moved here
 * from the rail. They belong beside the subject they act on, and the rail now
 * leads with evidence rather than buttons.
 *
 * The snapshot facts that used to trail the title are gone: the impact strip on
 * the Overview tab says the same things in named lanes, and printing both put the
 * incident window on the page twice.
 */
export function InvestigationHeader({
	investigation,
	busy,
	onResolve,
	onRestart,
}: {
	investigation: V2Investigation
	busy: boolean
	onResolve: () => void
	onRestart: () => void
}) {
	const headline = investigationHeadline(investigation)
	const scope = investigationScope(investigation)
	const severity = asIssueSeverity(investigation.severity ?? investigation.snapshot.severity)

	return (
		<DashboardLayout.Header
			titleContent={
				<div className="min-w-0 space-y-2.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
						<span>Investigation</span>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span>{investigationKindLabel(investigation.subject)}</span>
					</div>
					<DashboardLayout.Title title={headline}>{headline}</DashboardLayout.Title>
					<div className="flex flex-wrap items-center gap-2">
						<InvestigationStatusBadge status={investigation.status} />
						{severity ? <SeverityBadge severity={severity} /> : null}
						{/* `scope` is free text and a system-seeded investigation can carry a
						    whole paragraph of it. One line, always. */}
						{scope ? (
							<span
								title={scope}
								className="min-w-0 max-w-[28rem] truncate text-sm text-muted-foreground"
							>
								{scope}
							</span>
						) : null}
					</div>
				</div>
			}
		>
			<InvestigationActions
				investigation={investigation}
				busy={busy}
				onResolve={onResolve}
				onRestart={onRestart}
			/>
		</DashboardLayout.Header>
	)
}

function InvestigationActions({
	investigation,
	busy,
	onResolve,
	onRestart,
}: {
	investigation: V2Investigation
	busy: boolean
	onResolve: () => void
	onRestart: () => void
}) {
	const status = investigation.status
	// The design puts a "Stop" here while a pass runs. There is no cancel
	// endpoint — the v2 group offers list/retrieve/create/restart/updateStatus and
	// nothing else — so a running pass gets Resolve, which is a real capability.
	// Wire Stop when the API can actually halt a run.
	const primary =
		status === "failed"
			? { label: "Retry", onClick: onRestart, variant: "default" as const }
			: status === "resolved"
				? { label: "Reopen", onClick: onRestart, variant: "outline" as const }
				: { label: "Resolve", onClick: onResolve, variant: "default" as const }

	return (
		// A flex row, not bare siblings: `PageLayout.HeaderActions` is a plain block,
		// so two `inline-flex` buttons in it lay out inline and baseline-align — and
		// the icon-only trigger has no text, so its baseline is its bottom edge and it
		// sits low against the labelled button. Every other page wraps its actions the
		// same way.
		<div className="flex items-center gap-2">
			<Button size="sm" variant={primary.variant} onClick={primary.onClick} disabled={busy}>
				{primary.label}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<Button variant="outline" size="icon-sm" />}
					aria-label="More investigation actions"
				>
					<DotsVerticalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onRestart} disabled={busy}>
						<ArrowPathIcon size={14} />
						Run again
					</DropdownMenuItem>
					{status === "resolved" ? null : (
						<DropdownMenuItem onClick={onResolve} disabled={busy}>
							Mark resolved
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

import { Link } from "@tanstack/react-router"

import type { ErrorIssueVerificationDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { formatRelativeShort } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { MagnifierCheckIcon } from "@/components/icons"

/**
 * The post-merge fix check: what it is waiting for, why that long, and what it
 * concluded.
 *
 * The "why that long" half is the part that earns the card. A window is derived
 * from the issue's own pre-merge rate, so it can be six hours for one issue and
 * nine days for the next; without the reason on screen the number reads as
 * arbitrary and the verdict that follows reads as arbitrary too.
 */

const STATUS_TONE: Record<ErrorIssueVerificationDocument["status"], string> = {
	waiting: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
	running: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
	verified: "bg-success/10 text-success",
	not_fixed: "bg-destructive/10 text-destructive",
	inconclusive: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	abandoned: "bg-muted text-muted-foreground",
} satisfies Record<ErrorIssueVerificationDocument["status"], string>

const STATUS_LABEL: Record<ErrorIssueVerificationDocument["status"], string> = {
	waiting: "Watching",
	running: "Checking",
	verified: "Fix holds",
	not_fixed: "Still broken",
	inconclusive: "Inconclusive",
	abandoned: "Stopped",
} satisfies Record<ErrorIssueVerificationDocument["status"], string>

/** A per-hour rate said the way a person would say it. */
function formatRate(perHour: number): string {
	if (perHour >= 1) {
		const rounded = perHour >= 10 ? Math.round(perHour) : Math.round(perHour * 10) / 10
		return `${rounded}× an hour`
	}
	const perDay = perHour * 24
	if (perDay >= 1) {
		const rounded = perDay >= 10 ? Math.round(perDay) : Math.round(perDay * 10) / 10
		return `${rounded}× a day`
	}
	const perWeek = perHour * 24 * 7
	const rounded = perWeek >= 10 ? Math.round(perWeek) : Math.round(perWeek * 10) / 10
	return `${rounded}× a week`
}

function headline(verification: ErrorIssueVerificationDocument): string {
	switch (verification.status) {
		case "waiting": {
			const rate =
				verification.baselineRatePerHour > 0
					? ` It was firing about ${formatRate(verification.baselineRatePerHour)} before the merge.`
					: " It fires too rarely to judge quickly, so this takes a while."
			// `formatRelativeShort` rather than `formatRelativeTime`: the latter supplies
			// its own preposition ("in 6h"), which reads as "Waiting until in 6h" here,
			// and turns into "Waiting until 3h ago" once the window closes before the
			// tick has run. The elapsed case gets its own sentence for the same reason.
			const elapsed = Date.parse(verification.verifyAfter) <= Date.now()
			if (elapsed) {
				return `The verification window has closed; the next check records the result.${rate}`
			}
			return `Watching for another ${formatRelativeShort(verification.verifyAfter)} to see whether this error comes back.${rate}`
		}
		case "running":
			return "An agent is checking whether the merged fix actually resolved this."
		case "verified":
			return "No occurrences from builds that postdate the merge. The fix holds."
		case "not_fixed":
			return `This error fired ${verification.postMergeOccurrenceCount} more time(s) from builds that postdate the merge — the fix did not resolve it.`
		case "inconclusive":
			return "There was not enough traffic after the merge to say either way."
		case "abandoned":
			return "This check stopped before reaching an answer."
	}
}

export function IssueVerificationCard({ verification }: { verification: ErrorIssueVerificationDocument }) {
	const settled =
		verification.status === "verified" ||
		verification.status === "not_fixed" ||
		verification.status === "inconclusive"

	return (
		<section className="rounded-xl border bg-card px-4 py-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<MagnifierCheckIcon className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-medium text-foreground">Fix verification</h2>
				</div>
				<Badge variant="outline" className={cn("shrink-0", STATUS_TONE[verification.status])}>
					{STATUS_LABEL[verification.status]}
				</Badge>
			</div>

			<p className="mt-2 text-xs leading-relaxed text-muted-foreground">{headline(verification)}</p>

			{verification.verdictNote && settled ? (
				<p className="mt-2 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
					{verification.verdictNote}
				</p>
			) : null}

			{/* The old clients the baseline exists to discount. Shown only when there
			    are some, because "0 from pre-merge builds" is noise. */}
			{verification.status === "verified" && verification.baselineVersions.length > 0 ? (
				<p className="mt-2 text-xs text-muted-foreground/80">
					Occurrences from builds that predate the merge were ignored — those are older clients
					still running the broken version.
				</p>
			) : null}

			{verification.investigationId ? (
				<Link
					to="/investigations/$id"
					params={{ id: verification.investigationId }}
					className="mt-2 inline-block text-xs text-primary hover:underline"
				>
					View the verification run
				</Link>
			) : null}

			{verification.attempt > 0 && verification.status === "waiting" ? (
				<p className="mt-2 text-xs text-muted-foreground/80">
					First check was inconclusive; watching for longer.
				</p>
			) : null}
		</section>
	)
}

import { Link } from "@tanstack/react-router"

import type { IssueEscalationAttemptDocument } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"

import { PulseIcon } from "@/components/icons"

/**
 * The autonomous pass attached to this issue, and how far its escalation got.
 *
 * Lifted out of the route, where it was a local component drawn on
 * `border px-4 py-3` — the one unrounded box on a page where everything else is
 * `rounded-md` or `rounded-xl`, which is exactly the kind of drift that makes a
 * page read as assembled rather than designed.
 */
export function LinkedInvestigationPanel({
	investigation,
	escalation,
	onStart,
	starting,
}: {
	investigation: V2Investigation | null
	escalation: IssueEscalationAttemptDocument | null
	onStart: () => void
	starting: boolean
}) {
	if (!investigation) {
		return (
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">No linked investigation</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Start an evidence-backed autonomous pass for this issue.
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={onStart} disabled={starting}>
					<PulseIcon className="size-3.5" />
					Start investigation
				</Button>
			</div>
		)
	}

	return (
		<div className="grid shrink-0 gap-3 rounded-xl border bg-card px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-sm font-medium text-foreground">Linked investigation</p>
					<Badge variant="outline" className="capitalize">
						{investigation.status}
					</Badge>
					{investigation.confidence ? (
						<span className="text-xs capitalize text-muted-foreground">
							{investigation.confidence} confidence
						</span>
					) : null}
				</div>
				<p className="mt-1 truncate text-sm text-muted-foreground">
					{investigation.report?.suspectedCause ??
						(investigation.status === "investigating"
							? "Gathering evidence…"
							: (investigation.error ?? "No diagnosis submitted"))}
				</p>
				{escalation ? (
					<p className="mt-1 text-xs text-muted-foreground">
						Escalation: <span className="capitalize text-foreground">{escalation.status}</span>
						{escalation.deliveries.length > 0
							? ` · ${escalation.deliveries
									.map(
										(delivery) =>
											`${delivery.destinationName ?? delivery.destinationId} ${delivery.status}`,
									)
									.join(", ")}`
							: escalation.skipReason
								? ` · ${escalation.skipReason.replaceAll("_", " ")}`
								: ""}
					</p>
				) : null}
			</div>
			<Button
				size="sm"
				variant="outline"
				render={<Link to="/investigations/$id" params={{ id: investigation.id }} />}
			>
				Open investigation
			</Button>
		</div>
	)
}

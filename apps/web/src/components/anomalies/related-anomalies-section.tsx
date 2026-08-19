import { Result, useAtomValue } from "@/lib/effect-atom"
import type { ErrorIssueId } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { anomalyIncidentFromV2 } from "@/lib/services/anomalies"
import { AnomalyRow } from "./anomaly-row"
import { SEVERITY_TONE } from "./anomaly-format"

function useRelatedAnomalies(issueId: ErrorIssueId) {
	const incidentsQueryAtom = retainedQueryV2("anomalies", "listIncidents", {
		query: { error_issue_id: issueId, limit: 50 },
		reactivityKeys: ["anomalyIncidents", `errorIssue:${issueId}:anomalies`],
	})
	return useAtomValue(incidentsQueryAtom)
}

/**
 * Detector incidents pointing at this issue. Renders nothing at all (header
 * included) when there are none, so unaffected issue pages stay unchanged.
 */
export function RelatedAnomaliesSection({ issueId }: { issueId: ErrorIssueId }) {
	const result = useRelatedAnomalies(issueId)
	const incidents = Result.builder(result)
		.onSuccess((value) => value.data.map(anomalyIncidentFromV2))
		.orElse(() => [])

	if (incidents.length === 0) return null

	const sorted = [...incidents].sort((a, b) => {
		if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1
		return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
	})

	return (
		<section aria-labelledby="related-anomalies-heading" className="flex shrink-0 flex-col gap-3.5">
			<div className="flex items-baseline gap-2.5">
				<h2
					id="related-anomalies-heading"
					className="font-display text-base font-semibold tracking-[-0.01em] text-foreground"
				>
					Related anomalies
				</h2>
				<span className="text-sm text-muted-foreground">
					{sorted.length} {sorted.length === 1 ? "detector incident" : "detector incidents"}
				</span>
			</div>
			<div className="overflow-hidden rounded-md border border-border/60 divide-y divide-border/40">
				{sorted.map((incident) => (
					<AnomalyRow key={incident.id} incident={incident} variant="compact" />
				))}
			</div>
		</section>
	)
}

/**
 * "Anomaly open" header badge — own component so the issue header never
 * blocks on the anomalies query.
 */
export function OpenAnomalyBadge({ issueId }: { issueId: ErrorIssueId }) {
	const result = useRelatedAnomalies(issueId)
	const openIncidents = Result.builder(result)
		.onSuccess((value) => value.data.filter((incident) => incident.status === "open"))
		.orElse(() => [])

	if (openIncidents.length === 0) return null

	const severity = openIncidents.some((incident) => incident.severity === "critical")
		? ("critical" as const)
		: ("warning" as const)
	const tone = SEVERITY_TONE[severity]

	return (
		<Badge variant="outline" className={tone.badge}>
			<span className="flex items-center gap-1.5">
				<span className="relative inline-flex size-1.5">
					<span
						className={cn(
							"absolute inline-flex size-full animate-ping rounded-full opacity-60",
							tone.accent,
						)}
					/>
					<span className={cn("relative inline-flex size-full rounded-full", tone.accent)} />
				</span>
				Anomaly open
			</span>
		</Badge>
	)
}

import { Result, useAtomValue } from "@/lib/effect-atom"
import type { ErrorIssueId } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { SectionHeader } from "@/components/layout/section-header"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { AnomalyRow } from "./anomaly-row"
import { SEVERITY_TONE } from "./anomaly-format"

function useRelatedAnomalies(issueId: ErrorIssueId) {
	const incidentsQueryAtom = retainedQuery("anomalies", "listIncidents", {
		query: { errorIssueId: issueId, limit: 50 },
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
		.onSuccess((value) => value.incidents)
		.orElse(() => [])

	if (incidents.length === 0) return null

	const sorted = [...incidents].sort((a, b) => {
		if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1
		return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
	})

	return (
		<section aria-labelledby="related-anomalies-heading">
			<SectionHeader id="related-anomalies-heading" label="Related anomalies" />
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
		.onSuccess((value) => value.incidents.filter((incident) => incident.status === "open"))
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

import type { V2Investigation } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

type InvestigationStatus = V2Investigation["status"]

/**
 * One vocabulary for an investigation's lifecycle, shaped like the issues
 * surface's `SeverityBadge` so the two read as the same system. The wire values
 * are lowercase enum tokens (`investigating`), which is not what a person calls
 * them — the label map is the whole point of this component existing.
 */
const STATUS: Record<InvestigationStatus, { label: string; tone: string }> = {
	investigating: { label: "In progress", tone: "bg-primary/10 text-primary" },
	diagnosed: { label: "Diagnosed", tone: "bg-success/10 text-success" },
	resolved: { label: "Resolved", tone: "bg-muted text-muted-foreground" },
	failed: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
}

export function InvestigationStatusBadge({
	status,
	className,
}: {
	status: InvestigationStatus
	className?: string
}) {
	return (
		<Badge variant="outline" className={cn(STATUS[status].tone, className)}>
			{STATUS[status].label}
		</Badge>
	)
}

/**
 * How an investigation was started. Kept to one word: it sits in a table column
 * headed "Origin", where a sentence just truncates.
 */
const ORIGIN: Record<V2Investigation["seeded_by"], string> = {
	user: "Manual",
	system: "Automatic",
}

export const investigationOriginLabel = (seededBy: V2Investigation["seeded_by"]): string => ORIGIN[seededBy]

/** What is being investigated. `freeform` is a question, not a kind of incident. */
export const investigationKindLabel = (subject: V2Investigation["subject"]): string =>
	subject.type === "freeform"
		? "Question"
		: subject.incident_kind === "error"
			? "Error"
			: subject.incident_kind === "anomaly"
				? "Anomaly"
				: "Alert"

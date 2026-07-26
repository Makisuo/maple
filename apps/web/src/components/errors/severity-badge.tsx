import type { IssueSeverity, IssueSeveritySource } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

export const SEVERITY_TONE: Record<IssueSeverity, string> = {
	critical: "bg-destructive/10 text-destructive",
	high: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
	medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	low: "bg-muted text-muted-foreground",
}

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
}

export const SEVERITY_ORDER: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"]

/** Sort rank: critical first, unset last. */
export function severityRank(severity: IssueSeverity | null): number {
	if (severity === null) return SEVERITY_ORDER.length
	return SEVERITY_ORDER.indexOf(severity)
}

export const SEVERITY_SOURCE_LABEL: Record<IssueSeveritySource, string> = {
	detector: "from detector",
	ai: "set by AI triage",
	manual: "manual override",
}

export function SeverityBadge({
	severity,
	className,
}: {
	severity: IssueSeverity | null
	className?: string
}) {
	if (severity === null) {
		return (
			<span className={cn("text-xs text-muted-foreground/60", className)} title="Severity not set">
				—
			</span>
		)
	}
	return (
		<Badge variant="outline" className={cn(SEVERITY_TONE[severity], className)}>
			{SEVERITY_LABEL[severity]}
		</Badge>
	)
}

import type { IssueSeverity } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

export const SEVERITY_TONE: Record<IssueSeverity, string> = {
	critical: "bg-destructive/10 text-destructive",
	high: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
	medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	// Sky rather than muted grey. Grey is what "unset" looks like, so a grey
	// `low` made the two indistinguishable wherever they sit next to each other
	// — most obviously in the severity filter menu, which lists both.
	low: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
} satisfies Record<IssueSeverity, string>

/**
 * Solid fills for the same four levels, for dots and chart marks where a 10%
 * tint would disappear. One source, so the badge, the filter menu and the row
 * sparkline cannot drift into three different reds.
 */
export const SEVERITY_FILL: Record<IssueSeverity, string> = {
	critical: "bg-destructive",
	high: "bg-orange-500",
	medium: "bg-amber-500",
	low: "bg-sky-500",
} satisfies Record<IssueSeverity, string>

/** `text-*` counterpart of {@link SEVERITY_FILL}, for `currentColor` SVG marks. */
export const SEVERITY_TEXT: Record<IssueSeverity, string> = {
	critical: "text-destructive",
	high: "text-orange-500 dark:text-orange-400",
	medium: "text-amber-500 dark:text-amber-400",
	low: "text-sky-500 dark:text-sky-400",
} satisfies Record<IssueSeverity, string>

/**
 * The severity blob. `null` draws a hollow ring rather than a filled dot —
 * "nobody has said how bad this is" is a different statement from "this is
 * low", and an empty outline reads that way without needing a label.
 */
export function SeverityDot({ severity, className }: { severity: IssueSeverity | null; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"size-2 shrink-0 rounded-full",
				severity === null ? "border border-muted-foreground/50" : SEVERITY_FILL[severity],
				className,
			)}
		/>
	)
}

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
} satisfies Record<IssueSeverity, string>

export const SEVERITY_ORDER: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"]

/** Sort rank: critical first, unset last. */
export function severityRank(severity: IssueSeverity | null): number {
	if (severity === null) return SEVERITY_ORDER.length
	return SEVERITY_ORDER.indexOf(severity)
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

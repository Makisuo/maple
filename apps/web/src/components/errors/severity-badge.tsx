import type { IssueSeverity } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { PixelTriangleWarningIcon } from "@/components/icons"

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
	// Blank, deliberately. This started as an em dash and then as the hollow ring
	// the filter menu uses, and both were worse the more of them there were: a
	// queue where half the fingerprints are unrated turned into a column of marks
	// standing for the absence of information. An empty slot says the same thing
	// and stops competing with the chips that do carry a rating. The width is
	// kept so the lane still lines up.
	if (severity === null) {
		return <span className={cn("inline-flex h-5", className)} title="Severity not set" />
	}

	return (
		<Badge variant="outline" className={cn(SEVERITY_TONE[severity], className)}>
			{SEVERITY_LABEL[severity]}
		</Badge>
	)
}

/**
 * The compact glyph for a row, drawn on Nucleo's pixel grid so it sits with the
 * rest of the icon set: 24-unit viewBox, 2-unit cells, square caps, nothing
 * anti-aliased into a curve. Three blocks for "nobody has said" — the mark
 * Linear uses for "no priority", which is where the eye already looks for a
 * thing to set. One, two or three bars for low, medium and high. Critical is
 * the pixel triangle-warning the rest of the app already uses, in red: the top
 * level is a different kind of statement from "a bit more than high".
 */
export function SeverityIcon({
	severity,
	size = 16,
	className,
}: {
	severity: IssueSeverity | null
	size?: number
	className?: string
}) {
	const label = severity === null ? "Severity not set" : SEVERITY_LABEL[severity]

	if (severity === "critical") {
		return (
			<PixelTriangleWarningIcon
				size={size}
				role="img"
				aria-hidden={undefined}
				aria-label={label}
				className={cn(SEVERITY_TEXT[severity], className)}
			/>
		)
	}

	const common = {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 24 24",
		width: size,
		height: size,
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 4,
		strokeLinecap: "square" as const,
		role: "img" as const,
		"aria-label": label,
	}

	if (severity === null) {
		return (
			<svg {...common} className={cn("text-muted-foreground", className)}>
				{/* Three 2×2-cell blocks on the midline. */}
				<path d="M3 12H3.01" />
				<path d="M11 12H11.01" />
				<path d="M19 12H19.01" />
			</svg>
		)
	}

	// Bars two cells wide on a shared baseline, three, five and eight cells tall.
	const filled = severity === "high" ? 3 : severity === "medium" ? 2 : 1
	const bars = ["M3 16V18", "M11 12V18", "M19 6V18"]
	return (
		<svg {...common} className={cn(SEVERITY_TEXT[severity], className)}>
			{bars.map((d, index) => (
				<path key={d} d={d} opacity={index < filled ? 1 : 0.25} />
			))}
		</svg>
	)
}

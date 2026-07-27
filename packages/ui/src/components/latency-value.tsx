import { formatLatency } from "../lib/format"
import { LATENCY_TEXT_TONE, latencyLevel, latencyLevelLabel, type LatencyScale } from "../lib/latency-tone"
import { cn } from "../lib/utils"

interface LatencyValueProps {
	ms: number
	/** Which budget the value is measured against. Defaults to "p95". */
	scale?: LatencyScale
	/** Override the scale preset, in ms — for units without a preset. */
	budgetMs?: number
	/** Override formatting, e.g. rendering "—" for a 0 that means "unavailable". */
	format?: (ms: number) => string
	className?: string
}

/**
 * A latency number, formatted and toned by magnitude. Fast values recede and
 * slow ones advance, so a percentile column can be scanned instead of read.
 * See lib/latency-tone.ts for the budgets behind each scale.
 */
export function LatencyValue({
	ms,
	scale = "p95",
	budgetMs,
	format = formatLatency,
	className,
}: LatencyValueProps) {
	const level = latencyLevel(ms, scale, budgetMs)
	return (
		<span
			title={latencyLevelLabel(level)}
			className={cn("font-mono tabular-nums", LATENCY_TEXT_TONE[level], className)}
		>
			{format(ms)}
		</span>
	)
}

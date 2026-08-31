import { cn } from "@maple/ui/lib/utils"

export type LogSearchMode = "text" | "trace" | "header"

/**
 * One hue per input shape the search box recognizes, so a row in the help sheet
 * is told apart at a glance. Text is amber because that is the colour its
 * matches are marked with in the stream; the two id shapes take the blue and
 * purple next to it. All three hold up in light and dark.
 */
const MODE = {
	text: { label: "Text", className: "bg-primary/15 text-primary" },
	trace: { label: "Trace", className: "bg-info/15 text-info" },
	header: { label: "Header", className: "bg-chart-throughput/15 text-chart-throughput" },
} satisfies Record<LogSearchMode, { label: string; className: string }>

export function LogSearchModeBadge({ mode, className }: { mode: LogSearchMode; className?: string }) {
	return (
		<span
			className={cn(
				"rounded-sm px-1 py-px font-medium text-[10px] uppercase tracking-wide",
				MODE[mode].className,
				className,
			)}
		>
			{MODE[mode].label}
		</span>
	)
}

import { cn } from "@maple/ui/lib/utils"
import type { HostStatus } from "../format"
import { STATUS_DOT, STATUS_RING } from "../severity-tokens"

interface SeverityDotProps {
	status: HostStatus
	size?: "sm" | "md"
	/**
	 * Visually-hidden status word. Pass when the dot stands alone so screen
	 * readers get the status; omit when an adjacent text label already names it.
	 */
	label?: string
	className?: string
}

/**
 * A static dot. The active state used to carry an `.infra-pulse` halo, which is
 * the right idiom for ONE beacon (a firing alert, an error state) and the wrong
 * one for a table: fifty rows all animating at once reads as decoration, not as
 * information, and every row said the same thing anyway.
 */
export function SeverityDot({ status, size = "sm", label, className }: SeverityDotProps) {
	const dim = size === "sm" ? "size-1.5" : "size-2"
	const wrap = size === "sm" ? "size-2.5" : "size-3"
	return (
		<span
			className={cn(
				"relative inline-flex items-center justify-center rounded-full ring-1 ring-inset",
				wrap,
				STATUS_RING[status],
				className,
			)}
		>
			<span className={cn("relative rounded-full", dim, STATUS_DOT[status])} />
			{label ? <span className="sr-only">{label}</span> : null}
		</span>
	)
}

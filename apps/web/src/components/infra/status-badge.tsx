import { cn } from "@maple/ui/lib/utils"
import { deriveHostStatus, type HostStatus } from "./format"
import { SeverityDot } from "./primitives/severity-dot"
import { statusLabel } from "./severity-tokens"

const STATUS_TEXT: Record<HostStatus, string> = {
	active: "text-[var(--severity-info)]",
	idle: "text-muted-foreground",
	down: "text-[var(--severity-error)]",
} satisfies Record<HostStatus, string>

interface HostStatusBadgeProps {
	lastSeen: string
	/**
	 * Reference timestamp ("as of when") for status calculation. Defaults to
	 * wall-clock now, but list pages should pass the query window's endTime so
	 * badges reflect data freshness at fetch time — not the user's idle clock.
	 */
	referenceTime?: string | number
	/**
	 * Render nothing while the resource is active.
	 *
	 * For a badge sitting INLINE beside a name, "Active" on every row is not a
	 * status, it is wallpaper — the Last seen column already carries freshness.
	 * Quiet mode turns it back into what a badge is for: the exception. A badge
	 * filling a dedicated Status COLUMN stays loud, because a column with a
	 * header needs a value in every cell.
	 */
	quiet?: boolean
	className?: string
}

export function HostStatusBadge({ lastSeen, referenceTime, quiet, className }: HostStatusBadgeProps) {
	const status = deriveHostStatus(lastSeen, referenceTime ?? Date.now())
	if (quiet && status === "active") return null
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-[11px] font-medium",
				STATUS_TEXT[status],
				className,
			)}
		>
			<SeverityDot status={status} />
			{statusLabel(status)}
		</span>
	)
}

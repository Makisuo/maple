import type { VariantProps } from "class-variance-authority"
import type { badgeVariants } from "@maple/ui/components/ui/badge"
import { CopyableBadge } from "@maple/ui/components/ui/copyable-badge"
import { cn } from "@maple/ui/lib/utils"
import { IdBadgeIcon } from "@/components/icons"

interface TraceIdBadgeProps {
	traceId: string
	/** Optional cap on the trace ID width. Omit to always show the full ID. */
	className?: string
	size?: VariantProps<typeof badgeVariants>["size"]
}

export function TraceIdBadge({ traceId, className, size = "lg" }: TraceIdBadgeProps) {
	return (
		<CopyableBadge
			value={traceId}
			label="trace ID"
			size={size}
			className={cn("gap-1.5 font-mono", className)}
		>
			<IdBadgeIcon className="text-muted-foreground" />
			<span className="min-w-0 truncate">{traceId}</span>
		</CopyableBadge>
	)
}

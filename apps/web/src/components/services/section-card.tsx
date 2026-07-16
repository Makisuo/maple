import type { ReactNode } from "react"
import { cn } from "@maple/ui/utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

interface SectionCardProps {
	title: string
	/** Trailing header slot, typically a "View all →" link. */
	action?: ReactNode
	children: ReactNode
	className?: string
}

/**
 * Quiet bordered card for the Overview tab's secondary sections (open issues,
 * recent deploys). Header typography matches the StatRail eyebrows so the strip
 * and the cards read as one system.
 */
export function SectionCard({ title, action, children, className }: SectionCardProps) {
	return (
		<div className={cn("flex flex-col rounded-md border bg-card", className)}>
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">{title}</span>
				{action}
			</div>
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	)
}

/** Relative "how long ago" label shared by the Overview tab's secondary cards.
 * Tolerates ISO and warehouse ("YYYY-MM-DD HH:mm:ss", UTC) timestamps. */
export function formatTimeAgo(iso: string): string {
	const d = new Date(normalizeTimestampInput(iso))
	if (Number.isNaN(d.getTime())) return iso
	const diffMs = Date.now() - d.getTime()
	if (diffMs < 60_000) return "now"
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
	if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
	if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`
	const sameYear = d.getFullYear() === new Date().getFullYear()
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	})
}

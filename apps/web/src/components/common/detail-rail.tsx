import type * as React from "react"

import { cn } from "@maple/ui/lib/utils"

/* -------------------------------------------------------------------------------------------------
 * DetailRail — the label/value rail every detail page hangs off its trailing edge.
 *
 * `Group` and `Row` existed as byte-identical private copies in the anomaly
 * sidebar, the issue sidebar and the recommendation route, which is how the
 * investigation page ended up reaching for stacked `Card`s instead and reading
 * like a different product. They live here now.
 *
 * Deliberately *not* the outer container: each page wraps this in its own aside
 * (widths, borders and backgrounds differ, and `PageLayout.RightSidebar` already
 * owns that job on some of them). Only the two repeated pieces are shared.
 * -----------------------------------------------------------------------------------------------*/

function Group({
	label,
	children,
	className,
}: {
	label: string
	children: React.ReactNode
	className?: string
}) {
	return (
		<section
			data-slot="detail-rail-group"
			className={cn("flex flex-col gap-2 border-b border-border/40 p-4 last:border-b-0", className)}
		>
			<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({
	label,
	title,
	children,
	/** Width of the label column. Narrow rails (recommendations) run tighter. */
	labelWidth = "88px",
}: {
	label: string
	title?: string
	children: React.ReactNode
	labelWidth?: string
}) {
	return (
		<div
			data-slot="detail-rail-row"
			title={title}
			className="grid min-h-8 items-center gap-x-3 py-0.5"
			style={{ gridTemplateColumns: `${labelWidth} 1fr` }}
		>
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}

export const DetailRail = { Group, Row }

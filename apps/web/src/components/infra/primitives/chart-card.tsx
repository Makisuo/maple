import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"

/** Every infra detail chart plots at this height, so a grid of them never staggers. */
export const CHART_HEIGHT = 200

/**
 * Card frame shared by every infra detail chart: title on the left, legend on the
 * right, and an optional scope marker next to the title saying what the panel is
 * actually filtered to (see `ScopeChip` / Cloudflare's `PanelScope`).
 */
export function ChartCard({
	title,
	legend,
	scope,
	children,
	className,
}: {
	title: string
	/**
	 * Optional: a single-series chart whose series is named by the title has
	 * nothing to disambiguate, and web analytics' chart is legended by the KPI
	 * strip above it. Multi-series charts should still pass one.
	 */
	legend?: ReactNode
	/** Scope marker: what this panel is actually filtered to. */
	scope?: ReactNode
	children: ReactNode
	className?: string
}) {
	return (
		<div className={cn("rounded-md border bg-card", className)}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[11px] font-medium text-muted-foreground">{title}</span>
					{scope}
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">{legend}</div>
			</div>
			{children}
		</div>
	)
}

/** Centered message filling a chart's plot area — "no data", "not collected", and friends. */
export function ChartCardMessage({ children }: { children: ReactNode }) {
	return (
		<div
			className="flex items-center justify-center px-3 text-center font-mono text-[11px] text-muted-foreground"
			style={{ height: CHART_HEIGHT }}
		>
			{children}
		</div>
	)
}

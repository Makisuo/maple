import { useMemo, useState, type ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"
import { PlotLegendSlotContext, type PlotLegendItem } from "@maple/ui/components/plot"
import {
	GripDotsIcon,
	TrashIcon,
	PencilIcon,
	CopyIcon,
	DotsVerticalIcon,
	ChatBubbleSparkleIcon,
	BellIcon,
	ClockIcon,
} from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@maple/ui/components/ui/dropdown-menu"
import type { WidgetMode, WidgetDataState } from "@/components/dashboard-builder/types"
import { useWidgetActions } from "@/components/dashboard-builder/widgets/widget-actions-context"
import { MoveWidgetToSectionMenu } from "@/components/dashboard-builder/sections/move-widget-to-section-menu"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import {
	useWidgetTimeRangeOverride,
	widgetTimeRangeLabel,
} from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { interpolateDisplayText } from "@maple/query-engine"

interface WidgetShellProps {
	title: string
	mode: WidgetMode
	/** Headline stat rendered at the top-right of the card header. */
	headerValue?: ReactNode
	/** Summary stat rendered below the card content. */
	footer?: ReactNode
	contentClassName?: string
	children: ReactNode
}

export function WidgetShell({
	title,
	mode,
	headerValue,
	footer,
	contentClassName,
	children,
}: WidgetShellProps) {
	// Actions come from context only. They used to be optional props forwarded
	// verbatim through every renderer, which meant a five-prop tail on all ten
	// widget components that no dashboard call site ever passed.
	const ctx = useWidgetActions()
	const remove = ctx?.remove
	const clone = ctx?.clone
	const configure = ctx?.configure
	const createAlert = ctx?.createAlert
	const moveToSection = ctx?.moveToSection
	const moveTargets = ctx?.moveTargets
	const isEditable = mode === "edit"
	// The menu is also shown in view mode when "Create alert" is available, so
	// alerts can be spun off a chart without entering dashboard edit mode.
	const showMenu = isEditable || createAlert != null
	const [menuOpen, setMenuOpen] = useState(false)
	const [legendItems, setLegendItems] = useState<readonly PlotLegendItem[]>([])
	// One piece of state, two providers. The Recharts `ChartContainer` and the
	// TanStack plot layer each publish through their own context — the plot layer
	// declares its own so that importing it does not drag `recharts` into every
	// ported chart's bundle — and a tile holds exactly one chart, so only one of
	// them ever fires.
	const legendSlot = useMemo(() => ({ setItems: setLegendItems }), [])

	// Titles can reference dashboard variables ("Latency — $service"); render
	// the resolved value. Outside a dashboard (widget lab) this is a no-op.
	const variablesContext = useDashboardVariablesOptional()
	const displayTitle = variablesContext ? interpolateDisplayText(title, variablesContext.values) : title

	// A tile pinned to its own window says so in the header. Without the label a
	// reader has no way to tell that one card on a 7-day board is showing the
	// last 30 minutes.
	const timeRangeOverride = useWidgetTimeRangeOverride()
	const timeRangeLabel = timeRangeOverride ? widgetTimeRangeLabel(timeRangeOverride) : null

	return (
		// `@container/widget` is the size anchor for every widget body. Tiles are
		// sized by the grid, not the viewport — the nav sidebar collapse swings the
		// canvas ~208px and the grid drops to 6 or 1 columns on narrow screens — so
		// internals gate on the card's own width, never on `md:`/`lg:`.
		<Card className="@container/widget h-full flex flex-col">
			<CardHeader className="py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					{isEditable && (
						// Hidden when the canvas is showing a generated (non-authored)
						// layout — see `is-layout-locked` in dashboard-canvas. Outside a
						// canvas (widget lab, previews) the group never matches, so the
						// grip renders as before.
						<div className="widget-drag-handle cursor-grab text-muted-foreground group-[.is-layout-locked]/canvas:hidden hover:text-foreground active:cursor-grabbing">
							<GripDotsIcon size={14} />
						</div>
					)}
					<CardTitle className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						{displayTitle}
					</CardTitle>
					{timeRangeLabel && (
						<span
							className="flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
							title={`This widget uses its own time range (${timeRangeLabel}) instead of the dashboard's`}
						>
							<ClockIcon size={10} />
							{timeRangeLabel}
						</span>
					)}
					{legendItems.length >= 2 &&
						(() => {
							// Keep the header to a single row: show a few items, then a
							// "+N" chip (full list on hover) so a many-series legend can
							// never wrap and crowd the title.
							const MAX_HEADER_ITEMS = 5
							const visible = legendItems.slice(0, MAX_HEADER_ITEMS)
							const overflow = legendItems.length - visible.length
							return (
								// Below ~380px the title alone fills the header row, so
								// the legend is dropped entirely rather than squeezed to
								// a row of unreadable truncated stubs.
								<div className="ml-auto hidden min-w-0 flex-1 items-center justify-end gap-x-3 overflow-hidden @min-[380px]/widget:flex">
									{visible.map((item) => (
										<span
											key={item.key}
											className="flex min-w-0 shrink items-center gap-1.5 text-[10px] text-muted-foreground"
										>
											{/* A dashed outline, not a filled square, when the series is
											    painted as a dashed stroke — an errors overlay drawn dashed
											    in the plot and solid in the header would state something
											    the chart does not. Mirrors `FixedMetricLegend`. */}
											<span
												className={cn(
													"size-2 shrink-0 rounded-[2px]",
													item.dashed && "border border-dashed",
												)}
												style={
													item.dashed
														? { borderColor: item.color }
														: { backgroundColor: item.color }
												}
											/>
											<span className="truncate">{item.label}</span>
										</span>
									))}
									{overflow > 0 && (
										<span
											className="shrink-0 text-[10px] text-muted-foreground"
											title={legendItems.map((i) => i.label).join(", ")}
										>
											+{overflow}
										</span>
									)}
								</div>
							)
						})()}
					{headerValue != null && (
						// LAST in the row, so the headline stat keeps the top-right corner.
						// It used to come BEFORE the legend, which was invisible only because
						// `legendItems` was permanently empty for every ported chart — the bug
						// that restoring the legend slot fixed. With chips actually rendering,
						// they landed to the right of the stat and took the corner.
						//
						// `ml-auto` stays on both: the legend's `flex-1` absorbs the free space
						// when there is one, and this is what pushes the stat right when there
						// is not.
						<div className="ml-auto shrink-0 font-mono font-semibold text-xs tabular-nums">
							{headerValue}
						</div>
					)}
				</div>
				{showMenu && (
					<CardAction
						className={cn(
							!isEditable &&
								"opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100",
							!isEditable && menuOpen && "opacity-100",
						)}
					>
						<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
							<DropdownMenuTrigger
								render={
									<Button variant="ghost" size="icon-xs">
										<DotsVerticalIcon size={14} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								{isEditable && configure && (
									<DropdownMenuItem onClick={configure}>
										<PencilIcon size={14} />
										Edit
									</DropdownMenuItem>
								)}
								{isEditable && clone && (
									<DropdownMenuItem onClick={clone}>
										<CopyIcon size={14} />
										Clone
									</DropdownMenuItem>
								)}
								{isEditable && moveToSection && moveTargets && (
									<MoveWidgetToSectionMenu
										sections={moveTargets}
										current={ctx?.moveCurrent ?? null}
										onMove={moveToSection}
									/>
								)}
								{createAlert && (
									<DropdownMenuItem onClick={createAlert}>
										<BellIcon size={14} />
										Create alert
									</DropdownMenuItem>
								)}
								{isEditable && remove && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onClick={remove}>
											<TrashIcon size={14} />
											Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</CardAction>
				)}
			</CardHeader>
			{/* Default containment: no chart may paint outside its card (MAP-49 —
			    funnel rows spilled over the header). Widgets that scroll
			    (list/table/markdown) override with overflow-auto, which wins the
			    tailwind-merge conflict. */}
			<CardContent className={cn("overflow-hidden", contentClassName ?? "flex-1 min-h-0 p-2")}>
				<PlotLegendSlotContext.Provider value={legendSlot}>{children}</PlotLegendSlotContext.Provider>
			</CardContent>
			{footer != null && (
				<div className="shrink-0 px-3 pb-2.5 text-[11px] text-muted-foreground">{footer}</div>
			)}
		</Card>
	)
}

export function ReadonlyWidgetShell(props: Omit<WidgetShellProps, "mode">) {
	return <WidgetShell {...props} mode="view" />
}

interface WidgetFrameProps {
	title: string
	dataState: WidgetDataState
	mode: WidgetMode
	contentClassName?: string
	loadingSkeleton: ReactNode
	/** Summary line under the content. Only rendered once data is ready. */
	footer?: ReactNode
	children: ReactNode
}

/**
 * "Nothing to draw here": the muted empty state every tile shows when its query
 * ran fine and simply returned no rows. Shared with the chart widgets, which
 * used to hand an empty result to a chart that then drew its sample data.
 */
export function WidgetEmptyState() {
	return (
		<div className="flex items-center justify-center h-full">
			<span className="text-xs text-muted-foreground">No data in selected time range</span>
		</div>
	)
}

export function WidgetFrame({
	title,
	dataState,
	mode,
	contentClassName,
	loadingSkeleton,
	footer,
	children,
}: WidgetFrameProps) {
	// `WidgetShell` resolves the menu actions against context itself; `fix` and
	// `narrowRange` drive the inline error CTAs below, so they are resolved here.
	const actions = useWidgetActions()
	const fix = actions?.fix
	const narrowRange = actions?.narrowRange

	return (
		<WidgetShell
			title={title}
			mode={mode}
			contentClassName={contentClassName}
			footer={dataState.status === "ready" ? footer : undefined}
		>
			{dataState.status === "loading" ? (
				loadingSkeleton
			) : dataState.status === "error" ? (
				dataState.message === "No query data found in selected time range" ? (
					<WidgetEmptyState />
				) : dataState.kind === "range" || dataState.kind === "config" ? (
					// A constraint, not a failure — muted like the empty state rather
					// than destructive, since nothing is broken: the window is too wide
					// for a list, or the tile simply isn't configured yet.
					<div className="flex items-center justify-center h-full flex-col gap-1.5 px-3">
						<span className="text-xs font-medium text-muted-foreground">
							{dataState.title ??
								(dataState.kind === "range" ? "Range too wide" : "Not configured")}
						</span>
						{dataState.message && (
							<span className="text-[10px] text-muted-foreground/70 max-w-full text-center line-clamp-3">
								{dataState.message}
							</span>
						)}
						{dataState.kind === "range" && narrowRange && (
							<Button
								variant="outline"
								size="xs"
								onClick={narrowRange}
								className="mt-1 h-6 gap-1 text-[10px]"
							>
								<ClockIcon size={12} />
								{actions?.narrowRangeLabel ?? "Narrow range"}
							</Button>
						)}
					</div>
				) : (
					<div className="flex items-center justify-center h-full flex-col gap-1.5 px-3">
						<span className="text-xs font-medium text-destructive">
							{dataState.title ?? "Unable to load"}
						</span>
						{dataState.message && (
							<span className="text-[10px] text-destructive/70 max-w-full text-center line-clamp-2">
								{dataState.message}
							</span>
						)}
						{fix && dataState.kind === "decode" && (
							<Button
								variant="outline"
								size="xs"
								onClick={fix}
								className="mt-1 h-6 gap-1 text-[10px]"
							>
								<ChatBubbleSparkleIcon size={12} />
								Fix with AI
							</Button>
						)}
					</div>
				)
			) : (
				children
			)}
		</WidgetShell>
	)
}

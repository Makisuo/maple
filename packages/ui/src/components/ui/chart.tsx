"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "../../lib/utils"
import { sanitizeCssIdentifier, validateCssColor } from "../../lib/sanitizers"

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const

export type ChartConfig = {
	[k in string]: {
		label?: React.ReactNode
		icon?: React.ComponentType
	} & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> })
}

type ChartContextProps = {
	config: ChartConfig
	containerRef: React.RefObject<HTMLDivElement | null>
	chartId: string
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
	const context = React.use(ChartContext)

	if (!context) {
		throw new Error("useChart must be used within a <ChartContainer />")
	}

	return context
}

export type ChartLegendItem = { key: string; label: React.ReactNode; color?: string }

/** Stable empty reference so the legend-slot publish effect doesn't churn. */
const EMPTY_LEGEND_ITEMS: ChartLegendItem[] = []

/**
 * Optional slot for hoisting a chart's legend out of the plot area and into an
 * ancestor (e.g. a card header). When a provider is present, `ChartContainer`
 * publishes its series into it and the in-plot `ChartLegendContent` renders
 * nothing.
 */
export const ChartLegendSlotContext = React.createContext<{
	setItems: (items: ChartLegendItem[]) => void
} | null>(null)

function ChartContainer({
	id,
	className,
	children,
	config,
	hoistLegend = true,
	...props
}: React.ComponentProps<"div"> & {
	config: ChartConfig
	children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
	/**
	 * When `true` (default) and a {@link ChartLegendSlotContext} ancestor is
	 * present, the chart's series are published into that slot (e.g. a widget
	 * header strip). Charts that render their own in-plot legend should pass
	 * `false` so the header doesn't duplicate it.
	 */
	hoistLegend?: boolean
}) {
	const uniqueId = React.useId()
	const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`
	const containerRef = React.useRef<HTMLDivElement>(null)

	const legendSlot = React.use(ChartLegendSlotContext)
	const legendItems = React.useMemo<ChartLegendItem[]>(
		() =>
			Object.entries(config)
				.filter(([key, item]) => item.label != null && !key.endsWith("_incomplete"))
				.map(([key, item]) => ({
					key,
					label: item.label,
					color: "color" in item ? item.color : undefined,
				})),
		[config],
	)
	const publishedItems = hoistLegend ? legendItems : EMPTY_LEGEND_ITEMS
	React.useEffect(() => {
		if (!legendSlot) return
		legendSlot.setItems(publishedItems)
		return () => legendSlot.setItems([])
	}, [legendSlot, publishedItems])

	// Stable identity so ChartContext consumers (tooltip/legend contents) don't
	// rerender just because the container did.
	const chartContextValue = React.useMemo(() => ({ config, containerRef, chartId }), [config, chartId])

	return (
		<ChartContext.Provider value={chartContextValue}>
			<div
				ref={containerRef}
				data-slot="chart"
				data-chart={chartId}
				className={cn(
					// `[&_.recharts-surface]:overflow-visible` un-clips recharts' root <svg> so an
					// `overlay` (commit deploy markers) can draw its chip row ABOVE the plot,
					// overflowing into the card's header/padding gap instead of reserving inner top
					// margin (which would squish the series). Recharts clips series via clip-path, not
					// surface overflow, so overlay-less charts are unaffected. See `commit-markers-layer.tsx`.
					//
					// Axis/grid/cursor look is defined HERE (plus `ChartXAxis`/`ChartYAxis`/`ChartGrid`
					// below), not per chart: 10px muted tick text, no axis lines, faint dashed
					// horizontal grid, dashed hairline cursor. Tick text is targeted by the class
					// recharts puts on the <text> itself (`recharts-cartesian-axis-tick-value`) —
					// recharts 3.10 dropped the `.recharts-cartesian-axis-tick` wrapper the stock
					// shadcn selector relied on, which left ticks at recharts' default #666.
					"[&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground [&_.recharts-cartesian-axis-tick-value]:text-[10px] [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-cartesian-grid_line]:[stroke-dasharray:3_3] [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:[stroke-dasharray:3_3] [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden [&_.recharts-surface]:overflow-visible",
					className,
				)}
				{...props}
			>
				<ChartStyle id={chartId} config={config} />
				<RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
			</div>
		</ChartContext.Provider>
	)
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
	const colorConfig = Object.entries(config).filter(([, config]) => config.theme || config.color)

	if (!colorConfig.length) {
		return null
	}

	// Escape the chart id and each config key so a telemetry label like
	// `</style><script>` cannot terminate the <style> block. Validate the
	// color via a strict allowlist; entries with a non-recognised color value
	// are dropped rather than emitted as raw CSS.
	const safeId = sanitizeCssIdentifier(id)

	return (
		<style
			dangerouslySetInnerHTML={{
				__html: Object.entries(THEMES)
					.map(
						([theme, prefix]) => `
${prefix} [data-chart="${safeId}"] {
${colorConfig
	.map(([key, itemConfig]) => {
		const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
		const safeColor = validateCssColor(color)
		if (!safeColor) return null
		return `  --color-${sanitizeCssIdentifier(key)}: ${safeColor};`
	})
	.filter((line): line is string => line !== null)
	.join("\n")}
}
`,
					)
					.join("\n"),
			}}
		/>
	)
}

// TODO(phase-b): delete this file. These four moved to `../plot/floating-tooltip`
// because nothing in them is Recharts-specific; they are re-exported here so the
// ~17 modules that still import from this path keep working until each is ported.
import { ChartFloatingTooltip } from "../plot/floating-tooltip"

export {
	ChartFloatingTooltip,
	ChartTooltipSuppressionProvider,
	chartTooltipCardClassName,
	useChartTooltipSuppressed,
	useSuppressChartTooltip,
} from "../plot/floating-tooltip"

const ChartTooltip = RechartsPrimitive.Tooltip

/**
 * Cartesian axis + grid with Maple's defaults baked in: no tick/axis lines,
 * comfortable tick margins, horizontal-only dashed grid. Pass any recharts
 * prop to override per chart (`width`, `tickFormatter`, `scale`, `yAxisId`, …).
 * Tick text size/colour and the grid/cursor stroke come from `ChartContainer`.
 */
function ChartXAxis(props: React.ComponentProps<typeof RechartsPrimitive.XAxis>) {
	return (
		<RechartsPrimitive.XAxis
			tickLine={false}
			axisLine={false}
			tickMargin={8}
			minTickGap={24}
			{...props}
		/>
	)
}

function ChartYAxis(props: React.ComponentProps<typeof RechartsPrimitive.YAxis>) {
	return <RechartsPrimitive.YAxis tickLine={false} axisLine={false} tickMargin={6} width={56} {...props} />
}

function ChartGrid(props: React.ComponentProps<typeof RechartsPrimitive.CartesianGrid>) {
	return <RechartsPrimitive.CartesianGrid vertical={false} strokeDasharray="3 3" {...props} />
}

function ChartTooltipContent({
	active,
	payload,
	className,
	indicator = "dot",
	hideLabel = false,
	hideIndicator = false,
	label,
	labelFormatter,
	labelClassName,
	formatter,
	color,
	nameKey,
	labelKey,
	coordinate,
	resolveHighlightKey,
}: Partial<
	Pick<
		RechartsPrimitive.TooltipContentProps,
		"active" | "payload" | "label" | "labelFormatter" | "labelClassName" | "formatter" | "coordinate"
	>
> &
	React.ComponentProps<"div"> & {
		hideLabel?: boolean
		hideIndicator?: boolean
		indicator?: "line" | "dot" | "dashed"
		nameKey?: string
		labelKey?: string
		/**
		 * Optional resolver that returns the `dataKey` of the row to emphasise
		 * (rendered bold) given the cursor position and the active payload —
		 * used to bold the series whose line is nearest the pointer. Returning
		 * `undefined` emphasises nothing.
		 */
		resolveHighlightKey?: (
			coordinate: { x?: number; y?: number } | undefined,
			payload: RechartsPrimitive.TooltipPayload,
		) => string | undefined
	}) {
	const { config, containerRef, chartId } = useChart()

	const tooltipLabel = React.useMemo(() => {
		if (hideLabel || !payload?.length) {
			return null
		}

		const [item] = payload
		const key = `${labelKey || item?.dataKey || item?.name || "value"}`
		const itemConfig = getPayloadConfigFromPayload(config, item, key)
		const value =
			!labelKey && typeof label === "string"
				? config[label as keyof typeof config]?.label || label
				: itemConfig?.label

		if (labelFormatter) {
			return <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>
		}

		if (!value) {
			return null
		}

		return <div className={cn("font-medium", labelClassName)}>{value}</div>
	}, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

	if (!active || !payload?.length) {
		return null
	}

	const highlightKey = resolveHighlightKey?.(coordinate, payload)

	const nestLabel = payload.length === 1 && indicator !== "dot"

	return (
		<ChartFloatingTooltip
			containerRef={containerRef}
			x={coordinate?.x}
			y={coordinate?.y}
			open
			chartId={chartId}
			className={cn("grid min-w-[8rem] items-start gap-1.5", className)}
		>
			{!nestLabel && tooltipLabel ? (
				<div className="border-border/50 text-muted-foreground border-b pb-1 tracking-tight">
					{tooltipLabel}
				</div>
			) : null}
			<div className="grid gap-1.5">
				{payload
					.filter((item) => item.type !== "none" || !!formatter)
					.filter((item) => {
						if (typeof item.value !== "number" || item.value !== 0) return true
						const hasNegative = payload.some((p) => typeof p.value === "number" && p.value < 0)
						return hasNegative
					})
					.sort((a, b) => {
						const aVal = typeof a.value === "number" ? a.value : 0
						const bVal = typeof b.value === "number" ? b.value : 0
						return bVal - aVal
					})
					.map((item, index) => {
						const key = `${nameKey || item.name || item.dataKey || "value"}`
						const itemConfig = getPayloadConfigFromPayload(config, item, key)
						const indicatorColor = color || item.payload.fill || item.color

						if (formatter && item?.value !== undefined && item.name) {
							const formatted = formatter(item.value, item.name, item, index, item.payload)
							if (formatted == null) return null
							return (
								<div
									key={String(item.dataKey ?? index)}
									className={cn(
										"[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5",
										indicator === "dot" && "items-center",
										highlightKey != null &&
											item.dataKey === highlightKey &&
											"[&_*]:font-semibold",
									)}
								>
									{formatted}
								</div>
							)
						}

						return (
							<div
								key={String(item.dataKey ?? index)}
								className={cn(
									"[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5",
									indicator === "dot" && "items-center",
									highlightKey != null &&
										item.dataKey === highlightKey &&
										"[&_*]:font-semibold",
								)}
							>
								{itemConfig?.icon ? (
									<itemConfig.icon />
								) : (
									!hideIndicator && (
										<div
											className={cn(
												"shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
												{
													"h-2.5 w-2.5": indicator === "dot",
													"w-1": indicator === "line",
													"w-0 border-[1.5px] border-dashed bg-transparent":
														indicator === "dashed",
													"my-0.5": nestLabel && indicator === "dashed",
												},
											)}
											style={
												{
													"--color-bg": indicatorColor,
													"--color-border": indicatorColor,
												} as React.CSSProperties
											}
										/>
									)
								)}
								<div
									className={cn(
										"flex flex-1 justify-between leading-none",
										nestLabel ? "items-end" : "items-center",
									)}
								>
									<div className="grid gap-1.5">
										{nestLabel ? tooltipLabel : null}
										<span className="text-muted-foreground">
											{itemConfig?.label || item.name}
										</span>
									</div>
									{item.value && (
										<span className="text-foreground font-mono font-semibold tabular-nums">
											{item.value.toLocaleString()}
										</span>
									)}
								</div>
							</div>
						)
					})}
			</div>
		</ChartFloatingTooltip>
	)
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
	className,
	hideIcon = false,
	payload,
	verticalAlign = "bottom",
	nameKey,
}: React.ComponentProps<"div"> &
	Pick<RechartsPrimitive.DefaultLegendContentProps, "payload" | "verticalAlign"> & {
		hideIcon?: boolean
		nameKey?: string
	}) {
	const { config } = useChart()
	const legendSlot = React.use(ChartLegendSlotContext)

	// When an ancestor hosts the legend (e.g. a card header), don't draw it in
	// the plot area — `ChartContainer` publishes the series to that slot.
	if (legendSlot) {
		return null
	}

	if (!payload?.length) {
		return null
	}

	return (
		<div
			className={cn(
				"flex items-center justify-center gap-4 overflow-x-auto",
				verticalAlign === "top" ? "pb-3" : "pt-3",
				className,
			)}
		>
			{payload
				.filter((item) => item.type !== "none")
				.map((item) => {
					const key = `${nameKey || item.dataKey || "value"}`
					const itemConfig = getPayloadConfigFromPayload(config, item, key)

					return (
						<div
							key={item.value}
							className={cn(
								"[&>svg]:text-muted-foreground flex shrink-0 items-center gap-1.5 whitespace-nowrap [&>svg]:h-3 [&>svg]:w-3",
							)}
						>
							{itemConfig?.icon && !hideIcon ? (
								<itemConfig.icon />
							) : (
								<div
									className="h-2 w-2 shrink-0 rounded-[2px]"
									style={{
										backgroundColor: item.color,
									}}
								/>
							)}
							{itemConfig?.label}
						</div>
					)
				})}
		</div>
	)
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
	if (typeof payload !== "object" || payload === null) {
		return undefined
	}

	const payloadPayload =
		"payload" in payload && typeof payload.payload === "object" && payload.payload !== null
			? payload.payload
			: undefined

	let configLabelKey: string = key

	if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
		configLabelKey = payload[key as keyof typeof payload] as string
	} else if (
		payloadPayload &&
		key in payloadPayload &&
		typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
	) {
		configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string
	}

	return configLabelKey in config ? config[configLabelKey] : config[key as keyof typeof config]
}

export {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	ChartLegend,
	ChartLegendContent,
	ChartStyle,
	ChartXAxis,
	ChartYAxis,
	ChartGrid,
}

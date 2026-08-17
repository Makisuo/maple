import { createContext, memo, type ReactNode, use, useMemo } from "react"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import { useWidgetDataSource, type WidgetDataSourceLike } from "@/hooks/use-widget-data"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface StatWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
}

export function formatValue(value: unknown, unit?: string, prefix?: string, suffix?: string): string {
	if (value === null || value === undefined) return "-"
	if (typeof value === "object") return "—"

	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return String(value)

	const formatted = formatValueByUnit(num, unit)
	return `${prefix ?? ""}${formatted}${suffix ?? ""}`
}

export function getThresholdColor(
	value: unknown,
	thresholds?: ReadonlyArray<{ value: number; color: string }>,
): string | undefined {
	if (!thresholds || thresholds.length === 0) return undefined
	if (value === null || value === undefined || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined

	const sorted = thresholds.toSorted((a, b) => b.value - a.value)
	for (const t of sorted) {
		if (num >= t.value) return t.color
	}
	return undefined
}

/**
 * Supplies the sparkline's series without a warehouse round-trip.
 *
 * Fixture surfaces only — the widget lab and the picker's thumbnails. This is
 * the one renderer that fetches something itself, so without a seam those
 * surfaces have to hand-rebuild the whole sparkline branch, and the real
 * component ends up being the one thing they never verify.
 *
 * The widget still never invents data. With no scope mounted — every path in the
 * app — it fetches, and a scope that resolves to an empty or error state renders
 * an empty sparkline exactly as a real empty result would. The substitution
 * happens at the call site, which is where fixtures belong: a widget that
 * substitutes fixtures for missing data on its own can't tell a real empty
 * result from a misconfigured query, which is how a broken histogram ended up
 * rendering a plausible-looking distribution on a live dashboard.
 */
export type SparklineSeriesResolver = (dataSource: WidgetDataSourceLike) => WidgetDataState

const SparklineSeriesContext = createContext<SparklineSeriesResolver | null>(null)

export function SparklineSeriesScope({
	resolve,
	children,
}: {
	resolve: SparklineSeriesResolver
	children: ReactNode
}) {
	// Stable identity: `StatSparklineLoader` branches on this value to choose
	// which component mounts, so an unstable one remounts the sparkline — and
	// re-runs its fetch — on every parent render.
	const value = useMemo(() => resolve, [resolve])
	return <SparklineSeriesContext value={value}>{children}</SparklineSeriesContext>
}

const seriesRows = (state: WidgetDataState): unknown[] =>
	state.status === "ready" && Array.isArray(state.data) ? state.data : []

function LiveStatSparkline({ dataSource, color }: { dataSource: WidgetDataSourceLike; color: string }) {
	const { dataState } = useWidgetDataSource(dataSource)
	return <StatSparkline data={seriesRows(dataState)} color={color} className="h-10 w-full shrink-0" />
}

function FixtureStatSparkline({
	dataSource,
	color,
	resolve,
}: {
	dataSource: WidgetDataSourceLike
	color: string
	resolve: SparklineSeriesResolver
}) {
	return (
		<StatSparkline
			data={seriesRows(resolve(dataSource))}
			color={color}
			className="h-10 w-full shrink-0"
		/>
	)
}

/**
 * Renders the trend under the headline. Kept as a separate component so the
 * `useWidgetDataSource` hook (which reads the dashboard time-range context) only
 * runs when a sparkline is configured — a plain stat widget then has no
 * dependency on a dashboard provider.
 */
function StatSparklineLoader({ dataSource, color }: { dataSource: WidgetDataSourceLike; color: string }) {
	const resolve = use(SparklineSeriesContext)
	// Branch on which component mounts, never on whether a hook runs:
	// `useWidgetDataSource` is still called unconditionally inside `LiveStatSparkline`.
	return resolve ? (
		<FixtureStatSparkline dataSource={dataSource} color={color} resolve={resolve} />
	) : (
		<LiveStatSparkline dataSource={dataSource} color={color} />
	)
}

export const StatWidget = memo(function StatWidget({ dataState, display, mode }: StatWidgetProps) {
	const displayName = display.title || "Untitled"
	const value = dataState.status === "ready" ? dataState.data : undefined
	const formattedValue = formatValue(value, display.unit, display.prefix, display.suffix)
	const thresholdColor = getThresholdColor(value, display.thresholds)

	const sparklineSource = display.sparkline?.enabled === true ? display.sparkline.dataSource : undefined

	// The headline scales with the tile, not the viewport: a 3-column stat is
	// ~90px wide once the grid drops to 6 columns, where `text-2xl` truncates a
	// formatted value that reads fine one breakpoint up.
	const valueText = (
		<span
			className="text-base font-bold tabular-nums @min-[150px]/widget:text-2xl @min-[280px]/widget:text-3xl"
			style={thresholdColor ? { color: thresholdColor } : undefined}
		>
			{formattedValue}
		</span>
	)

	return (
		<WidgetFrame
			title={displayName}
			dataState={dataState}
			mode={mode}
			contentClassName={
				sparklineSource
					? "flex-1 min-h-0 flex flex-col"
					: "flex-1 min-h-0 flex items-center justify-center p-2 @min-[200px]/widget:p-4"
			}
			loadingSkeleton={
				sparklineSource ? (
					<div className="flex h-full w-full flex-col">
						<div className="flex flex-1 items-center justify-center">
							<ChartSkeleton variant="stat" />
						</div>
						<ChartSkeleton variant="line" className="h-10 shrink-0" />
					</div>
				) : (
					<ChartSkeleton variant="stat" />
				)
			}
		>
			{sparklineSource ? (
				<>
					<div className="flex flex-1 items-center justify-center px-2 pt-2 @min-[200px]/widget:px-4 @min-[200px]/widget:pt-4">
						{valueText}
					</div>
					{/* Under ~140px the trend is a few pixels of noise under the
					    number — drop it and give the value the whole tile. */}
					<div className="hidden shrink-0 @min-[140px]/widget:block">
						<StatSparklineLoader
							dataSource={sparklineSource}
							color={thresholdColor ?? "var(--chart-1)"}
						/>
					</div>
				</>
			) : (
				valueText
			)}
		</WidgetFrame>
	)
})

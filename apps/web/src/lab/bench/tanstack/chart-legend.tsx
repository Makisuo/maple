import { cn } from "@maple/ui/lib/utils"
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react"

/**
 * The series key rendered beside a TanStack chart.
 *
 * `@tanstack/charts` ships three legends of its own (`colorLegend`,
 * `colorGradientLegend`, `interactiveColorLegend`), but all three hang off
 * `ChartColorOptions.legend`, which only exists once a chart declares a `color:`
 * scale — and the spikes that replace a Recharts chart set literal per-mark
 * `stroke`/`fill`, because Recharts' idiom is one mark per series and there is no
 * `z` channel to scale a colour over. See `stacked-bar-spike.tsx`'s scene arm for
 * the one chart shaped the other way, and FINDINGS.md for what that costs.
 *
 * So this is DOM, which is also what buys visual parity with
 * `packages/ui/src/components/charts/_shared/query-builder-legend.tsx` — the
 * legend every production chart on the other side of the lab renders.
 */
export interface LegendSeriesSpec {
	/** Stable id, matching the id the spike gives the series' mark. */
	key: string
	label: string
	/**
	 * A RESOLVED colour, from the same `usePlotColors` call that feeds the chart
	 * definition. Passing a `var(--…)` token here would still paint (this is DOM),
	 * but the canvas renderer cannot resolve one, so the swatch and the stroke
	 * would drift apart the moment the theme flips.
	 */
	color: string
	/** Renders the swatch as a dashed outline, as `TooltipBody` does. */
	dashed?: boolean
}

interface ChartLegendState {
	series: readonly LegendSeriesSpec[]
	/** The emphasised series, or `null` when every series is at full strength. */
	highlighted: string | null
}

interface ChartLegendActions {
	highlight: (key: string) => void
}

interface ChartLegendMeta {
	/** Names the group for assistive tech — "Latency percentiles", not "Legend". */
	label: string
}

interface ChartLegendContextValue {
	state: ChartLegendState
	actions: ChartLegendActions
	meta: ChartLegendMeta
}

const ChartLegendContext = createContext<ChartLegendContextValue | null>(null)

function useChartLegend(): ChartLegendContextValue {
	const value = use(ChartLegendContext)
	if (!value) throw new Error("ChartLegend parts must render inside <ChartLegend.Provider>")
	return value
}

/**
 * Which series is emphasised, owned by the CHART rather than by the legend.
 *
 * Clicking a series brings it forward and pushes the others back; clicking it
 * again returns every series to full strength. Nothing is ever removed — the
 * shape of the data on screen does not change, so the axes never move under the
 * reader and a series can be picked out of a crowded chart without losing its
 * context. (`QueryBuilderLegend` on the production side toggles VISIBILITY
 * instead, which rescales the axis on every click.)
 *
 * The legend cannot hold this state: emphasis is expressed in the marks — a
 * stroke opacity, or a muted fill — which only the spike can set. The legend
 * renders the same state and calls back into it.
 */
export function useChartLegendHighlight(): {
	highlighted: string | null
	highlight: (key: string) => void
	isMuted: (key: string) => boolean
} {
	const [highlighted, setHighlighted] = useState<string | null>(null)

	const highlight = useCallback((key: string) => {
		setHighlighted((previous) => (previous === key ? null : key))
	}, [])

	const isMuted = useCallback((key: string) => highlighted !== null && highlighted !== key, [highlighted])

	return { highlighted, highlight, isMuted }
}

function ChartLegendProvider({
	series,
	highlighted,
	onHighlight,
	label,
	children,
}: {
	series: readonly LegendSeriesSpec[]
	highlighted: string | null
	onHighlight: (key: string) => void
	label: string
	children: ReactNode
}) {
	// The provider is the only place that knows how the highlight is managed, so a
	// chart backed by URL state or a store composes the same parts unchanged.
	const value = useMemo<ChartLegendContextValue>(
		() => ({ state: { series, highlighted }, actions: { highlight: onHighlight }, meta: { label } }),
		[series, highlighted, onHighlight, label],
	)

	return <ChartLegendContext value={value}>{children}</ChartLegendContext>
}

/**
 * The horizontal strip, matching `QueryBuilderLegend`'s `layout="bottom"`.
 *
 * A sibling component rather than a `layout` prop: two containers with different
 * flex axes is the whole difference, and an enum prop here is the first step
 * toward the `showValues`/`interactive`/`horizontal` pile the composition rules
 * exist to prevent.
 */
function ChartLegendRow({ children, className }: { children: ReactNode; className?: string }) {
	const { meta } = useChartLegend()
	return (
		<div
			aria-label={meta.label}
			className={cn("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs select-none", className)}
		>
			{children}
		</div>
	)
}

/** The vertical list, matching `QueryBuilderLegend`'s `layout="right"`. */
function ChartLegendColumn({ children, className }: { children: ReactNode; className?: string }) {
	const { meta } = useChartLegend()
	return (
		<div
			aria-label={meta.label}
			className={cn("flex flex-col gap-0.5 pl-3 text-xs select-none", className)}
		>
			{children}
		</div>
	)
}

/**
 * Maps the provider's series.
 *
 * `children` is a render prop here, and deliberately: it is the one case the
 * composition rules bless, where the parent has to hand each child its own datum.
 * Omitting it renders the default `Item`.
 */
function ChartLegendItems({ children }: { children?: (series: LegendSeriesSpec) => ReactNode }) {
	const { state } = useChartLegend()
	return (
		<>
			{state.series.map((entry) =>
				children ? (
					<span key={entry.key}>{children(entry)}</span>
				) : (
					<ChartLegendItem key={entry.key} seriesKey={entry.key} />
				),
			)}
		</>
	)
}

/** One clickable series row. Reads everything but its identity from context. */
function ChartLegendItem({ seriesKey }: { seriesKey: string }) {
	const { state, actions } = useChartLegend()
	const entry = state.series.find((candidate) => candidate.key === seriesKey)
	if (!entry) return null

	const isHighlighted = state.highlighted === entry.key
	const isMuted = state.highlighted !== null && !isHighlighted

	return (
		<button
			type="button"
			// `aria-pressed`, not a bare button: the control is a toggle, and the
			// pressed state is the only thing that tells a screen reader which series
			// is emphasised. `opacity-40` says nothing out loud.
			aria-pressed={isHighlighted}
			onClick={() => actions.highlight(entry.key)}
			className={cn(
				"flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50",
				isMuted && "opacity-40",
				// Emphasis is carried by the OTHERS fading, as it is in the chart —
				// brightening the picked row as well would double the contrast step and
				// make a two-series legend look broken.
				isHighlighted && "bg-muted/50",
			)}
		>
			<ChartLegendSwatch color={entry.color} dashed={entry.dashed} />
			<span className="truncate">{entry.label}</span>
		</button>
	)
}

/**
 * `size-2`, matching `QueryBuilderLegend` — note this is NOT `TooltipBody`'s
 * `size-2.5`. The two are different sizes in production too; a legend swatch sits
 * in a dense row and a tooltip swatch does not.
 */
function ChartLegendSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
	return (
		<span
			className={cn("size-2 shrink-0 rounded-[2px]", dashed && "border border-dashed")}
			style={dashed ? { borderColor: color } : { backgroundColor: color }}
		/>
	)
}

function ChartLegendLabel({ children }: { children: ReactNode }) {
	return <span className="truncate">{children}</span>
}

export const ChartLegend = {
	Provider: ChartLegendProvider,
	Row: ChartLegendRow,
	Column: ChartLegendColumn,
	Items: ChartLegendItems,
	Item: ChartLegendItem,
	Swatch: ChartLegendSwatch,
	Label: ChartLegendLabel,
}

/**
 * The assembled bottom-strip legend every spike passes to
 * `TanstackChartFrame.legend`.
 *
 * An explicit variant, not a configured one: a chart that wants the vertical form
 * composes `Provider` → `Column` → `Items` itself rather than reaching for a
 * `layout` prop here.
 */
export function ChartSeriesLegend({
	series,
	highlighted,
	onHighlight,
	label,
}: {
	series: readonly LegendSeriesSpec[]
	highlighted: string | null
	onHighlight: (key: string) => void
	label: string
}) {
	if (series.length === 0) return null
	return (
		<ChartLegend.Provider
			series={series}
			highlighted={highlighted}
			onHighlight={onHighlight}
			label={label}
		>
			<ChartLegend.Row>
				<ChartLegend.Items />
			</ChartLegend.Row>
		</ChartLegend.Provider>
	)
}

/** How far a non-highlighted series fades, shared by every spike. */
export const MUTED_OPACITY = 0.22

/** …and how far toward the background a muted COLOUR mixes — see `muteColor`. */
export const MUTED_COLOR_AMOUNT = 0.78

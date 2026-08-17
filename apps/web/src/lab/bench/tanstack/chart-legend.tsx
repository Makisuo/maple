import { cn } from "@maple/ui/lib/utils"
import { createContext, Fragment, use, useCallback, useMemo, useState, type ReactNode } from "react"

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
	/**
	 * A trailing figure — a total, a share, a latency. ALREADY FORMATTED: the
	 * legend has no idea what unit a series carries, and `formatValueByUnit` lives
	 * with the chart that knows.
	 */
	value?: string
	/** A second trailing figure, right of `value` — typically a percentage. */
	secondary?: string
}

interface ChartLegendState {
	series: readonly LegendSeriesSpec[]
	/** The PINNED series — a click — or `null` when nothing is pinned. */
	highlighted: string | null
	/**
	 * The series under the pointer RIGHT NOW, from either side: hovering the chart
	 * or hovering a legend row. Transient, and it outranks `highlighted` while set.
	 *
	 * Two states rather than one because they answer different questions — "what am
	 * I pointing at" and "what did I pick" — and production keeps them separate
	 * too. A chart that only wants the pinned behaviour omits `active` entirely.
	 */
	active: string | null
}

interface ChartLegendActions {
	highlight: (key: string) => void
	setActive: (key: string | null) => void
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
} {
	const [highlighted, setHighlighted] = useState<string | null>(null)

	const highlight = useCallback((key: string) => {
		setHighlighted((previous) => (previous === key ? null : key))
	}, [])

	return { highlighted, highlight }
}

function ChartLegendProvider({
	series,
	highlighted,
	onHighlight,
	active = null,
	onActiveChange,
	label,
	children,
}: {
	series: readonly LegendSeriesSpec[]
	highlighted: string | null
	onHighlight: (key: string) => void
	/**
	 * The hovered series, OWNED BY THE CHART so both sides share one value:
	 * pointing at a slice lights its legend row, and pointing at a legend row
	 * lights the slice. Production runs the same single `hover` index through both
	 * (`query-builder-pie-chart.tsx` sets it from the arc's and the row's
	 * `onPointerEnter` alike). Omit the pair to opt out.
	 */
	active?: string | null
	onActiveChange?: (key: string | null) => void
	label: string
	children: ReactNode
}) {
	const setActive = useCallback((key: string | null) => onActiveChange?.(key), [onActiveChange])

	// The provider is the only place that knows how either state is managed, so a
	// chart backed by URL state or a store composes the same parts unchanged.
	const value = useMemo<ChartLegendContextValue>(
		() => ({
			state: { series, highlighted, active },
			actions: { highlight: onHighlight, setActive },
			meta: { label },
		}),
		[series, highlighted, active, onHighlight, setActive, label],
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
	const { meta, actions } = useChartLegend()
	return (
		<div
			aria-label={meta.label}
			// Cleared on the CONTAINER, not per item: leaving one row for the next
			// fires `pointerleave` before the neighbour's `pointerenter`, so clearing
			// per item would blank the hover for a frame on every crossing.
			onPointerLeave={() => actions.setActive(null)}
			className={cn("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs select-none", className)}
		>
			{children}
		</div>
	)
}

/** The vertical list, matching `QueryBuilderLegend`'s `layout="right"`. */
function ChartLegendColumn({ children, className }: { children: ReactNode; className?: string }) {
	const { meta, actions } = useChartLegend()
	return (
		<div
			aria-label={meta.label}
			onPointerLeave={() => actions.setActive(null)}
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
					<Fragment key={entry.key}>{children(entry)}</Fragment>
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
	// Hover outranks the pin while it lasts, matching production: whatever the
	// pointer is on is what the eye is following, pinned or not.
	const hovering = state.active !== null
	const isActive = state.active === entry.key
	const isMuted = hovering ? !isActive : state.highlighted !== null && !isHighlighted

	return (
		<button
			type="button"
			// `aria-pressed`, not a bare button: the control is a toggle, and the
			// pressed state is the only thing that tells a screen reader which series
			// is pinned. `opacity-40` says nothing out loud.
			aria-pressed={isHighlighted}
			onClick={() => actions.highlight(entry.key)}
			// `onFocus` alongside `onPointerEnter`, as production does: tabbing the
			// legend should light the same slice a mouse would.
			onPointerEnter={() => actions.setActive(entry.key)}
			onFocus={() => actions.setActive(entry.key)}
			className={cn(
				"flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50",
				isMuted && "opacity-40",
				// Emphasis is carried by the OTHERS fading, as it is in the chart —
				// brightening the picked row as well would double the contrast step and
				// make a two-series legend look broken.
				(isActive || (!hovering && isHighlighted)) && "bg-muted/50",
			)}
		>
			<ChartLegendSwatch color={entry.color} dashed={entry.dashed} />
			<span className="truncate">{entry.label}</span>
			{entry.value === undefined ? null : (
				<ChartLegendValue value={entry.value} secondary={entry.secondary} />
			)}
		</button>
	)
}

/**
 * The trailing figures on a stats row.
 *
 * `ml-auto` rather than a grid: the rows live in a flex column and the labels
 * vary in length, so pushing the numbers to the right edge is what keeps the
 * `tabular-nums` columns aligned with each other. Matches `QueryBuilderLegend`'s
 * stats cells — `font-mono tabular-nums`, muted secondary.
 */
function ChartLegendValue({ value, secondary }: { value: string; secondary?: string }) {
	return (
		<span className="ml-auto flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
			<span className="text-foreground">{value}</span>
			{secondary === undefined ? null : (
				<span className="w-11 text-right text-muted-foreground">{secondary}</span>
			)}
		</span>
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
	Value: ChartLegendValue,
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

/**
 * The vertical stats key that sits BESIDE a chart rather than under it — what
 * `QueryBuilderPieChart` renders as `legend="right"`.
 *
 * A separate variant from `ChartSeriesLegend`, not a `layout` prop on it: the two
 * differ in which container part they compose (`Column` vs `Row`) and in whether
 * the series carry figures at all. Same provider, same items, same click
 * behaviour.
 */
export function ChartStatsLegend({
	series,
	highlighted,
	onHighlight,
	active,
	onActiveChange,
	label,
}: {
	series: readonly LegendSeriesSpec[]
	highlighted: string | null
	onHighlight: (key: string) => void
	active?: string | null
	onActiveChange?: (key: string | null) => void
	label: string
}) {
	if (series.length === 0) return null
	return (
		<ChartLegend.Provider
			series={series}
			highlighted={highlighted}
			onHighlight={onHighlight}
			active={active}
			onActiveChange={onActiveChange}
			label={label}
		>
			<ChartLegend.Column className="pl-0">
				<ChartLegend.Items />
			</ChartLegend.Column>
		</ChartLegend.Provider>
	)
}

/** How far a non-highlighted series fades, shared by every spike. */
export const MUTED_OPACITY = 0.22

/** …and how far toward the background a muted COLOUR mixes — see `muteColor`. */
export const MUTED_COLOR_AMOUNT = 0.78

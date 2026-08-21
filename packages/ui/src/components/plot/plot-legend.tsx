import { cn } from "../../lib/utils"
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
export interface PlotLegendSeries {
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

interface PlotLegendState {
	series: readonly PlotLegendSeries[]
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
	/**
	 * The series a click has REMOVED from the chart.
	 *
	 * Distinct from `highlighted` because the two mean opposite things to the
	 * plot: highlighting fades the others and leaves every scale alone, while
	 * hiding drops a series from the rows BEFORE the definition is built, so
	 * stacks and the y domain recompute. Hiding is the production behaviour;
	 * highlighting suits charts where removing a slice renormalises the picture
	 * (pie, treemap). A chart picks one by supplying `onToggle` or not.
	 */
	hidden: ReadonlySet<string>
}

interface PlotLegendActions {
	highlight: (key: string) => void
	setActive: (key: string | null) => void
	/** `null` when the chart opted out of hiding — see `PlotLegendState.hidden`. */
	toggle: ((key: string) => void) | null
}

interface PlotLegendMeta {
	/** Names the group for assistive tech — "Latency percentiles", not "Legend". */
	label: string
}

interface PlotLegendContextValue {
	state: PlotLegendState
	actions: PlotLegendActions
	meta: PlotLegendMeta
}

/** Stable identity, so a hide-only provider's memo does not churn. */
const noopHighlight = () => {}

/** Stable identity: a fresh `new Set()` per render would break the memo below. */
const EMPTY_HIDDEN: ReadonlySet<string> = new Set()

const PlotLegendContext = createContext<PlotLegendContextValue | null>(null)

/**
 * The nearest `PlotLegend.Provider`'s state, actions and meta.
 *
 * Exported so a legend that keeps its OWN markup can still take its series,
 * hidden set and toggle from the one context — `QueryBuilderLegend` does, which
 * is what stopped the two legends from being two independent state pipelines
 * feeding two independent renderers.
 */
export function usePlotLegend(): PlotLegendContextValue {
	const value = use(PlotLegendContext)
	if (!value) throw new Error("PlotLegend parts must render inside <PlotLegend.Provider>")
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
export function usePlotLegendHighlight(): {
	highlighted: string | null
	highlight: (key: string) => void
} {
	const [highlighted, setHighlighted] = useState<string | null>(null)

	const highlight = useCallback((key: string) => {
		setHighlighted((previous) => (previous === key ? null : key))
	}, [])

	return { highlighted, highlight }
}

function PlotLegendProvider({
	series,
	highlighted = null,
	onHighlight,
	hidden,
	onToggle,
	active = null,
	onActiveChange,
	label,
	children,
}: {
	series: readonly PlotLegendSeries[]
	/**
	 * Supply BOTH to make a click PIN a series and mute the others. Omit them for
	 * a legend that only hides — a chart picks one mode or the other, and
	 * `QueryBuilderLegend` is the one that hides.
	 */
	highlighted?: string | null
	onHighlight?: (key: string) => void
	/**
	 * Supply BOTH to make a click HIDE rather than pin. The set is owned by the
	 * chart, because the chart is what has to filter its rows with it before
	 * building the definition — see `useSeriesVisibility`.
	 */
	hidden?: ReadonlySet<string>
	onToggle?: (key: string) => void
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
	const value = useMemo<PlotLegendContextValue>(
		() => ({
			state: { series, highlighted, active, hidden: hidden ?? EMPTY_HIDDEN },
			actions: { highlight: onHighlight ?? noopHighlight, setActive, toggle: onToggle ?? null },
			meta: { label },
		}),
		[series, highlighted, active, hidden, onHighlight, setActive, onToggle, label],
	)

	return <PlotLegendContext value={value}>{children}</PlotLegendContext>
}

/**
 * The horizontal strip, matching `QueryBuilderLegend`'s `layout="bottom"`.
 *
 * A sibling component rather than a `layout` prop: two containers with different
 * flex axes is the whole difference, and an enum prop here is the first step
 * toward the `showValues`/`interactive`/`horizontal` pile the composition rules
 * exist to prevent.
 */
function PlotLegendRow({ children, className }: { children: ReactNode; className?: string }) {
	const { meta, actions } = usePlotLegend()
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
function PlotLegendColumn({ children, className }: { children: ReactNode; className?: string }) {
	const { meta, actions } = usePlotLegend()
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
function PlotLegendItems({ children }: { children?: (series: PlotLegendSeries) => ReactNode }) {
	const { state } = usePlotLegend()
	return (
		<>
			{state.series.map((entry) =>
				children ? (
					<Fragment key={entry.key}>{children(entry)}</Fragment>
				) : (
					<PlotLegendItem key={entry.key} seriesKey={entry.key} />
				),
			)}
		</>
	)
}

/** One clickable series row. Reads everything but its identity from context. */
function PlotLegendItem({ seriesKey }: { seriesKey: string }) {
	const { state, actions } = usePlotLegend()
	const entry = state.series.find((candidate) => candidate.key === seriesKey)
	if (!entry) return null

	const isHighlighted = state.highlighted === entry.key
	// Hover outranks the pin while it lasts, matching production: whatever the
	// pointer is on is what the eye is following, pinned or not.
	const hovering = state.active !== null
	const isActive = state.active === entry.key
	const hides = actions.toggle !== null
	const isHidden = state.hidden.has(entry.key)
	// A hidden row is dimmed unconditionally — it is not "less emphasised", it is
	// not on the chart at all — so highlight muting only applies to visible rows.
	const isMuted = isHidden || (hovering ? !isActive : state.highlighted !== null && !isHighlighted)

	return (
		<button
			type="button"
			// `aria-pressed`, not a bare button: the control is a toggle, and the
			// pressed state is the only thing that tells a screen reader what the
			// click did. `opacity-40` says nothing out loud.
			//
			// Which state it reports follows which mode the chart chose: pressed
			// means "shown" for a hiding legend and "pinned" for a highlighting one.
			aria-pressed={hides ? !isHidden : isHighlighted}
			onClick={() => (actions.toggle ? actions.toggle(entry.key) : actions.highlight(entry.key))}
			// `onFocus` alongside `onPointerEnter`, as production does: tabbing the
			// legend should light the same series a mouse would.
			onPointerEnter={() => actions.setActive(entry.key)}
			onFocus={() => actions.setActive(entry.key)}
			className={cn(
				"flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50",
				isMuted && "opacity-40",
				// Struck through as well as dimmed: opacity alone reads as "muted by
				// someone else's highlight", and the two states have to be told apart
				// at a glance when both are on screen.
				isHidden && "line-through",
				// Emphasis is carried by the OTHERS fading, as it is in the chart —
				// brightening the picked row as well would double the contrast step and
				// make a two-series legend look broken.
				!isHidden && (isActive || (!hovering && isHighlighted)) && "bg-muted/50",
			)}
		>
			<PlotLegendSwatch color={entry.color} dashed={entry.dashed} />
			<span className="truncate">{entry.label}</span>
			{entry.value === undefined ? null : (
				<PlotLegendValue value={entry.value} secondary={entry.secondary} />
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
function PlotLegendValue({ value, secondary }: { value: string; secondary?: string }) {
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
function PlotLegendSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
	return (
		<span
			className={cn("size-2 shrink-0 rounded-[2px]", dashed && "border border-dashed")}
			style={dashed ? { borderColor: color } : { backgroundColor: color }}
		/>
	)
}

function PlotLegendLabel({ children }: { children: ReactNode }) {
	return <span className="truncate">{children}</span>
}

export const PlotLegend = {
	Provider: PlotLegendProvider,
	Row: PlotLegendRow,
	Column: PlotLegendColumn,
	Items: PlotLegendItems,
	Item: PlotLegendItem,
	Swatch: PlotLegendSwatch,
	Label: PlotLegendLabel,
	Value: PlotLegendValue,
}

/**
 * The assembled bottom-strip legend every spike passes to
 * `PlotFrame.legend`.
 *
 * An explicit variant, not a configured one: a chart that wants the vertical form
 * composes `Provider` → `Column` → `Items` itself rather than reaching for a
 * `layout` prop here.
 */
export function PlotSeriesLegend({
	series,
	highlighted,
	onHighlight,
	hidden,
	onToggle,
	active,
	onActiveChange,
	label,
}: {
	series: readonly PlotLegendSeries[]
	highlighted: string | null
	onHighlight: (key: string) => void
	hidden?: ReadonlySet<string>
	onToggle?: (key: string) => void
	active?: string | null
	onActiveChange?: (key: string | null) => void
	label: string
}) {
	if (series.length === 0) return null
	return (
		<PlotLegend.Provider
			series={series}
			highlighted={highlighted}
			onHighlight={onHighlight}
			hidden={hidden}
			onToggle={onToggle}
			active={active}
			onActiveChange={onActiveChange}
			label={label}
		>
			<PlotLegend.Row>
				<PlotLegend.Items />
			</PlotLegend.Row>
		</PlotLegend.Provider>
	)
}

/**
 * The vertical stats key that sits BESIDE a chart rather than under it — what
 * `QueryBuilderPieChart` renders as `legend="right"`.
 *
 * A separate variant from `PlotSeriesLegend`, not a `layout` prop on it: the two
 * differ in which container part they compose (`Column` vs `Row`) and in whether
 * the series carry figures at all. Same provider, same items, same click
 * behaviour.
 */
export function PlotStatsLegend({
	series,
	highlighted,
	onHighlight,
	active,
	onActiveChange,
	label,
}: {
	series: readonly PlotLegendSeries[]
	highlighted: string | null
	onHighlight: (key: string) => void
	active?: string | null
	onActiveChange?: (key: string | null) => void
	label: string
}) {
	if (series.length === 0) return null
	return (
		<PlotLegend.Provider
			series={series}
			highlighted={highlighted}
			onHighlight={onHighlight}
			active={active}
			onActiveChange={onActiveChange}
			label={label}
		>
			<PlotLegend.Column className="pl-0">
				<PlotLegend.Items />
			</PlotLegend.Column>
		</PlotLegend.Provider>
	)
}

/** How far a non-highlighted series fades, shared by every spike. */
export const MUTED_OPACITY = 0.22

/** …and how far toward the background a muted COLOUR mixes — see `muteColor`. */
export const MUTED_COLOR_AMOUNT = 0.78

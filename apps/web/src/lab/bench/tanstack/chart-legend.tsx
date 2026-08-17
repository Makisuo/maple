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
	hidden: ReadonlySet<string>
}

interface ChartLegendActions {
	toggle: (key: string) => void
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
 * Which series are hidden, owned by the CHART rather than by the legend.
 *
 * The legend cannot hold this state: hiding a series has to remove its mark and
 * re-derive the y domain, which only the spike can do. The legend renders the
 * same state and calls back into it.
 */
export function useChartLegendState(series: readonly LegendSeriesSpec[]): {
	hidden: ReadonlySet<string>
	toggle: (key: string) => void
	isVisible: (key: string) => boolean
	visible: readonly LegendSeriesSpec[]
} {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())

	const toggle = useCallback((key: string) => {
		setHidden((previous) => {
			const next = new Set(previous)
			if (!next.delete(key)) next.add(key)
			return next
		})
	}, [])

	const isVisible = useCallback((key: string) => !hidden.has(key), [hidden])

	const visible = useMemo(() => series.filter((entry) => !hidden.has(entry.key)), [series, hidden])

	return { hidden, toggle, isVisible, visible }
}

function ChartLegendProvider({
	series,
	hidden,
	onToggle,
	label,
	children,
}: {
	series: readonly LegendSeriesSpec[]
	hidden: ReadonlySet<string>
	onToggle: (key: string) => void
	label: string
	children: ReactNode
}) {
	// The provider is the only place that knows how the hidden set is managed, so
	// a chart backed by URL state or a store composes the same parts unchanged.
	const value = useMemo<ChartLegendContextValue>(
		() => ({ state: { series, hidden }, actions: { toggle: onToggle }, meta: { label } }),
		[series, hidden, onToggle, label],
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

	const isHidden = state.hidden.has(entry.key)

	return (
		<button
			type="button"
			// `aria-pressed`, not a bare button: the control is a two-state toggle and
			// the pressed state is the only thing distinguishing a hidden series from a
			// visible one for a screen reader. `opacity-40` says nothing out loud.
			aria-pressed={!isHidden}
			onClick={() => actions.toggle(entry.key)}
			className={cn(
				"flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50",
				isHidden && "opacity-40",
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
	hidden,
	onToggle,
	label,
}: {
	series: readonly LegendSeriesSpec[]
	hidden: ReadonlySet<string>
	onToggle: (key: string) => void
	label: string
}) {
	if (series.length === 0) return null
	return (
		<ChartLegend.Provider series={series} hidden={hidden} onToggle={onToggle} label={label}>
			<ChartLegend.Row>
				<ChartLegend.Items />
			</ChartLegend.Row>
		</ChartLegend.Provider>
	)
}

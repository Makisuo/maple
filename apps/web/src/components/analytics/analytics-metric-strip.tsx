import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { StatRailItem } from "../infra/primitives/stat-rail"
import {
	ANALYTICS_METRICS,
	isMetricAvailable,
	metricDelta,
	type AnalyticsMetricDescriptor,
	type AnalyticsMetricKey,
	type AnalyticsMetricSource,
} from "./metrics"

/**
 * Two rows of four, so `StatRail`'s own container is not reusable here — it
 * drops its horizontal divider above `md` on the assumption of a single row, and
 * this grid needs the rule between its two rows at every width. The classes are
 * otherwise `StatRail`'s exactly.
 *
 * The 4-up break is a *container* query, not a viewport one: with both sidebars
 * open the content column can be ~512px narrower than the viewport, and a
 * viewport `lg:` flipped to four columns inside a space that fits two. 880px is
 * the honest budget — each tile carries `px-5`, a no-wrap value ("12m 45s" at
 * 26px mono is ~110px), a `w-24` spark slot and the gaps, ~220px apiece.
 */
const GRID =
	"grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-md border bg-card @min-[880px]/page:grid-cols-4"

/** Tighter tile chrome once the 2-col grid leaves each tile under ~260px. */
const TILE_NARROW = "@max-[560px]/page:px-4 @max-[560px]/page:py-3"

interface AnalyticsMetricStripProps {
	source: AnalyticsMetricSource
	/** The comparison window, for the deltas. Absent while it loads. */
	previous?: AnalyticsMetricSource
	selected: AnalyticsMetricKey
	onSelect: (key: AnalyticsMetricKey) => void
}

/**
 * The KPI strip: eight metrics as one seamless card, each tile a button that
 * takes over the chart below it.
 *
 * The tiles are `StatRailItem` — the same readout the infrastructure pages use —
 * rather than a lookalike. Selection is the one thing this page needed that no
 * other rail did, so it went into that component as an optional prop instead of
 * becoming a second, subtly divergent stat tile.
 *
 * A tile whose metric is unavailable renders `—` and refuses selection rather
 * than disappearing. The grid is a fixed eight, and a strip that changed shape
 * depending on which SDK build an org happens to run would read as broken rather
 * than as partially instrumented.
 */
export function AnalyticsMetricStrip({ source, previous, selected, onSelect }: AnalyticsMetricStripProps) {
	return (
		<div className={GRID}>
			{ANALYTICS_METRICS.map((metric, index) => (
				<MetricTile
					key={metric.key}
					metric={metric}
					source={source}
					previous={previous}
					selected={metric.key === selected}
					onSelect={onSelect}
					// Column-indexed, not item-indexed: each tile enters with its
					// counterpart in the row above, so the strip sweeps left to right in
					// four beats at the rail's usual 60ms cadence rather than counting
					// to eight.
					delay={(index % 4) * 60}
				/>
			))}
		</div>
	)
}

function MetricTile({
	metric,
	source,
	previous,
	selected,
	onSelect,
	delay,
}: {
	metric: AnalyticsMetricDescriptor
	source: AnalyticsMetricSource
	previous?: AnalyticsMetricSource
	selected: boolean
	onSelect: (key: AnalyticsMetricKey) => void
	delay: number
}) {
	const available = isMetricAvailable(metric, source)
	const value = metric.value(source)
	const delta = available ? metricDelta(metric, source, previous) : null

	return (
		<StatRailItem
			eyebrow={metric.label}
			value={available && value !== null ? metric.format(value) : "—"}
			spark={available ? metric.series(source).map((point) => point.value) : undefined}
			delta={delta === null ? undefined : <Delta delta={delta} invert={metric.invertDelta} />}
			subline={
				available
					? metric.subline(source)
					: // The honest version of the zero this tile would otherwise show.
						"No visitor ids"
			}
			selected={selected}
			disabled={!available}
			onSelect={() => onSelect(metric.key)}
			delay={delay}
			className={TILE_NARROW}
			valueClassName="@max-[560px]/page:text-[22px]"
		/>
	)
}

/**
 * Change against the previous window.
 *
 * Colour follows *improvement*, not direction: a falling bounce rate is green.
 * The arrow keeps pointing the way the number actually moved, so colour is never
 * the only thing carrying the meaning.
 *
 * Plain tinted text rather than a filled chip — the rails elsewhere set their
 * deltas in muted mono and colour a word inline when it matters, and a pill here
 * would be the loudest thing on a page whose accent is already doing the
 * selection rail, the sparklines and the row tints.
 */
function Delta({ delta, invert }: { delta: number; invert?: boolean }) {
	const rose = delta > 0
	const flat = Math.abs(delta) < 0.001
	const good = invert ? !rose : rose

	return (
		<span
			className={cn(
				flat
					? "text-muted-foreground/70"
					: good
						? "text-[var(--severity-info)]"
						: "text-[var(--severity-error)]",
			)}
			title={`${flat ? "Flat" : rose ? "Up" : "Down"} ${formatPercent(Math.abs(delta))} vs the previous period`}
		>
			<span aria-hidden>{flat ? "→" : rose ? "↑" : "↓"}</span>
			{formatPercent(Math.abs(delta))}
		</span>
	)
}

export function AnalyticsMetricStripLoading() {
	return (
		<div className={GRID}>
			{ANALYTICS_METRICS.map((metric) => (
				<div key={metric.key} className={cn("px-5 py-4", TILE_NARROW)}>
					<Skeleton className="h-3 w-20" />
					<div className="mt-3 flex items-end justify-between gap-3">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-24" />
					</div>
					<Skeleton className="mt-3 h-3 w-28" />
				</div>
			))}
		</div>
	)
}

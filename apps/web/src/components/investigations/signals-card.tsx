/**
 * The telemetry the verdict was drawn from, for the service it blames, over the
 * window it happened in.
 *
 * Everything above this on the page is the agent's account of the incident. This
 * is the incident itself — log volume shaped by severity, and the traces the same
 * window carried. It is the first warehouse-backed widget on the investigation
 * page, and it exists so a reader can sanity-check a diagnosis without leaving it.
 *
 * Two constraints shape the whole file:
 *
 * 1. **The window is a fixed pair of instants, never `now`.** The detail route
 *    polls every 3s while a pass is investigating; a moving end-time would re-key
 *    the atom family on every tick and fire two warehouse reads a second. The card
 *    only renders once the incident window has a real end.
 * 2. **Each half fails alone.** A warehouse read that errors greys its own row.
 *    Neither can blank the card, and the card can never blank the page.
 */
import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { getServiceColor } from "@maple/ui/lib/colors"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getCustomChartTimeSeriesResultAtom,
	getServiceOverviewResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { formatForTinybird } from "@/lib/time-utils"
import { servicesTouched } from "./impact-strip"

/** The design's strip is 32 bars wide; the bucket falls out of the window, not the other way round. */
const BUCKETS = 32

export function SignalsCard({ investigation }: { investigation: V2Investigation }) {
	const window = useMemo(() => resolveWindow(investigation), [investigation])
	const service = useMemo(() => resolveService(investigation), [investigation])

	if (!window || !service) return null

	return (
		<section className="flex shrink-0 flex-col gap-4 rounded-xl border bg-card px-5 py-4">
			<header className="flex items-center gap-2">
				<span
					aria-hidden
					className="size-2 shrink-0 rounded-[3px]"
					style={{ backgroundColor: getServiceColor(service) }}
				/>
				<span className="font-mono text-sm text-foreground">{service}</span>
				{window.label ? (
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
						· {window.label}
					</span>
				) : (
					<span className="flex-1" />
				)}
				<Link
					to="/services/$serviceName"
					params={{ serviceName: service }}
					className="shrink-0 text-xs text-primary hover:underline"
				>
					Open service →
				</Link>
			</header>

			<LogsRow service={service} window={window} />
			<TracesRow service={service} window={window} />
		</section>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Logs
 * -----------------------------------------------------------------------------------------------*/

function LogsRow({ service, window }: { service: string; window: SignalWindow }) {
	const result = useAtomValue(
		getCustomChartTimeSeriesResultAtom({
			data: {
				source: "logs",
				metric: "count",
				groupBy: "severity",
				startTime: window.startTime,
				endTime: window.endTime,
				bucketSeconds: window.bucketSeconds,
				filters: { serviceName: service },
			},
		}),
	)

	return Result.builder(result)
		.onInitial(() => <RowSkeleton label="Logs" height="h-10" />)
		.onError(() => <RowUnavailable label="Logs" />)
		.onSuccess((response) => {
			const points = response.data
			if (points.length === 0) return <RowEmpty label="Logs" note="No logs in this window" />

			const bars = points.map((point) => {
				const series = point.series as Record<string, number>
				let total = 0
				let errors = 0
				let warnings = 0
				for (const [severity, count] of Object.entries(series)) {
					if (typeof count !== "number") continue
					total += count
					const key = severity.toUpperCase()
					if (key === "ERROR" || key === "FATAL") errors += count
					else if (key === "WARN" || key === "WARNING") warnings += count
				}
				return { bucket: point.bucket, total, errors, warnings }
			})

			const totals = bars.reduce(
				(sum, bar) => ({
					lines: sum.lines + bar.total,
					errors: sum.errors + bar.errors,
					warnings: sum.warnings + bar.warnings,
				}),
				{ lines: 0, errors: 0, warnings: 0 },
			)
			const peak = Math.max(...bars.map((bar) => bar.total), 1)

			return (
				<div className="flex flex-col gap-2.5">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
						<RowLabel>Logs</RowLabel>
						<Figure value={formatNumber(totals.lines)} unit="lines" />
						<Figure
							value={formatNumber(totals.errors)}
							unit="errors"
							tone={totals.errors > 0 ? "text-severity-error" : undefined}
						/>
						<Figure
							value={formatNumber(totals.warnings)}
							unit="warnings"
							tone={totals.warnings > 0 ? "text-severity-warn" : undefined}
						/>
					</div>
					{/*
					 * 32 stacked divs rather than a chart runtime. A 40px strip has no
					 * axes, no legend and no tooltip layer to justify recharts.
					 *
					 * Stacked, not painted by dominant severity: a single red bar per
					 * bucket made every bucket red the moment one error landed in it,
					 * which is exactly the reading the strip must not give on a service
					 * running a normal 1.5% error rate.
					 */}
					<div className="flex h-10 items-end gap-px" aria-hidden>
						{bars.map((bar) => (
							<span
								key={bar.bucket}
								title={`${formatNumber(bar.total)} lines${bar.errors ? ` · ${formatNumber(bar.errors)} errors` : ""}`}
								className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-[1px]"
								style={{
									// A bucket with traffic never renders as nothing: a floor is
									// the difference between "quiet" and "no data", and the strip
									// is read for exactly that distinction.
									height: `${bar.total === 0 ? 0 : Math.max(6, (bar.total / peak) * 100)}%`,
								}}
							>
								<Segment share={bar.errors / bar.total} color={SEVERITY_COLORS.ERROR} />
								<Segment share={bar.warnings / bar.total} color={SEVERITY_COLORS.WARN} />
								<span className="flex-1" style={{ backgroundColor: SEVERITY_COLORS.INFO }} />
							</span>
						))}
					</div>
				</div>
			)
		})
		.render()
}

/* -------------------------------------------------------------------------------------------------
 * Traces
 * -----------------------------------------------------------------------------------------------*/

function TracesRow({ service, window }: { service: string; window: SignalWindow }) {
	const result = useAtomValue(
		getServiceOverviewResultAtom({
			data: { startTime: window.startTime, endTime: window.endTime },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <RowSkeleton label="Traces" height="h-5" />)
		.onError(() => <RowUnavailable label="Traces" />)
		.onSuccess((response) => {
			// The overview is per service *and environment*; the busiest row for this
			// service is the one the incident happened in.
			const row = response.data
				.filter((candidate) => candidate.serviceName === service)
				.sort((left, right) => right.spanCount - left.spanCount)[0]
			if (!row) return <RowEmpty label="Traces" note="No spans in this window" />

			return (
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-3.5">
					<RowLabel>Traces</RowLabel>
					<Figure value={formatNumber(row.spanCount)} unit="spans" />
					<Figure value={formatLatency(row.p95LatencyMs)} unit="p95" />
					<Figure
						value={`${(row.errorRate * 100).toFixed(1)}%`}
						unit="error rate"
						tone={row.errorRate > 0 ? "text-severity-error" : undefined}
					/>
					<span className="flex-1" />
					<Link to="/traces" className="shrink-0 text-xs text-primary hover:underline">
						View traces →
					</Link>
				</div>
			)
		})
		.render()
}

/* -------------------------------------------------------------------------------------------------
 * Row chrome
 * -----------------------------------------------------------------------------------------------*/

/**
 * One severity's slice of a bucket. Below half a percent it is dropped rather
 * than rounded up to a 1px line — at this size a hairline reads as "there were
 * errors here" just as loudly as a third of the bar does.
 */
const Segment = ({ share, color }: { share: number; color: string }) =>
	Number.isFinite(share) && share >= 0.005 ? (
		<span
			className="w-full shrink-0"
			style={{ height: `${Math.min(100, share * 100)}%`, backgroundColor: color }}
		/>
	) : null

const RowLabel = ({ children }: { children: string }) => (
	<span className="w-14 shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
		{children}
	</span>
)

const Figure = ({ value, unit, tone }: { value: string; unit: string; tone?: string }) => (
	<span className="flex items-baseline gap-1.5">
		<span className={cn("font-mono text-base text-foreground tabular-nums", tone)}>{value}</span>
		<span className="text-xs text-muted-foreground">{unit}</span>
	</span>
)

const RowSkeleton = ({ label, height }: { label: string; height: string }) => (
	<div className="flex items-center gap-4">
		<RowLabel>{label}</RowLabel>
		<Skeleton className={cn("flex-1 rounded-md", height)} />
	</div>
)

const RowEmpty = ({ label, note }: { label: string; note: string }) => (
	<div className="flex items-baseline gap-4">
		<RowLabel>{label}</RowLabel>
		<span className="text-sm text-muted-foreground">{note}</span>
	</div>
)

/**
 * A failed warehouse read says so rather than rendering zeroes. On a page whose
 * whole job is qualifying a claim, "0 errors" that means "the query failed" is
 * the worst possible output.
 */
const RowUnavailable = ({ label }: { label: string }) => (
	<div className="flex items-baseline gap-4">
		<RowLabel>{label}</RowLabel>
		<span className="text-sm text-muted-foreground">Could not be loaded</span>
	</div>
)

/* -------------------------------------------------------------------------------------------------
 * Window and service resolution
 * -----------------------------------------------------------------------------------------------*/

interface SignalWindow {
	readonly startTime: string
	readonly endTime: string
	readonly bucketSeconds: number
	readonly label: string | null
}

/**
 * The incident's own window where the snapshot recorded one, otherwise the run's.
 * Both ends must be real instants — see the note at the top of the file.
 */
function resolveWindow(investigation: V2Investigation): SignalWindow | null {
	const { snapshot } = investigation
	const startMs = toEpochMs(snapshot.incidentStartedAt ?? investigation.created_at)
	const endAt =
		snapshot.incidentEndedAt ??
		investigation.diagnosed_at ??
		(investigation.status === "investigating" ? null : investigation.updated_at)
	if (!endAt) return null
	const endMs = toEpochMs(endAt)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null

	const seconds = (endMs - startMs) / 1000
	return {
		startTime: formatForTinybird(new Date(startMs)),
		endTime: formatForTinybird(new Date(endMs)),
		bucketSeconds: Math.max(1, Math.round(seconds / BUCKETS)),
		label: seconds >= 60 ? `${Math.round(seconds / 60)}m window` : `${Math.round(seconds)}s window`,
	}
}

/** The one service the card can speak for. A scope like "Checkout & payment capture" is not one. */
function resolveService(investigation: V2Investigation): string | null {
	const named = investigation.snapshot.serviceName?.trim()
	if (named) return named
	const [touched] = servicesTouched(investigation)
	return touched ?? null
}

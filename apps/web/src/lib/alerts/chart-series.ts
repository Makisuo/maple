import type { AlertCheckDocument, AlertRulePreviewResponse, AlertRulePreviewPoint } from "@maple/domain/http"
import { normalizeTimestampInput } from "@/lib/timezone-format"

/**
 * Everything the alert rule chart *decides* before it draws anything: which
 * time domain to frame, which of the two signal sources wins, how the wire
 * response becomes plottable rows, and where the shaded bands fall.
 *
 * It lives outside the component because all of it is pure and none of it is
 * about rendering. Inside, each rule was a `useMemo` in a thousand-line file,
 * reachable from a test only by mounting a chart in jsdom and reading captions
 * — so the interesting cases (a truncated preview, an empty-but-successful
 * query, two sources disagreeing) were effectively untested and every new rule
 * had to be wedged in as one more memo.
 */

/** The plot's x window in epoch ms. */
export interface ChartDomain {
	readonly min: number
	readonly max: number
}

/** One plotted bucket: its instant plus a value per series key. */
export type ChartPoint = { t: number } & Record<string, number | null>

/** The single-series key, used whenever the chart draws one line. */
export const SINGLE_KEY = "value"
/** The unselected source, drawn dashed behind the selected one for comparison. */
export const GHOST_KEY = "__ghost"

export type SignalSource = "preview" | "checks"
export type ResolvedSource = SignalSource | "none"

export const SIGNAL_SOURCE_LABEL: Record<SignalSource, string> = {
	preview: "Query",
	checks: "Evaluated",
} satisfies Record<SignalSource, string>

/** A shaded horizontal region — no-data, incident, or would-fire. */
export interface Band {
	readonly x1: number
	readonly x2: number
}

/**
 * Per-bucket facts the tooltip shows but the line does not carry. One record
 * per instant rather than the three parallel maps this used to be — they were
 * always written together and always read together.
 */
export interface BucketMeta {
	readonly sampleCount: number
	readonly status: string
	readonly provisional: boolean
}

// Reconciliation cost is linear in plotted points, and beyond ~1 point per 2
// horizontal pixels extra points are invisible at our widths. Tooltip, rail and
// band data stay computed from the full series.
const MAX_PLOTTED_POINTS = 720

export function downsample(rows: ReadonlyArray<ChartPoint>): ChartPoint[] {
	if (rows.length <= MAX_PLOTTED_POINTS) return [...rows]
	const stride = Math.ceil(rows.length / MAX_PLOTTED_POINTS)
	const out: ChartPoint[] = []
	for (let i = 0; i < rows.length; i += stride) out.push(rows[i]!)
	const last = rows[rows.length - 1]!
	if (out[out.length - 1] !== last) out.push(last)
	return out
}

/** Clip bands to the visible domain and drop the ones entirely outside it. */
export const clipToDomain = <T extends Band>(bands: ReadonlyArray<T>, domain: ChartDomain): Array<T & Band> =>
	bands
		.filter(
			(band) =>
				Number.isFinite(band.x1) &&
				Number.isFinite(band.x2) &&
				band.x2 >= domain.min &&
				band.x1 <= domain.max,
		)
		.map((band) => ({
			...band,
			x1: Math.max(band.x1, domain.min),
			x2: Math.min(band.x2, domain.max),
		}))

/**
 * The domain to actually frame the plot on.
 *
 * A preview that hit the server's evaluation-window cap covers only the tail of
 * the requested range. Framing on the range the user picked then squeezes the
 * whole series against the right edge of an empty grid, which reads as missing
 * data rather than as a clamp — so frame on what was evaluated instead.
 *
 * Only when the preview is the *sole* thing on the axis. The checks rail and
 * the incident lane are capped by nothing and share this domain, so re-framing
 * for the preview's sake would hide evaluations the rail's own coverage line
 * claims to cover.
 */
export const resolveChartDomain = (
	requested: ChartDomain,
	truncatedToStart: string | null | undefined,
	options: { readonly hasOverlays: boolean },
): { readonly domain: ChartDomain; readonly clampedToPreview: boolean } => {
	if (truncatedToStart == null || options.hasOverlays) {
		return { domain: requested, clampedToPreview: false }
	}
	const truncatedStart = Date.parse(truncatedToStart)
	if (!Number.isFinite(truncatedStart)) return { domain: requested, clampedToPreview: false }
	const min = Math.max(requested.min, truncatedStart)
	return min < requested.max
		? { domain: { min, max: requested.max }, clampedToPreview: true }
		: { domain: requested, clampedToPreview: false }
}

export interface PreviewProjection {
	readonly rows: ChartPoint[]
	readonly seriesKeys: string[]
	readonly isMultiSeries: boolean
	readonly hasPoints: boolean
	readonly meta: Map<number, BucketMeta>
	/** Merged spans where NO group observed data — hatched on the chart. */
	readonly noDataBands: Band[]
}

const EMPTY_PREVIEW: PreviewProjection = {
	rows: [],
	seriesKeys: [SINGLE_KEY],
	isMultiSeries: false,
	hasPoints: false,
	meta: new Map(),
	noDataBands: [],
}

/** Worst-first, so a bucket where any group breached reads as breached. */
const STATUS_RANK: Record<string, number> = { healthy: 0, skipped: 1, breached: 2 }

/**
 * Project the preview wire response onto the plot's row shape.
 *
 * Points plot at the window CLOSE — the moment the evaluator observes the
 * window — which is what makes them line up with check timestamps and reach the
 * axis edge. The trailing in-progress window is shorter than a full step, so it
 * closes at the domain edge instead of overshooting it.
 */
export const projectPreview = (
	preview: AlertRulePreviewResponse | null,
	domainMax: number,
): PreviewProjection => {
	const previewSeries = preview?.series ?? []
	// An entirely valueless preview (every window no-data) charts nothing useful
	// — the caller falls through to checks or to the placeholder instead of
	// drawing an empty grid.
	if (!previewSeries.some((s) => s.points.some((p) => p.value != null))) return EMPTY_PREVIEW

	const keys = previewSeries.map((s) => s.groupKey)
	const single = keys.length === 1
	const stepMs = (preview?.bucketSeconds ?? 60) * 1000
	const byT = new Map<number, ChartPoint>()
	const meta = new Map<number, BucketMeta>()
	/** t → how many of the bucket's points across groups carried data. */
	const coverage = new Map<number, { x1: number; x2: number; points: number; withData: number }>()

	const closeOf = (point: AlertRulePreviewPoint, open: number) =>
		point.provisional ? Math.min(open + stepMs, domainMax) : open + stepMs

	for (const series of previewSeries) {
		const key = single ? SINGLE_KEY : series.groupKey
		for (const point of series.points) {
			const open = Date.parse(point.bucket)
			if (!Number.isFinite(open)) continue
			const t = closeOf(point, open)

			let row = byT.get(t)
			if (!row) {
				row = { t }
				byT.set(t, row)
			}
			row[key] = point.value

			const previous = meta.get(t)
			meta.set(t, {
				sampleCount: (previous?.sampleCount ?? 0) + point.sampleCount,
				status:
					previous != null &&
					(STATUS_RANK[previous.status] ?? 0) >= (STATUS_RANK[point.status] ?? 0)
						? previous.status
						: point.status,
				provisional: (previous?.provisional ?? false) || point.provisional === true,
			})

			let bucket = coverage.get(t)
			if (!bucket) {
				bucket = { x1: open, x2: t, points: 0, withData: 0 }
				coverage.set(t, bucket)
			}
			bucket.points += 1
			if (point.value != null) bucket.withData += 1
		}
	}

	// Runs of windows where every group came back empty → merged hatched bands.
	const noDataBands: Band[] = []
	const empty = Array.from(coverage.values())
		.filter((b) => b.points > 0 && b.withData === 0)
		.sort((a, b) => a.x1 - b.x1)
	for (const bucket of empty) {
		const last = noDataBands[noDataBands.length - 1]
		if (last != null && bucket.x1 <= last.x2 + 1)
			noDataBands[noDataBands.length - 1] = { ...last, x2: bucket.x2 }
		else noDataBands.push({ x1: bucket.x1, x2: bucket.x2 })
	}

	return {
		rows: downsample(Array.from(byT.values()).sort((a, b) => a.t - b.t)),
		seriesKeys: single ? [SINGLE_KEY] : keys,
		isMultiSeries: !single,
		hasPoints: true,
		meta,
		noDataBands,
	}
}

/** The values the evaluator actually recorded, one point per check. */
export const projectChecks = (
	checks: ReadonlyArray<AlertCheckDocument>,
): { readonly rows: ChartPoint[]; readonly hasPoints: boolean } => {
	const rows: ChartPoint[] = checks
		.map((check) => ({
			t: new Date(normalizeTimestampInput(check.timestamp)).getTime(),
			[SINGLE_KEY]: check.observedValue,
		}))
		.filter((row) => Number.isFinite(row.t))
		.sort((a, b) => a.t - b.t)
	return { rows: downsample(rows), hasPoints: rows.some((r) => r[SINGLE_KEY] != null) }
}

/**
 * Which series to draw. The requested source wins when it has points, otherwise
 * the other one is drawn — and `fellBack` says so, because the chart used to
 * make that swap silently and change what it meant with no indication at all.
 */
export const resolveSource = (
	requested: SignalSource | undefined,
	available: { readonly preview: boolean; readonly checks: boolean },
): {
	readonly source: ResolvedSource
	readonly fellBack: boolean
	readonly bothAvailable: boolean
} => {
	const source: ResolvedSource = available.preview
		? requested === "checks" && available.checks
			? "checks"
			: "preview"
		: available.checks
			? "checks"
			: "none"
	return {
		source,
		fellBack: requested != null && source !== "none" && source !== requested,
		bothAvailable: available.preview && available.checks,
	}
}

/**
 * Fold the unselected source onto the selected series' own timestamps, so the
 * comparison ghost can share one dataset instead of shredding the primary line
 * with nulls at every instant it doesn't cover.
 *
 * `divergence` is the widest gap between the two at a shared instant — the
 * number behind "the query says one thing, the evaluator recorded another".
 */
export const mergeGhost = (
	primary: ReadonlyArray<ChartPoint>,
	ghostRows: ReadonlyArray<ChartPoint>,
	fallbackSpacing: number,
): { readonly rows: ChartPoint[]; readonly divergence: number | null } => {
	const ghostPoints = ghostRows
		.map((row) => ({ t: row.t, v: row[SINGLE_KEY] }))
		.filter((p): p is { t: number; v: number } => typeof p.v === "number")
	if (ghostPoints.length === 0) return { rows: [...primary], divergence: null }

	// Close enough to be the same window, far enough that a coarser summary
	// bucket still lands on its neighbour.
	const spacing = primary.length >= 2 ? Math.abs(primary[1]!.t - primary[0]!.t) : fallbackSpacing
	const tolerance = Math.max(spacing, 1)
	let cursor = 0
	let maxGap: number | null = null

	const rows = primary.map((row) => {
		while (
			cursor + 1 < ghostPoints.length &&
			Math.abs(ghostPoints[cursor + 1]!.t - row.t) <= Math.abs(ghostPoints[cursor]!.t - row.t)
		) {
			cursor += 1
		}
		const candidate = ghostPoints[cursor]!
		if (Math.abs(candidate.t - row.t) > tolerance) return row
		const own = row[SINGLE_KEY]
		if (typeof own === "number") {
			const gap = Math.abs(own - candidate.v)
			if (maxGap == null || gap > maxGap) maxGap = gap
		}
		return { ...row, [GHOST_KEY]: candidate.v }
	})
	return { rows, divergence: maxGap }
}

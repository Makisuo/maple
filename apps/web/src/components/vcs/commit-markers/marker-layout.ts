// Pure geometry + derivation for the chart's commit deploy markers. Kept free of
// React/recharts so it unit-tests cleanly and the overlay component stays thin.

/** A row of the per-bucket release timeline (one per distinct commit per bucket). */
export interface ReleasePoint {
	bucket: string
	commitSha: string
	/** Span count for this commit in this bucket. */
	count: number
}

export interface MarkerCommit {
	sha: string
	/** Span count in the commit's first-seen bucket. Drives the representative pick. */
	count: number
}

/** A deploy marker: a bucket where one or more *new* commits were first seen. */
export interface CommitMarker {
	/**
	 * Chart x-category this marker sits on (matches a chart data bucket exactly).
	 * Also serves as the marker's stable id (a bucket holds at most one marker).
	 */
	bucket: string
	/**
	 * Default label for the representative commit: its short sha when it's a 40-hex
	 * git sha (a full sha is an unreadable 40-char wall that forces every label to
	 * merge), or the value as-is when it's a tag / version / non-hex deploy id (those
	 * are already meaningful and must not be truncated). The host overrides this with
	 * the resolved commit message when one is available; the full sha is always one
	 * hover away in the card.
	 */
	label: string
	/** Commits first seen in this bucket, representative first. */
	commits: MarkerCommit[]
}

// Label sizing — estimated (not measured) so layout is deterministic and cheap. A
// pixel or two off only nudges the merge threshold, which is harmless. The width is
// the *rendered* label width (capped at MAX_LABEL_WIDTH, which the renderer also
// clamps to), so the collision sweep merges two labels only when they'd genuinely
// overlap rather than whenever their full text is long.
const CHAR_PX = 7
const PAD_PX = 18
const BADGE_PX = 26
const MIN_LABEL_WIDTH = 44
export const MAX_LABEL_WIDTH = 160
// Minimum horizontal gap kept between any dash and the label's left/right edge, so a
// dash's vertical never connects right at a corner of the box. Placement insets the
// dash-coverage bounds by this much.
export const EDGE_INSET = 6

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi)
}

/** Estimated rendered width (px) of a label, including the `+N` badge when present. */
export function estimateLabelWidth(label: string, commitCount: number): number {
	const text = label.length * CHAR_PX
	const badge = commitCount > 1 ? BADGE_PX : 0
	return clamp(text + badge + PAD_PX, MIN_LABEL_WIDTH, MAX_LABEL_WIDTH)
}

// A 40-hex git sha → its 7-char short form (git's own convention, narrow enough to
// stay readable and let neighbouring deploys keep their own labels). Anything else
// (tag, version, arbitrary `deployment.commit_sha`) is already a meaningful short id
// and is shown verbatim — the renderer CSS-truncates only if it's genuinely too long.
function shortLabel(sha: string): string {
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha
}

// Tolerates ISO ("…T…Z") and Tinybird ("YYYY-MM-DD HH:mm:ss", treated as UTC).
function bucketMs(bucket: string): number {
	const s = bucket.trim()
	const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`
	return new Date(iso).getTime()
}

function snapBucket(ms: number, chartMs: ReadonlyArray<{ b: string; ms: number }>): string | null {
	let best: string | null = null
	let bestDelta = Number.POSITIVE_INFINITY
	for (const c of chartMs) {
		const delta = Math.abs(c.ms - ms)
		if (delta < bestDelta) {
			bestDelta = delta
			best = c.b
		}
	}
	return best
}

// Representative ordering within a bucket: highest span count first (the version
// that actually took most of the traffic in that bucket is the most useful label),
// ties broken by sha so the pick is deterministic.
function byRepresentative(a: MarkerCommit, b: MarkerCommit): number {
	return b.count - a.count || (a.sha < b.sha ? -1 : 1)
}

/**
 * Derives deploy markers from the per-bucket release timeline.
 *
 *  - A commit's deploy = its FIRST-SEEN bucket (the earliest bucket it appears in).
 *  - BASELINE EXCLUSION: commits first seen in the window's earliest release bucket
 *    get no marker. A version already serving traffic when the window opens was
 *    (as far as the data can tell) deployed before it — marking it would draw a
 *    "deploy" that may never have happened in view. Only a commit that appears
 *    AFTER the baseline bucket is a deploy we actually witnessed.
 *  - Commits that share a first-seen bucket are grouped onto one dash. The
 *    representative (label + first card row) is the highest-span-count commit in
 *    that bucket; `count` is how many commits the bucket holds (`+N` = count − 1).
 *  - Marker buckets are snapped to the nearest chart bucket so they land on an
 *    x-tick (lines up with the series' own points).
 */
export function buildCommitMarkers(
	releases: ReadonlyArray<ReleasePoint>,
	chartBuckets: ReadonlyArray<string>,
): CommitMarker[] {
	if (releases.length === 0 || chartBuckets.length === 0) return []

	const firstSeen = new Map<string, { ms: number; count: number }>()
	for (const r of releases) {
		if (!r.commitSha) continue
		const ms = bucketMs(r.bucket)
		if (Number.isNaN(ms)) continue
		const prev = firstSeen.get(r.commitSha)
		if (!prev || ms < prev.ms) firstSeen.set(r.commitSha, { ms, count: r.count })
	}
	if (firstSeen.size === 0) return []

	// Baseline exclusion (see docstring): whatever was already running in the
	// earliest release bucket predates the window as far as we can tell.
	let baselineMs = Number.POSITIVE_INFINITY
	for (const info of firstSeen.values()) baselineMs = Math.min(baselineMs, info.ms)
	for (const [sha, info] of firstSeen) {
		if (info.ms === baselineMs) firstSeen.delete(sha)
	}
	if (firstSeen.size === 0) return []

	const chartMs = chartBuckets
		.map((b) => ({ b, ms: bucketMs(b) }))
		.filter((x) => !Number.isNaN(x.ms))
		.sort((a, b) => a.ms - b.ms)
	if (chartMs.length === 0) return []

	const byBucket = new Map<string, MarkerCommit[]>()
	for (const [sha, info] of firstSeen) {
		const snapped = snapBucket(info.ms, chartMs)
		if (!snapped) continue
		const list = byBucket.get(snapped) ?? []
		list.push({ sha, count: info.count })
		byBucket.set(snapped, list)
	}

	return Array.from(byBucket.entries())
		.map(([bucket, commits]): CommitMarker => {
			const ordered = commits.toSorted(byRepresentative)
			return { bucket, label: shortLabel(ordered[0].sha), commits: ordered }
		})
		.sort((a, b) => bucketMs(a.bucket) - bucketMs(b.bucket))
}

/** A marker resolved to a pixel x (host fills `x` via the chart's x-scale). */
export interface PositionedMarker {
	marker: CommitMarker
	x: number
}

/** A laid-out label: one box that may gather several dashes merged by proximity. */
export interface LabelGroup {
	key: string
	/** Pixel x of every dash gathered under this label, ascending. */
	dashXs: number[]
	label: string
	/** All commits across the merged markers (drives the `+N` badge and the card). */
	commits: MarkerCommit[]
	/** Left edge of the label box (clamped into the plot). */
	boxLeft: number
	/** Width of the label box — the label's own (dynamic) width, capped at the max. */
	boxWidth: number
}

/**
 * Places one label box of a known `width`, given the right edge of the previous label
 * (`prevRight`, already including the inter-label gap). This is the per-label step of
 * the greedy 1-D label-placement sweep:
 *
 *  - **Default: centered** on the midpoint of the group's dashes (`minX..maxX`), so a
 *    multi-dash label sits centered across the whole group.
 *  - **Offset right** when the previous label is too close to centre cleanly — slid to
 *    the right just enough to clear it (`prevRight`), per the user's spec ("it can also
 *    sit offset to the right").
 *  - **Covers every dash** it owns with an `EDGE_INSET` margin (`maxX + inset - width ≤
 *    left ≤ minX - inset`) so a dash's vertical connects *inside* the box, never at a
 *    corner, and **stays in the plot** (`left ∈ [plotLeft, plotRight - width]`). The
 *    merge rule keeps a group's span small enough that these constraints are mutually
 *    satisfiable; if a degenerate input (or a dash hard against the plot edge) makes
 *    them conflict, we fall back to the best balanced spot: centered, clamped in-plot.
 *
 * `dashXs` must be ascending and non-empty.
 */
function placeLabel(
	dashXs: ReadonlyArray<number>,
	width: number,
	prevRight: number,
	plotLeft: number,
	plotRight: number,
): { boxLeft: number; boxWidth: number } {
	const minX = dashXs[0]
	const maxX = dashXs[dashXs.length - 1]
	// HARD bounds — never violated: don't overlap the previous label, don't leave the plot.
	const hardLo = Math.max(prevRight, plotLeft)
	// Cap the width to the space left before the plot's right edge so the box can never be
	// pushed past it. Without this, a wide label near the right edge — clamped right up
	// against `hardLo` — would overflow and get cut off by the end of the graph. Here it
	// truncates into the narrower box instead. (Interior labels keep their full width:
	// `plotRight - hardLo` is large until you near the right edge.)
	const w = Math.min(width, Math.max(plotRight - hardLo, 0))
	const hardHi = Math.max(hardLo, plotRight - w) // == plotRight - w; max() guards w === 0
	// Inset the dash-coverage bounds so the outermost dashes sit `EDGE_INSET` inside the
	// box edges (capped at w/2 so a very narrow label can still place its single dash).
	const inset = Math.min(EDGE_INSET, w / 2)
	// SOFT target — centered across the group, nudged so both end dashes stay inset. When
	// the group is too wide to inset both ends, this window is empty and we just center;
	// the hard clamp below still guarantees no overlap and no overflow.
	const coverLo = maxX + inset - w
	const coverHi = minX - inset
	const centered = (minX + maxX) / 2 - w / 2
	const target = coverLo <= coverHi ? clamp(centered, coverLo, coverHi) : centered
	return { boxLeft: clamp(target, hardLo, hardHi), boxWidth: w }
}

/**
 * Greedy left-to-right label placement (the standard 1-D non-overlapping-labels sweep).
 * Each commit's dash gets a label centered on it. Walking rightward, the next dash
 * either **merges** into the previous label — when it falls under that label's box (or
 * within `gap` of it), growing its `+N` and re-centering the label across the whole
 * group — or **starts a new label**, which is centered on its dash but offset rightward
 * if the previous label would otherwise crowd it. Labels are dynamically sized to their
 * own text (capped at `MAX_LABEL_WIDTH`), so the collision test uses the previous
 * label's actual right edge. `positioned` must be pre-sorted ascending by x.
 */
export function layoutMarkerLabels(
	positioned: ReadonlyArray<PositionedMarker>,
	plotLeft: number,
	plotRight: number,
	gap = 6,
): LabelGroup[] {
	const groups: LabelGroup[] = []
	for (const p of positioned) {
		const last = groups[groups.length - 1]
		const prevRight = last ? last.boxLeft + last.boxWidth + gap : plotLeft
		// Merge when either:
		//  - the dash hits the previous label: there's no room to the right of it to seat a
		//    fresh label that both clears it (by `gap`) AND keeps this dash inset from its
		//    own left edge — `EDGE_INSET` here is what guarantees a non-merge can always be
		//    placed without overlapping; or
		//  - there isn't even room for a minimum-width label before the plot's right edge,
		//    so rather than render a cramped sliver against the edge we fold it into the
		//    previous label (+N).
		const hitsPrevious = p.x < prevRight + EDGE_INSET
		const noRoomBeforeEdge = plotRight - prevRight < MIN_LABEL_WIDTH
		if (last && (hitsPrevious || noRoomBeforeEdge)) {
			last.dashXs.push(p.x)
			last.commits.push(...p.marker.commits)
		} else {
			groups.push({
				key: p.marker.bucket,
				dashXs: [p.x],
				label: p.marker.label,
				commits: [...p.marker.commits],
				boxLeft: 0,
				boxWidth: 0,
			})
		}
		// One shared placement pass for both branches: the just-touched group (grown or
		// freshly pushed) is re-placed clearing the label BEFORE it (groups[-2]). For a
		// fresh group `before` is the old `last`, so `beforeRight === prevRight` computed
		// above — same input the standalone-placement path used.
		const group = groups[groups.length - 1]
		const before = groups[groups.length - 2]
		const beforeRight = before ? before.boxLeft + before.boxWidth + gap : plotLeft
		const box = placeLabel(
			group.dashXs,
			estimateLabelWidth(group.label, group.commits.length),
			beforeRight,
			plotLeft,
			plotRight,
		)
		group.boxLeft = box.boxLeft
		group.boxWidth = box.boxWidth
	}

	return groups
}

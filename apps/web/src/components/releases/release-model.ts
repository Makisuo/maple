// Pure derivations for the Releases pages. Kept free of React so the
// thresholds unit-test cleanly and the list, the swimlanes and the detail page
// all describe a release the same way.

import type { Release, ReleaseTimelineBucket } from "@/api/warehouse/releases"

/**
 * Health, worst first. A single band per release so the sidebar facet and the
 * row pill never disagree.
 *
 * - `regressed`: this version errors at least twice as often as every other
 *   version of the same service in the same window, by a margin that cannot be
 *   rounding noise.
 * - `watch`: p95 is up by a quarter or more against those other versions.
 * - `rolling`: the newest version of its service, still short of carrying the
 *   whole of the last bucket's traffic.
 * - `healthy`: none of the above, with enough traffic to say so.
 */
export type ReleaseHealth = "regressed" | "watch" | "rolling" | "healthy"

export const RELEASE_HEALTH_ORDER: ReadonlyArray<ReleaseHealth> = ["regressed", "watch", "rolling", "healthy"]

export function isReleaseHealth(value: string): value is ReleaseHealth {
	return (RELEASE_HEALTH_ORDER as ReadonlyArray<string>).includes(value)
}

// Same constants as the services table's deploy cell, so a release the list
// calls regressed is one the services page flags "errors ↑ since deploy".
export const MIN_COMPARE_SPANS = 50
const ERROR_RATIO_THRESHOLD = 2
const ERROR_RATE_MIN_DIFF = 0.005
const P95_DELTA_THRESHOLD = 0.25
/** Below this share of the last bucket, the newest version is still rolling out. */
export const ROLLOUT_COMPLETE_SHARE = 0.9

/** Every other version of the same (service, environment) in the window, merged. */
export interface ReleaseBaseline {
	spanCount: number
	errorCount: number
	errorRate: number
	/** Span-weighted mean of the other versions' p95s — a comparison, not a quantile. */
	p95LatencyMs: number
	p50LatencyMs: number
	p99LatencyMs: number
	apdexScore: number
	versions: number
}

/** One (service, environment) slice of a release, with its impact derived. */
export interface ReleaseServiceImpact {
	serviceName: string
	environment: string
	commitSha: string
	firstSeen: string
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	apdexScore: number
	/** Undefined when this is the only version of the service in the window. */
	baseline: ReleaseBaseline | undefined
	/** `errorRate / baseline.errorRate`, only when both sides clear the span floor. */
	errorRatio: number | undefined
	/** `(p95 - baseline.p95) / baseline.p95`, under the same floor. */
	p95Delta: number | undefined
	/** Share of the service's traffic in the last bucket it reported; 0 once replaced. */
	share: number | undefined
	/** True when no other version of the service has a later first-seen. */
	isNewest: boolean
	health: ReleaseHealth
}

/** One commit across every service it landed on. */
export interface ReleaseGroup {
	commitSha: string
	/** Earliest first-seen across services. */
	firstSeen: string
	services: ReleaseServiceImpact[]
	spanCount: number
	errorCount: number
	errorRate: number
	health: ReleaseHealth
}

const rate = (errors: number, spans: number) => (spans > 0 ? errors / spans : 0)

function worstHealth(values: ReadonlyArray<ReleaseHealth>): ReleaseHealth {
	for (const band of RELEASE_HEALTH_ORDER) if (values.includes(band)) return band
	return "healthy"
}

function serviceKey(serviceName: string, environment: string): string {
	return `${serviceName} ${environment}`
}

/**
 * Share of each (service, environment, commit) in the last bucket that
 * service reported. A version absent from that bucket has been replaced and
 * reads 0; a service with no timeline rows yields no entry at all.
 */
export function lastBucketShares(timeline: ReadonlyArray<ReleaseTimelineBucket>): Map<string, number> {
	const lastBucket = new Map<string, string>()
	for (const point of timeline) {
		const current = lastBucket.get(point.serviceName)
		if (current === undefined || point.bucket > current) lastBucket.set(point.serviceName, point.bucket)
	}
	const totals = new Map<string, number>()
	const counts = new Map<string, number>()
	for (const point of timeline) {
		if (lastBucket.get(point.serviceName) !== point.bucket) continue
		totals.set(point.serviceName, (totals.get(point.serviceName) ?? 0) + point.count)
		counts.set(`${point.serviceName} ${point.commitSha}`, point.count)
	}
	const shares = new Map<string, number>()
	for (const [serviceName, total] of totals) {
		if (total <= 0) continue
		for (const point of timeline) {
			if (point.serviceName !== serviceName) continue
			const key = `${serviceName} ${point.commitSha}`
			shares.set(key, (counts.get(key) ?? 0) / total)
		}
	}
	return shares
}

function deriveHealth(impact: Omit<ReleaseServiceImpact, "health">): ReleaseHealth {
	if (
		impact.errorRatio !== undefined &&
		impact.baseline !== undefined &&
		impact.errorRatio >= ERROR_RATIO_THRESHOLD &&
		impact.errorRate - impact.baseline.errorRate >= ERROR_RATE_MIN_DIFF
	) {
		return "regressed"
	}
	if (impact.p95Delta !== undefined && impact.p95Delta >= P95_DELTA_THRESHOLD) return "watch"
	// The same floor as the comparisons: a dozen spans on a brand-new version
	// is a canary's first minute, not a rollout worth a band.
	if (
		impact.isNewest &&
		impact.spanCount >= MIN_COMPARE_SPANS &&
		impact.share !== undefined &&
		impact.share > 0 &&
		impact.share < ROLLOUT_COMPLETE_SHARE &&
		impact.baseline !== undefined
	) {
		return "rolling"
	}
	return "healthy"
}

/**
 * Derive every release's impact from the per-(service, env, commit) rows and
 * the timeline. The comparison is same-window: this version against the merged
 * remainder of its service, which is what handles a canary running beside its
 * predecessor. A version that is the only one of its service has no baseline
 * and is reported healthy by default.
 */
export function deriveReleaseImpacts(
	releases: ReadonlyArray<Release>,
	timeline: ReadonlyArray<ReleaseTimelineBucket>,
): ReleaseServiceImpact[] {
	const byService = new Map<string, Release[]>()
	for (const release of releases) {
		const key = serviceKey(release.serviceName, release.environment)
		const rows = byService.get(key)
		if (rows === undefined) byService.set(key, [release])
		else rows.push(release)
	}
	const shares = lastBucketShares(timeline)

	const impacts: ReleaseServiceImpact[] = []
	for (const rows of byService.values()) {
		const newestFirstSeen = rows.reduce((max, row) => (row.firstSeen > max ? row.firstSeen : max), "")
		for (const row of rows) {
			const others = rows.filter((other) => other !== row)
			const baseline = others.length === 0 ? undefined : mergeBaseline(others)
			const errorRate = rate(row.errorCount, row.spanCount)
			const comparable =
				baseline !== undefined &&
				row.spanCount >= MIN_COMPARE_SPANS &&
				baseline.spanCount >= MIN_COMPARE_SPANS
			const errorRatio =
				comparable && baseline !== undefined
					? baseline.errorRate > 0
						? errorRate / baseline.errorRate
						: errorRate > 0
							? Number.POSITIVE_INFINITY
							: 1
					: undefined
			const p95Delta =
				comparable && baseline !== undefined && baseline.p95LatencyMs > 0
					? (row.p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs
					: undefined
			const partial: Omit<ReleaseServiceImpact, "health"> = {
				serviceName: row.serviceName,
				environment: row.environment,
				commitSha: row.commitSha,
				firstSeen: row.firstSeen,
				spanCount: row.spanCount,
				errorCount: row.errorCount,
				errorRate,
				p50LatencyMs: row.p50LatencyMs,
				p95LatencyMs: row.p95LatencyMs,
				p99LatencyMs: row.p99LatencyMs,
				apdexScore: row.apdexScore,
				baseline,
				errorRatio,
				p95Delta,
				share: shares.get(`${row.serviceName} ${row.commitSha}`),
				isNewest: row.firstSeen === newestFirstSeen,
			}
			impacts.push({ ...partial, health: deriveHealth(partial) })
		}
	}
	return impacts
}

function mergeBaseline(rows: ReadonlyArray<Release>): ReleaseBaseline {
	const spanCount = rows.reduce((sum, row) => sum + row.spanCount, 0)
	const errorCount = rows.reduce((sum, row) => sum + row.errorCount, 0)
	const weighted = (pick: (row: Release) => number) =>
		spanCount > 0 ? rows.reduce((sum, row) => sum + pick(row) * row.spanCount, 0) / spanCount : 0
	return {
		spanCount,
		errorCount,
		errorRate: rate(errorCount, spanCount),
		p95LatencyMs: weighted((row) => row.p95LatencyMs),
		p50LatencyMs: weighted((row) => row.p50LatencyMs),
		p99LatencyMs: weighted((row) => row.p99LatencyMs),
		apdexScore: weighted((row) => row.apdexScore),
		versions: rows.length,
	}
}

/** Fold per-service impacts into one group per commit, newest first. */
export function groupReleases(impacts: ReadonlyArray<ReleaseServiceImpact>): ReleaseGroup[] {
	const bySha = new Map<string, ReleaseServiceImpact[]>()
	for (const impact of impacts) {
		const list = bySha.get(impact.commitSha)
		if (list === undefined) bySha.set(impact.commitSha, [impact])
		else list.push(impact)
	}
	const groups: ReleaseGroup[] = []
	for (const [commitSha, services] of bySha) {
		const sorted = services.toSorted((a, b) => b.spanCount - a.spanCount)
		const spanCount = sorted.reduce((sum, s) => sum + s.spanCount, 0)
		const errorCount = sorted.reduce((sum, s) => sum + s.errorCount, 0)
		groups.push({
			commitSha,
			firstSeen: sorted.reduce(
				(min, s) => (s.firstSeen < min ? s.firstSeen : min),
				sorted[0]!.firstSeen,
			),
			services: sorted,
			spanCount,
			errorCount,
			errorRate: rate(errorCount, spanCount),
			health: worstHealth(sorted.map((s) => s.health)),
		})
	}
	return groups.toSorted((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0))
}

export interface ReleaseFacetCounts {
	health: Record<ReleaseHealth, number>
	services: Array<{ name: string; count: number }>
	environments: Array<{ name: string; count: number }>
}

/** Sidebar counts, from the same groups the table renders. */
export function releaseFacetCounts(groups: ReadonlyArray<ReleaseGroup>): ReleaseFacetCounts {
	const health = { regressed: 0, watch: 0, rolling: 0, healthy: 0 } satisfies Record<ReleaseHealth, number>
	const services = new Map<string, number>()
	const environments = new Map<string, number>()
	for (const group of groups) {
		health[group.health] += 1
		for (const service of group.services) {
			services.set(service.serviceName, (services.get(service.serviceName) ?? 0) + 1)
			const env = service.environment === "" ? "unknown" : service.environment
			environments.set(env, (environments.get(env) ?? 0) + 1)
		}
	}
	const toSorted = (map: Map<string, number>) =>
		[...map.entries()]
			.map(([name, count]) => ({ name, count }))
			.toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	return { health, services: toSorted(services), environments: toSorted(environments) }
}

/** A 40-hex git sha reads as its 7-char short form; tags and versions stay verbatim. */
export function shortReleaseLabel(sha: string): string {
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha
}

/**
 * Calendar-day bucket for the table's group headers, in the viewer's zone.
 * "Today" / "Yesterday" / a medium date.
 */
export function releaseDayLabel(iso: string, nowMs: number): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	const startOfDay = (ms: number) => {
		const d = new Date(ms)
		d.setHours(0, 0, 0, 0)
		return d.getTime()
	}
	const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(date.getTime())) / 86_400_000)
	if (dayDiff === 0) return "Today"
	if (dayDiff === 1) return "Yesterday"
	return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
}

/**
 * Markup-free core of the weekly digest: prop types, formatters, and the
 * status/subject derivation. Split out of `weekly-digest.ts` so callers that
 * only need subjects or content checks never pull in the compiled email
 * templates.
 */

export interface DigestService {
	name: string
	requests: number
	/** Error rate as a percentage (0–100). */
	errorRate: number
	p95Ms: number
	/** Week-over-week request delta, as a percentage. Optional. */
	requestsDelta?: number
}

export interface DigestTopError {
	message: string
	count: number
	/** Number of distinct services this error touched. */
	affectedServices?: number
	/** True when the error first appeared inside the digest window. */
	isNew?: boolean
}

export interface DigestSeriesPoint {
	/** Short axis label, e.g. weekday initial. */
	label: string
	requests: number
	errors: number
}

export interface WeeklyDigestProps {
	orgName: string
	dateRange: { start: string; end: string }
	summary: {
		requests: { value: number; delta: number }
		errors: { value: number; delta: number }
		p95Latency: { valueMs: number; delta: number }
		dataVolume: { valueBytes: number; delta: number }
	}
	/** Daily buckets across the digest window — drives the trend sparkline. */
	series: Array<DigestSeriesPoint>
	services: Array<DigestService>
	topErrors: Array<DigestTopError>
	ingestion: {
		logs: number
		traces: number
		metrics: number
		totalBytes: number
	}
	/** App base URL — used to build service/error deep links. */
	baseUrl: string
	dashboardUrl: string
	unsubscribeUrl: string
}

export function fmtNum(num: number): string {
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
	return num.toLocaleString("en-US")
}

export function fmtBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
	return `${bytes} B`
}

export function fmtLatency(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function fmtErrRate(rate: number): string {
	if (rate < 0.01) return "0%"
	if (rate < 1) return `${rate.toFixed(2)}%`
	return `${rate.toFixed(1)}%`
}

/** Absolute delta magnitude — the arrow carries the direction. */
export function fmtDeltaAbs(delta: number): string {
	return `${Math.abs(delta).toFixed(1)}%`
}

export function deltaArrow(delta: number): string {
	if (Math.abs(delta) < 0.05) return "→" // →
	return delta > 0 ? "↑" : "↓" // ↑ ↓
}

export type DigestStatusLevel = "healthy" | "watch" | "critical"

export interface DigestStatus {
	level: DigestStatusLevel
	/** Uppercase pill label. */
	label: string
	/** One-sentence plain-English verdict. */
	headline: string
	/** Optional "biggest mover" subline, or null. */
	biggestMover: string | null
	/** Punchy email subject line. */
	subject: string
}

/**
 * Pure, dependency-free derivation of the week's health verdict. Used both to
 * render the in-email banner and to build the email subject in DigestService,
 * so the two never drift.
 */
export function deriveDigestStatus(props: WeeklyDigestProps): DigestStatus {
	const { summary, services } = props
	const reqs = summary.requests.value
	const errs = summary.errors.value
	const overallErrRate = reqs > 0 ? (errs / reqs) * 100 : 0
	const errorsDelta = summary.errors.delta
	const p95Delta = summary.p95Latency.delta

	const worstSvc = services.reduce<{ name: string; rate: number }>(
		(acc, s) => (s.errorRate > acc.rate ? { name: s.name, rate: s.errorRate } : acc),
		{ name: "", rate: 0 },
	)

	let level: DigestStatusLevel = "healthy"
	if (overallErrRate >= 5 || worstSvc.rate >= 10) level = "critical"
	else if (overallErrRate >= 1 || errorsDelta >= 25 || p95Delta >= 25) level = "watch"

	const label = level === "healthy" ? "HEALTHY" : level === "watch" ? "WATCH" : "CRITICAL"

	// Biggest mover: prefer a hot service, otherwise the largest traffic swing.
	let biggestMover: string | null = null
	if (worstSvc.name && worstSvc.rate >= 1) {
		biggestMover = `${worstSvc.name} running hot — ${fmtErrRate(worstSvc.rate)} error rate`
	} else {
		const swing = services.reduce<{ name: string; d: number }>(
			(acc, s) =>
				s.requestsDelta != null &&
				Number.isFinite(s.requestsDelta) &&
				Math.abs(s.requestsDelta) > Math.abs(acc.d)
					? { name: s.name, d: s.requestsDelta }
					: acc,
			{ name: "", d: 0 },
		)
		if (swing.name && Math.abs(swing.d) >= 15) {
			biggestMover = `${swing.name} traffic ${swing.d > 0 ? "up" : "down"} ${fmtDeltaAbs(swing.d)} WoW`
		}
	}

	const errDir =
		errorsDelta <= -0.05
			? `errors down ${fmtDeltaAbs(errorsDelta)}`
			: errorsDelta >= 0.05
				? `errors up ${fmtDeltaAbs(errorsDelta)}`
				: "errors flat"

	let headline: string
	if (level === "healthy") {
		headline =
			reqs > 0
				? `Smooth week — ${fmtNum(reqs)} requests, ${errDir}.`
				: "Quiet week — not much traffic this period."
	} else {
		const lead = level === "watch" ? "Heads up" : "Action needed"
		const ledBy = worstSvc.rate >= 1 ? `, led by ${worstSvc.name}` : ""
		headline = `${lead} — error rate at ${fmtErrRate(overallErrRate)}${ledBy}.`
	}

	let subject: string
	if (level === "healthy") {
		subject = `Maple · ${fmtNum(reqs)} requests · ${deltaArrow(errorsDelta)} ${fmtDeltaAbs(errorsDelta)} errors this week`
	} else if (level === "watch") {
		subject = `⚠️ Maple · error rate ${fmtErrRate(overallErrRate)} this week`
	} else {
		subject = `\u{1f6a8} Maple · error rate ${fmtErrRate(overallErrRate)} — needs attention`
	}

	return { level, label, headline, biggestMover, subject }
}

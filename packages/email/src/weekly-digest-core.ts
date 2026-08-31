/**
 * Markup-free core of the weekly digest: prop types, formatters, and the
 * status/subject derivation. Split out of `weekly-digest.ts` so callers that
 * only need subjects or content checks never pull in the compiled email
 * templates.
 */

/**
 * A week-over-week comparison, which is not always a percentage.
 *
 * A bare number could not distinguish "no traffic last week" from "flat", and
 * the digest used to render the former as `↑ 100.0%`. It also had no way to say
 * "the base is too small for a percentage to mean anything", which is where the
 * five-figure chips came from.
 */
export type Delta =
	/** A real week-over-week percentage. */
	| { kind: "pct"; value: number }
	/** Nothing in the previous window, something in this one. */
	| { kind: "new" }
	/** Something in the previous window, nothing in this one. */
	| { kind: "gone" }
	/** Both windows empty, or the previous window below the significance floor. */
	| { kind: "none" }

/**
 * Below this much previous-window signal a percentage is noise, not news:
 * 3 → 1,400 requests is a true "+46,566%" and a useless thing to put in an
 * email. Scaled per unit, since a byte and a request are not comparable.
 */
export const DELTA_MIN_BASE = {
	/** Requests, errors, log/trace/metric counts. */
	count: 100,
	/** Data volume. */
	bytes: 1_000_000,
	/** Latency. */
	ms: 1,
} as const

export type DeltaUnit = keyof typeof DELTA_MIN_BASE

/** Percentages above this are clamped for display; the arrow keeps the sign. */
const DELTA_DISPLAY_CAP = 999

export function computeDelta(current: number, previous: number, unit: DeltaUnit = "count"): Delta {
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return { kind: "none" }
	if (previous <= 0) return current > 0 ? { kind: "new" } : { kind: "none" }
	if (current <= 0) return { kind: "gone" }
	if (previous < DELTA_MIN_BASE[unit]) return { kind: "none" }
	return { kind: "pct", value: ((current - previous) / previous) * 100 }
}

export interface DigestService {
	name: string
	/** `deployment.environment`; empty string when the service reports none. */
	environment: string
	/** `service.namespace`; empty string when the service reports none. */
	namespace: string
	requests: number
	/** Error rate as a percentage (0–100). */
	errorRate: number
	p95Ms: number
	/** Week-over-week request comparison. */
	requestsDelta: Delta
}

/** One environment's block in the service-health section. */
export interface DigestEnvironmentGroup {
	/** Empty string renders as "unspecified". */
	environment: string
	requests: number
	requestsDelta: Delta
	services: Array<DigestService>
}

/** A row of the environment / namespace breakdown table. */
export interface DigestBreakdownRow {
	label: string
	requests: number
	/** Error rate as a percentage (0–100). */
	errorRate: number
	requestsDelta: Delta
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

/** The namespace/environment slice this digest covers. Empty arrays = everything. */
export interface DigestScope {
	environments: ReadonlyArray<string>
	namespaces: ReadonlyArray<string>
}

export interface WeeklyDigestProps {
	orgName: string
	dateRange: { start: string; end: string }
	scope: DigestScope
	summary: {
		requests: { value: number; delta: Delta }
		errors: { value: number; delta: Delta }
		p95Latency: { valueMs: number; delta: Delta }
		dataVolume: { valueBytes: number; delta: Delta }
	}
	/** Daily buckets across the digest window — drives the trend sparkline. */
	series: Array<DigestSeriesPoint>
	/** Flat list, unhealthiest first — drives the subject/status derivation. */
	services: Array<DigestService>
	/** The same services, grouped by environment — drives the rendered table. */
	environmentGroups: Array<DigestEnvironmentGroup>
	/** Per-environment and per-namespace totals. */
	breakdown: {
		environments: Array<DigestBreakdownRow>
		namespaces: Array<DigestBreakdownRow>
	}
	topErrors: Array<DigestTopError>
	ingestion: {
		logs: number
		traces: number
		metrics: number
		totalBytes: number
		/**
		 * True when the digest is scoped but the ingestion figures could only be
		 * narrowed by service membership — `service_usage` carries no environment
		 * or namespace column.
		 */
		approximate: boolean
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

/**
 * One-line rendering of the slice a digest covers, or null when it covers the
 * whole org. Also disambiguates the subject line for a subscriber who receives
 * more than one scoped digest.
 */
export function fmtScopeLabel(scope: DigestScope): string | null {
	const parts = [...scope.namespaces, ...scope.environments].map(fmtScopeValue)
	return parts.length === 0 ? null : parts.join(" · ")
}

/** Environments and namespaces are optional in OTel; empty means "not reported". */
export function fmtScopeValue(value: string): string {
	return value === "" ? "unspecified" : value
}

/** Absolute delta magnitude, clamped — the arrow carries the direction. */
export function fmtDeltaAbs(delta: number): string {
	const abs = Math.abs(delta)
	if (abs > DELTA_DISPLAY_CAP) return `>${DELTA_DISPLAY_CAP}%`
	return `${abs.toFixed(1)}%`
}

export function deltaArrow(delta: number): string {
	if (Math.abs(delta) < 0.05) return "→" // →
	return delta > 0 ? "↑" : "↓" // ↑ ↓
}

/** Short label for a delta in prose (subject lines, biggest-mover sublines). */
export function fmtDeltaLabel(delta: Delta): string {
	switch (delta.kind) {
		case "pct":
			return `${deltaArrow(delta.value)} ${fmtDeltaAbs(delta.value)}`
		case "new":
			return "new"
		case "gone":
			return "gone"
		case "none":
			return "—"
	}
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

/** `payments (prod)` when the org runs more than one environment, else `payments`. */
function serviceLabel(service: DigestService, multiEnv: boolean): string {
	return multiEnv && service.environment !== "" ? `${service.name} (${service.environment})` : service.name
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
	const multiEnv = new Set(services.map((s) => s.environment)).size > 1

	const worstSvc = services.reduce<{ label: string; rate: number }>(
		(acc, s) => (s.errorRate > acc.rate ? { label: serviceLabel(s, multiEnv), rate: s.errorRate } : acc),
		{ label: "", rate: 0 },
	)

	const errorsUp = errorsDelta.kind === "pct" ? errorsDelta.value : 0
	const p95Up = p95Delta.kind === "pct" ? p95Delta.value : 0

	let level: DigestStatusLevel = "healthy"
	if (overallErrRate >= 5 || worstSvc.rate >= 10) level = "critical"
	else if (overallErrRate >= 1 || errorsUp >= 25 || p95Up >= 25) level = "watch"

	const label = level === "healthy" ? "HEALTHY" : level === "watch" ? "WATCH" : "CRITICAL"

	// Biggest mover: prefer a hot service, otherwise the largest traffic swing.
	// Only `pct` deltas qualify — "new" and "none" carry no magnitude to rank by.
	let biggestMover: string | null = null
	if (worstSvc.label && worstSvc.rate >= 1) {
		biggestMover = `${worstSvc.label} running hot — ${fmtErrRate(worstSvc.rate)} error rate`
	} else {
		const swing = services.reduce<{ label: string; d: number }>(
			(acc, s) =>
				s.requestsDelta.kind === "pct" && Math.abs(s.requestsDelta.value) > Math.abs(acc.d)
					? { label: serviceLabel(s, multiEnv), d: s.requestsDelta.value }
					: acc,
			{ label: "", d: 0 },
		)
		if (swing.label && Math.abs(swing.d) >= 15) {
			biggestMover = `${swing.label} traffic ${swing.d > 0 ? "up" : "down"} ${fmtDeltaAbs(swing.d)} WoW`
		}
	}

	const errDir =
		errorsDelta.kind === "new"
			? "first errors this week"
			: errorsDelta.kind === "gone"
				? "errors cleared"
				: errorsDelta.kind === "none"
					? "errors flat"
					: errorsDelta.value <= -0.05
						? `errors down ${fmtDeltaAbs(errorsDelta.value)}`
						: errorsDelta.value >= 0.05
							? `errors up ${fmtDeltaAbs(errorsDelta.value)}`
							: "errors flat"

	let headline: string
	if (level === "healthy") {
		headline =
			reqs > 0
				? `Smooth week — ${fmtNum(reqs)} requests, ${errDir}.`
				: "Quiet week — not much traffic this period."
	} else {
		const lead = level === "watch" ? "Heads up" : "Action needed"
		const ledBy = worstSvc.rate >= 1 ? `, led by ${worstSvc.label}` : ""
		headline = `${lead} — error rate at ${fmtErrRate(overallErrRate)}${ledBy}.`
	}

	const scopeLabel = fmtScopeLabel(props.scope)
	const brand = scopeLabel === null ? "Maple" : `Maple [${scopeLabel}]`

	let subject: string
	if (level === "healthy") {
		subject = `${brand} · ${fmtNum(reqs)} requests · ${errDir}`
	} else if (level === "watch") {
		subject = `⚠️ ${brand} · error rate ${fmtErrRate(overallErrRate)} this week`
	} else {
		subject = `\u{1f6a8} ${brand} · error rate ${fmtErrRate(overallErrRate)} — needs attention`
	}

	return { level, label, headline, biggestMover, subject }
}

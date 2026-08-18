/**
 * Runtime renderer for the weekly digest email.
 *
 * The markup lives in `emails/weekly-digest.html` and is compiled to
 * `src/generated/weekly-digest.ts` by Maizzle (`bun run --cwd packages/email
 * build`). This module only splices those strings together, so it is safe to
 * import from a Cloudflare Worker's request path.
 */
import { FRAGMENTS, PAGE } from "./generated/weekly-digest"
import { escapeHtml, fill, preheaderPadding, truncate } from "./template"
import {
	deltaArrow,
	deriveDigestStatus,
	fmtBytes,
	fmtDeltaAbs,
	fmtErrRate,
	fmtLatency,
	fmtNum,
	type DigestSeriesPoint,
	type DigestStatusLevel,
	type DigestTopError,
	type WeeklyDigestProps,
} from "./weekly-digest-core"

// Re-export the react-free core so existing importers keep working. New code
// that only needs types/derivation should import "./weekly-digest-core"
// directly and leave the compiled markup out of its module graph.
export {
	deriveDigestStatus,
	type DigestSeriesPoint,
	type DigestService,
	type DigestStatus,
	type DigestStatusLevel,
	type DigestTopError,
	type WeeklyDigestProps,
} from "./weekly-digest-core"

const C = {
	fgMuted: "#8a7f72",
	fgDim: "#5c554c",
	orange: "#e8872a",
	green: "#4aa865",
	red: "#e85d4a",
	amber: "#e8a02a",
	borderSubtle: "#302b26",
}

const STATUS_THEME: Record<
	DigestStatusLevel,
	{ accent: string; bannerBg: string; pillBg: string; pillFg: string }
> = {
	healthy: {
		accent: C.green,
		bannerBg: "rgba(74,168,101,0.09)",
		pillBg: "#2d6b3d",
		pillFg: "#d6f0de",
	},
	watch: {
		accent: C.amber,
		bannerBg: "rgba(232,160,42,0.09)",
		pillBg: "#7a5410",
		pillFg: "#f7e6c4",
	},
	critical: {
		accent: C.red,
		bannerBg: "rgba(232,93,74,0.10)",
		pillBg: "#8b3530",
		pillFg: "#f8d8d2",
	},
} satisfies Record<DigestStatusLevel, { accent: string; bannerBg: string; pillBg: string; pillFg: string }>

/** Empty string where the React tree rendered `null`. */
function deltaPill(delta: number, invertColor = false): string {
	if (!Number.isFinite(delta)) return ""
	const neutral = Math.abs(delta) < 0.05
	const isPositive = delta >= 0
	const isGood = invertColor ? !isPositive : isPositive
	const palette = neutral
		? { color: C.fgMuted, bg: "rgba(138,127,114,0.14)" }
		: isGood
			? { color: C.green, bg: "rgba(74,168,101,0.15)" }
			: { color: C.red, bg: "rgba(232,93,74,0.15)" }

	return fill(FRAGMENTS.deltaPill, {
		bg: palette.bg,
		color: palette.color,
		arrow: deltaArrow(delta),
		value: fmtDeltaAbs(delta),
	})
}

/** Dim when flat, otherwise the direction's colour — no "good/bad" inversion. */
function trendColor(delta: number): string {
	if (Math.abs(delta) < 0.05) return C.fgDim
	return delta > 0 ? C.green : C.red
}

function errRateColor(rate: number): string {
	if (rate >= 5) return C.red
	if (rate >= 1) return C.amber
	return C.fgMuted
}

function statusDotColor(rate: number): string {
	if (rate >= 5) return C.red
	if (rate >= 1) return C.amber
	return C.green
}

function rowBorder(index: number, total: number): string {
	return index < total - 1 ? `1px solid ${C.borderSubtle}` : "none"
}

const MAX_BAR = 52

function sparkline(series: ReadonlyArray<DigestSeriesPoint>): {
	bars: string
	labels: string
} {
	const maxReq = Math.max(1, ...series.map((point) => point.requests))
	const bars = series.map((point) => {
		const reqH = point.requests > 0 ? Math.max(2, Math.round((point.requests / maxReq) * MAX_BAR)) : 0
		let errH = point.requests > 0 ? Math.round((point.errors / point.requests) * reqH) : 0
		if (point.errors > 0) errH = Math.max(2, errH)
		errH = Math.min(errH, reqH)
		const okH = Math.max(0, reqH - errH)
		return fill(
			FRAGMENTS.sparkBar,
			{},
			{
				barOk:
					okH > 0
						? fill(FRAGMENTS.barOk, {
								h: String(okH),
								radiusBottom: errH > 0 ? "0" : "3px",
							})
						: "",
				barErr:
					errH > 0
						? fill(FRAGMENTS.barErr, {
								h: String(errH),
								radiusTop: okH > 0 ? "0" : "3px",
							})
						: "",
			},
		)
	})
	const labels = series.map((point) => fill(FRAGMENTS.sparkLabel, { label: point.label }))
	return { bars: bars.join(""), labels: labels.join("") }
}

function summaryCard(label: string, value: string, delta: number, invertColor = false): string {
	return fill(FRAGMENTS.summaryCard, { label, value }, { deltaPill: deltaPill(delta, invertColor) })
}

function errorRow(error: DigestTopError, index: number, total: number): string {
	const affected = error.affectedServices
	return fill(
		FRAGMENTS.errorRow,
		{
			rowBorder: rowBorder(index, total),
			index: String(index + 1),
			message: truncate(error.message, 64),
			count: fmtNum(error.count),
		},
		{
			newBadge: error.isNew === true ? FRAGMENTS.newBadge : "",
			affectedServices:
				affected != null && affected > 0
					? fill(FRAGMENTS.affectedServices, {
							text: `${affected} service${affected === 1 ? "" : "s"} affected`,
						})
					: "",
		},
	)
}

export function renderWeeklyDigest(props: WeeklyDigestProps): string {
	const { orgName, dateRange, summary, series, services, topErrors, ingestion } = props
	const status = deriveDigestStatus(props)
	const theme = STATUS_THEME[status.level]

	const previewText = `${status.label === "HEALTHY" ? "" : `${status.label} · `}${fmtNum(summary.requests.value)} reqs, ${fmtNum(summary.errors.value)} errors — ${orgName} weekly digest`

	const statusBanner = fill(
		FRAGMENTS.statusBanner,
		{
			accent: theme.accent,
			bannerBg: theme.bannerBg,
			pillBg: theme.pillBg,
			pillFg: theme.pillFg,
			label: status.label,
			headline: status.headline,
		},
		{
			biggestMover:
				status.biggestMover != null
					? fill(FRAGMENTS.biggestMover, { text: status.biggestMover })
					: "",
		},
	)

	let sparklineSection = ""
	if (series.length > 0) {
		const { bars, labels } = sparkline(series)
		sparklineSection = fill(
			FRAGMENTS.sparklineSection,
			{ totalRequests: fmtNum(summary.requests.value) },
			{ deltaPill: deltaPill(summary.requests.delta), sparkBars: bars, sparkLabels: labels },
		)
	}

	const servicesSection =
		services.length === 0
			? ""
			: fill(
					FRAGMENTS.servicesSection,
					{},
					{
						serviceRows: services
							.map((service, index) => {
								const delta = service.requestsDelta
								return fill(
									FRAGMENTS.serviceRow,
									{
										rowBorder: rowBorder(index, services.length),
										url: `${props.baseUrl}/services/${encodeURIComponent(service.name)}?timePreset=7d`,
										dotColor: statusDotColor(service.errorRate),
										name: truncate(service.name, 24),
										requests: fmtNum(service.requests),
										errRate: fmtErrRate(service.errorRate),
										errRateColor: errRateColor(service.errorRate),
										p95: fmtLatency(service.p95Ms),
									},
									{
										serviceRequestsDelta:
											delta != null && Number.isFinite(delta)
												? fill(FRAGMENTS.serviceRequestsDelta, {
														color: trendColor(delta),
														arrow: deltaArrow(delta),
														value: fmtDeltaAbs(delta),
													})
												: "",
									},
								)
							})
							.join("\n"),
					},
				)

	const errorsSection =
		topErrors.length === 0
			? ""
			: fill(
					FRAGMENTS.errorsSection,
					{ errorsUrl: `${props.baseUrl}/errors?timePreset=7d` },
					{
						errorRows: topErrors
							.map((error, index) => errorRow(error, index, topErrors.length))
							.join("\n"),
					},
				)

	const ingestionCells = [
		{ label: "Logs", value: fmtNum(ingestion.logs), delta: null },
		{ label: "Traces", value: fmtNum(ingestion.traces), delta: null },
		{ label: "Metrics", value: fmtNum(ingestion.metrics), delta: null },
		{ label: "Total", value: fmtBytes(ingestion.totalBytes), delta: summary.dataVolume.delta },
	]
		.map(({ label, value, delta }) =>
			fill(
				FRAGMENTS.ingestionCell,
				{ label, value },
				{
					ingestionDelta:
						delta != null && Number.isFinite(delta)
							? fill(FRAGMENTS.ingestionDelta, {
									color: trendColor(delta),
									arrow: deltaArrow(delta),
									value: fmtDeltaAbs(delta),
								})
							: "",
				},
			),
		)
		.join("")

	return fill(
		PAGE,
		{
			previewText,
			orgName: truncate(orgName, 32),
			dateStart: dateRange.start,
			dateEnd: dateRange.end,
			dashboardUrl: props.dashboardUrl,
			baseUrl: props.baseUrl,
			unsubscribeUrl: props.unsubscribeUrl,
		},
		{
			preheaderPad: escapeHtml(preheaderPadding(previewText)),
			statusBanner,
			sparklineSection,
			summaryRowOne:
				summaryCard("Requests", fmtNum(summary.requests.value), summary.requests.delta) +
				summaryCard("Errors", fmtNum(summary.errors.value), summary.errors.delta, true),
			summaryRowTwo:
				summaryCard(
					"P95 Latency",
					fmtLatency(summary.p95Latency.valueMs),
					summary.p95Latency.delta,
					true,
				) +
				summaryCard("Data Volume", fmtBytes(summary.dataVolume.valueBytes), summary.dataVolume.delta),
			servicesSection,
			errorsSection,
			ingestionCells,
		},
	)
}

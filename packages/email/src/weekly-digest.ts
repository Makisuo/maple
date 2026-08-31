/**
 * Runtime renderer for the weekly digest email.
 *
 * The markup lives in `emails/weekly-digest.vue` and is compiled to
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
	fmtScopeLabel,
	fmtScopeValue,
	type Delta,
	type DigestBreakdownRow,
	type DigestEnvironmentGroup,
	type DigestSeriesPoint,
	type DigestService,
	type DigestStatusLevel,
	type DigestTopError,
	type WeeklyDigestProps,
} from "./weekly-digest-core"

// Re-export the react-free core so existing importers keep working. New code
// that only needs types/derivation should import "./weekly-digest-core"
// directly and leave the compiled markup out of its module graph.
export {
	computeDelta,
	deriveDigestStatus,
	type Delta,
	type DigestBreakdownRow,
	type DigestEnvironmentGroup,
	type DigestScope,
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

/**
 * Arrow + text for one delta. `new`/`gone`/`none` carry no percentage, so they
 * render as a word rather than a number — the whole point of the `Delta` union
 * is that "no traffic last week" must never come out as `↑ 100.0%`.
 */
function deltaParts(
	delta: Delta,
	invertColor: boolean,
): { arrow: string; value: string; good: boolean | null } {
	switch (delta.kind) {
		case "pct": {
			if (Math.abs(delta.value) < 0.05)
				return { arrow: deltaArrow(0), value: fmtDeltaAbs(0), good: null }
			const isPositive = delta.value > 0
			return {
				arrow: deltaArrow(delta.value),
				value: fmtDeltaAbs(delta.value),
				good: invertColor ? !isPositive : isPositive,
			}
		}
		case "new":
			return { arrow: "", value: "new", good: invertColor ? false : true }
		case "gone":
			return { arrow: "", value: "none this week", good: invertColor ? true : false }
		case "none":
			return { arrow: "", value: "—", good: null }
	}
}

/** Empty string where the React tree rendered `null`. */
function deltaPill(delta: Delta, invertColor = false): string {
	const { arrow, value, good } = deltaParts(delta, invertColor)
	const palette =
		good === null
			? { color: C.fgMuted, bg: "rgba(138,127,114,0.14)" }
			: good
				? { color: C.green, bg: "rgba(74,168,101,0.15)" }
				: { color: C.red, bg: "rgba(232,93,74,0.15)" }

	return fill(FRAGMENTS.deltaPill, {
		bg: palette.bg,
		color: palette.color,
		arrow,
		value,
	})
}

/** Dim when flat or unquantified, otherwise the direction's colour. */
function trendColor(delta: Delta): string {
	if (delta.kind === "none") return C.fgDim
	if (delta.kind === "new") return C.green
	if (delta.kind === "gone") return C.red
	if (Math.abs(delta.value) < 0.05) return C.fgDim
	return delta.value > 0 ? C.green : C.red
}

/** Bare arrow + magnitude line, used under service and breakdown request counts. */
function trendLine(fragment: string, delta: Delta): string {
	const { arrow, value } = deltaParts(delta, false)
	return fill(fragment, { color: trendColor(delta), arrow, value })
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

function summaryCard(label: string, value: string, delta: Delta, invertColor = false): string {
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

/**
 * A service row's deep link. Carries the environment and namespace so the link
 * lands on the same slice the row describes rather than on the service's
 * org-wide totals.
 */
function serviceUrl(baseUrl: string, service: DigestService): string {
	const params = new URLSearchParams({ timePreset: "7d" })
	if (service.environment !== "") params.set("environments", service.environment)
	if (service.namespace !== "") params.set("namespaces", service.namespace)
	return `${baseUrl}/services/${encodeURIComponent(service.name)}?${params.toString()}`
}

/**
 * A service row. The namespace always earns a chip when set; the environment
 * only does when the table is not already grouped by it (`showEnvChip`), so a
 * grouped table does not repeat "prod" on every row under the "PROD" header.
 */
function serviceRow(
	service: DigestService,
	index: number,
	total: number,
	baseUrl: string,
	showEnvChip: boolean,
): string {
	const chips = [
		showEnvChip && service.environment !== "" ? service.environment : null,
		service.namespace !== "" ? service.namespace : null,
	].filter((label): label is string => label !== null)

	return fill(
		FRAGMENTS.serviceRow,
		{
			rowBorder: rowBorder(index, total),
			url: serviceUrl(baseUrl, service),
			dotColor: statusDotColor(service.errorRate),
			name: truncate(service.name, 24),
			requests: fmtNum(service.requests),
			errRate: fmtErrRate(service.errorRate),
			errRateColor: errRateColor(service.errorRate),
			p95: fmtLatency(service.p95Ms),
		},
		{
			serviceRequestsDelta: trendLine(FRAGMENTS.serviceRequestsDelta, service.requestsDelta),
			serviceScope: chips.map((label) => fill(FRAGMENTS.scopeChip, { label })).join(""),
		},
	)
}

/**
 * Service health, split into one block per environment.
 *
 * A single-environment org gets no headers at all — the block would carry no
 * information the summary cards do not already have. The row borders are
 * computed against the flattened row sequence so the last row of the table (not
 * of each group) is the one without a separator.
 */
function servicesSection(groups: ReadonlyArray<DigestEnvironmentGroup>, baseUrl: string): string {
	const totalRows = groups.reduce((sum, group) => sum + group.services.length, 0)
	if (totalRows === 0) return ""

	const showHeaders = groups.length > 1
	const rows: string[] = []
	let rendered = 0

	for (const group of groups) {
		if (showHeaders) {
			rows.push(
				fill(
					FRAGMENTS.envGroupHeader,
					{
						environment: fmtScopeValue(group.environment),
						requests: fmtNum(group.requests),
					},
					{ groupDelta: trendLine(FRAGMENTS.serviceRequestsDelta, group.requestsDelta) },
				),
			)
		}
		for (const service of group.services) {
			rows.push(serviceRow(service, rendered, totalRows, baseUrl, !showHeaders))
			rendered += 1
		}
	}

	return fill(FRAGMENTS.servicesSection, {}, { serviceRows: rows.join("\n") })
}

function breakdownTable(heading: string, rows: ReadonlyArray<DigestBreakdownRow>): string {
	if (rows.length < 2) return ""
	return fill(
		FRAGMENTS.breakdownTable,
		{ heading },
		{
			breakdownRows: rows
				.map((row, index) =>
					fill(
						FRAGMENTS.breakdownRow,
						{
							rowBorder: rowBorder(index, rows.length),
							label: truncate(fmtScopeValue(row.label), 28),
							requests: fmtNum(row.requests),
							errRate: fmtErrRate(row.errorRate),
							errRateColor: errRateColor(row.errorRate),
						},
						{ breakdownDelta: trendLine(FRAGMENTS.serviceRequestsDelta, row.requestsDelta) },
					),
				)
				.join("\n"),
		},
	)
}

export function renderWeeklyDigest(props: WeeklyDigestProps): string {
	const { orgName, dateRange, summary, series, topErrors, ingestion, environmentGroups, breakdown } = props
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
		{
			label: "Total",
			value: fmtBytes(ingestion.totalBytes),
			delta: summary.dataVolume.delta,
		},
	]
		.map(({ label, value, delta }) =>
			fill(
				FRAGMENTS.ingestionCell,
				{ label, value },
				{ ingestionDelta: delta === null ? "" : trendLine(FRAGMENTS.ingestionDelta, delta) },
			),
		)
		.join("")

	const scopeLabel = fmtScopeLabel(props.scope)

	return fill(
		PAGE,
		{
			previewText,
			orgName: truncate(orgName, 32),
			dateStart: dateRange.start,
			dateEnd: dateRange.end,
			// `service_usage` has no environment or namespace column, so a scoped
			// digest narrows ingestion by service membership instead. Say so rather
			// than presenting an approximation as exact.
			ingestionHeading: ingestion.approximate ? "Ingestion (by service, approx.)" : "Ingestion",
			dashboardUrl: props.dashboardUrl,
			baseUrl: props.baseUrl,
			unsubscribeUrl: props.unsubscribeUrl,
		},
		{
			preheaderPad: escapeHtml(preheaderPadding(previewText)),
			scopeLine: scopeLabel === null ? "" : fill(FRAGMENTS.scopeLine, { text: scopeLabel }),
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
			breakdownSections:
				breakdownTable("By environment", breakdown.environments) +
				breakdownTable("By namespace", breakdown.namespaces),
			servicesSection: servicesSection(environmentGroups, props.baseUrl),
			errorsSection,
			ingestionCells,
		},
	)
}

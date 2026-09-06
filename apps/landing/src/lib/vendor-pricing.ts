/**
 * Vendor price models — the arithmetic behind the pricing calculator and the
 * server-rendered receipts on `/compare/*`.
 *
 * Pure TypeScript, no React, so an Astro template can price the reference
 * workload at build time and the calculator island can price the visitor's
 * own sliders in the browser from the same functions. The two can't drift:
 * the receipt on a compare page is `estimate(vendor, defaults(vendor))`.
 *
 * Every rate below is a published list price and carries its date in
 * `PRICES_VERIFIED`. Where a vendor meters in counts rather than bytes, the
 * Maple branch converts with a per-item estimate documented at that branch.
 */

export type Vendor = "datadog" | "grafana" | "new-relic" | "dash0" | "openobserve"

/** Month the list prices were last checked against the vendors' pages. */
export const PRICES_VERIFIED = "2026-08"

export interface SliderConfig {
	key: string
	label: string
	min: number
	max: number
	step: number
	default: number
	unit: string
}

export interface LineItem {
	label: string
	value: number
	detail: string
}

export interface Estimate {
	total: number
	breakdown: LineItem[]
}

export const vendorConfigs = {
	datadog: {
		name: "Datadog",
		sliders: [
			{ key: "hosts", label: "Infrastructure hosts", min: 5, max: 500, step: 5, default: 15, unit: "hosts" },
			{ key: "apmHosts", label: "APM hosts", min: 0, max: 500, step: 5, default: 10, unit: "hosts" },
			{ key: "logVolume", label: "Log volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
			{ key: "teamSize", label: "Team size", min: 1, max: 200, step: 1, default: 10, unit: "users" },
		],
	},
	grafana: {
		name: "Grafana Cloud",
		sliders: [
			{ key: "metricSeries", label: "Active metric series", min: 10, max: 2000, step: 10, default: 50, unit: "k series" },
			{ key: "logVolume", label: "Log volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
			{ key: "traceVolume", label: "Trace volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
			{ key: "teamSize", label: "Team size", min: 1, max: 200, step: 1, default: 10, unit: "users" },
		],
	},
	"new-relic": {
		name: "New Relic",
		sliders: [
			{ key: "fullUsers", label: "Full platform users", min: 1, max: 200, step: 1, default: 10, unit: "users" },
			{ key: "dataVolume", label: "Total data volume", min: 100, max: 10000, step: 50, default: 300, unit: "GB/mo" },
		],
	},
	dash0: {
		name: "Dash0",
		sliders: [
			{ key: "spans", label: "Spans / mo", min: 10, max: 5000, step: 10, default: 100, unit: "M" },
			{ key: "logs", label: "Log records / mo", min: 10, max: 5000, step: 10, default: 100, unit: "M" },
			{ key: "metricPoints", label: "Metric data points / mo", min: 10, max: 20000, step: 50, default: 500, unit: "M" },
		],
	},
	openobserve: {
		name: "OpenObserve",
		sliders: [
			{ key: "logVolume", label: "Log volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
			{ key: "traceVolume", label: "Trace volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
			{ key: "metricVolume", label: "Metric volume", min: 10, max: 10000, step: 50, default: 100, unit: "GB/mo" },
		],
	},
} satisfies Record<Vendor, { name: string; sliders: SliderConfig[] }>

/** The slider defaults — the reference workload the receipts are priced on. */
export const defaultValues = (vendor: Vendor): Record<string, number> => {
	const values: Record<string, number> = {}
	for (const slider of vendorConfigs[vendor].sliders) values[slider.key] = slider.default
	return values
}

/** "15 hosts", "1.5 TB/mo" — the same rendering the slider shows. */
export const formatSliderValue = (config: SliderConfig, value: number): string =>
	config.unit.includes("GB") && value >= 1000
		? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} TB/mo`
		: `${value.toLocaleString()} ${config.unit}`

/**
 * "Infrastructure hosts 15 · APM hosts 10 · …" — the reference workload as a
 * sentence. Values alone read as "15 hosts · 10 hosts", which says nothing.
 */
export const describeWorkload = (vendor: Vendor, values: Record<string, number>): string =>
	vendorConfigs[vendor].sliders.map((slider) => `${slider.label} ${formatSliderValue(slider, values[slider.key])}`).join(" · ")

export const formatCurrency = (amount: number): string => {
	if (amount >= 100000) return `$${(amount / 1000).toFixed(0)}k`
	if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`
	return `$${Math.round(amount).toLocaleString()}`
}

const datadog = (values: Record<string, number>): Estimate => {
	// Published (annual billing): Infrastructure Pro $15/host, APM $31/host,
	// log ingestion $0.10/GB, log indexing $1.70/M events at 15-day retention.
	const infraCost = values.hosts * 15
	const apmCost = values.apmHosts * 31
	const logIngestion = values.logVolume * 0.1
	// Indexing assumes ~1 KB/event (≈1M events per GB) with ~15% of events
	// indexed — deliberately conservative; many Datadog setups index more.
	const logIndexing = values.logVolume * 0.15 * 1.7
	const totalLog = logIngestion + logIndexing

	return {
		total: infraCost + apmCost + totalLog,
		breakdown: [
			{ label: "Infrastructure", value: infraCost, detail: `${values.hosts} hosts × $15` },
			{ label: "APM", value: apmCost, detail: `${values.apmHosts} hosts × $31` },
			{ label: "Log management", value: totalLog, detail: `${values.logVolume} GB ingested + indexing` },
		].filter((item) => item.value > 0),
	}
}

const grafana = (values: Record<string, number>): Estimate => {
	// Published pay-as-you-go: $19/mo platform fee, metrics $6.50 per 1k active
	// series beyond 10k free, logs & traces $0.45/GB ingested ($0.05 process +
	// $0.40 write; retention and query billed separately, not modeled) beyond
	// 50 GB free each, $8 per active user beyond 3 free.
	const platformFee = 19
	const metricSeriesK = values.metricSeries
	const metricsOverage = Math.max(0, metricSeriesK - 10) * 6.5
	const logsOverage = Math.max(0, values.logVolume - 50) * 0.45
	const tracesOverage = Math.max(0, values.traceVolume - 50) * 0.45
	const userCost = Math.max(0, values.teamSize - 3) * 8

	return {
		total: platformFee + metricsOverage + logsOverage + tracesOverage + userCost,
		breakdown: [
			{ label: "Platform fee", value: platformFee, detail: "Base plan" },
			{ label: "Metrics", value: metricsOverage, detail: `${metricSeriesK}k series (10k free)` },
			{ label: "Logs", value: logsOverage, detail: `${values.logVolume} GB (50 GB free)` },
			{ label: "Traces", value: tracesOverage, detail: `${values.traceVolume} GB (50 GB free)` },
			{ label: "Users", value: userCost, detail: `${values.teamSize} users × $8 (3 free)` },
		],
	}
}

const newRelic = (values: Record<string, number>): Estimate => {
	// Published pricing: Standard is $10 for the first full platform user +
	// $99 per additional user, capped at 5 users; teams above 5 need Pro at
	// $349/user/mo (annual commitment; $418.80 month-to-month). Data ingest
	// beyond the free 100 GB is $0.40/GB on the Original Data option.
	const users = values.fullUsers
	const onStandard = users <= 5
	const userCost = onStandard ? 10 + (users - 1) * 99 : users * 349
	const dataOverage = Math.max(0, values.dataVolume - 100) * 0.4

	return {
		total: userCost + dataOverage,
		breakdown: [
			{
				label: "Full platform users",
				value: userCost,
				detail: onStandard ? `Standard: $10 first user + ${users - 1} × $99` : `Pro: ${users} users × $349/mo (annual)`,
			},
			{ label: "Data ingestion", value: dataOverage, detail: `${values.dataVolume} GB (100 GB free)` },
		],
	}
}

const dash0 = (values: Record<string, number>): Estimate => {
	// Dash0 published per-data-point pricing: spans & logs $0.60 per million,
	// metrics $0.20 per million.
	const spanCost = values.spans * 0.6
	const logCost = values.logs * 0.6
	const metricCost = values.metricPoints * 0.2

	return {
		total: spanCost + logCost + metricCost,
		breakdown: [
			{ label: "Spans", value: spanCost, detail: `${values.spans}M × $0.60/M` },
			{ label: "Logs", value: logCost, detail: `${values.logs}M × $0.60/M` },
			{ label: "Metrics", value: metricCost, detail: `${values.metricPoints}M × $0.20/M` },
		].filter((item) => item.value > 0),
	}
}

const openObserve = (values: Record<string, number>): Estimate => {
	// OpenObserve Cloud published pricing: $0.50/GB ingested (their headline
	// rate, which already includes the 30% annual-commitment discount — the
	// cheapest published rate). Query volume ($0.01/GB scanned) and extended
	// retention ($0.02/GB per extra 30 days) are not modeled, which biases the
	// estimate in OpenObserve's favor.
	const logCost = values.logVolume * 0.5
	const traceCost = values.traceVolume * 0.5
	const metricCost = values.metricVolume * 0.5

	return {
		total: logCost + traceCost + metricCost,
		breakdown: [
			{ label: "Logs", value: logCost, detail: `${values.logVolume} GB × $0.50` },
			{ label: "Traces", value: traceCost, detail: `${values.traceVolume} GB × $0.50` },
			{ label: "Metrics", value: metricCost, detail: `${values.metricVolume} GB × $0.50` },
		].filter((item) => item.value > 0),
	}
}

/** What the vendor charges for `values` — the slider state of `vendorConfigs[vendor]`. */
export const estimateVendor = (vendor: Vendor, values: Record<string, number>): Estimate => {
	if (vendor === "datadog") return datadog(values)
	if (vendor === "grafana") return grafana(values)
	if (vendor === "dash0") return dash0(values)
	if (vendor === "openobserve") return openObserve(values)
	return newRelic(values)
}

/** What Maple charges for the same workload, converted into decoded OTLP volume. */
export const estimateMaple = (vendor: Vendor, values: Record<string, number>): Estimate => {
	// Maple Startup (autumn.config.ts): $39/mo with 100 GB included per signal
	// (logs, traces, metrics) and $0.30/GB overage billed per signal — the
	// allowances are not a fungible 300 GB pool. Maple meters decoded OTLP
	// payload bytes; where a competitor bills in counts instead of volume, the
	// branch converts using a per-item byte estimate documented at that branch.
	const baseCost = 39
	let logsGB = 0
	let tracesGB = 0
	let metricsGB = 0

	if (vendor === "datadog") {
		// Trace volume from APM hosts is a rough estimate: ~25 GB of spans per
		// host per month (≈10 spans/sec at ~1 KB/span). Real per-host volume
		// varies widely — Datadog's own included allotment is 150 GB/host.
		logsGB = values.logVolume
		tracesGB = values.apmHosts * 25
	} else if (vendor === "grafana") {
		// Grafana bills active series, which assumes 1 data point per minute
		// per series. 1k series × 43,200 min/mo × ~0.1 KB/point ≈ 4.32 GB.
		logsGB = values.logVolume
		tracesGB = values.traceVolume
		metricsGB = values.metricSeries * 4.32
	} else if (vendor === "openobserve") {
		// Both bill per GB ingested, so volumes map across directly.
		logsGB = values.logVolume
		tracesGB = values.traceVolume
		metricsGB = values.metricVolume
	} else if (vendor === "dash0") {
		// Dash0 bills per item; convert counts to decoded OTLP volume at
		// ~1 KB per span and per log record, ~0.1 KB per metric data point.
		tracesGB = values.spans * 1
		logsGB = values.logs * 1
		metricsGB = values.metricPoints * 0.1
	} else {
		// New Relic's slider is one total volume; assume it splits evenly
		// across the three signals (under an even split the per-signal
		// overage sum equals max(0, total − 300)).
		logsGB = values.dataVolume / 3
		tracesGB = values.dataVolume / 3
		metricsGB = values.dataVolume / 3
	}

	const overageGB = Math.max(0, logsGB - 100) + Math.max(0, tracesGB - 100) + Math.max(0, metricsGB - 100)
	const overage = overageGB * 0.3

	return {
		total: baseCost + overage,
		breakdown: [
			{ label: "Startup plan", value: baseCost, detail: "100 GB per signal included" },
			...(overage > 0 ? [{ label: "Overage", value: overage, detail: `${Math.round(overageGB)} GB over × $0.30` }] : []),
			{ label: "Team seats", value: 0, detail: "No per-seat fees" },
		],
	}
}

/**
 * The per-vendor caveat under every estimate. Literal English, matching the
 * calculator's own disclaimer — these are modelling assumptions, not copy.
 */
export const vendorCaveat = {
	grafana:
		"Grafana bills active series (1 data point per minute per series), so the Maple estimate converts 1k active series to ~4.32 GB/mo assuming ~0.1 KB per decoded metric data point — your real ratio depends on attribute sizes. Grafana log and trace rates model ingest (process + write); retention and query fees are not included.",
	datadog:
		"Trace volume is estimated at ~25 GB of spans per APM host per month, and Datadog log indexing assumes ~1 KB per event with ~15% of events indexed; actual volumes depend on request rate and instrumentation density.",
	"new-relic":
		"New Relic modeled on Standard ($10 first user + $99/user, max 5) up to 5 full platform users and Pro ($349/user/mo, annual commitment) above, with the Original Data option ($0.40/GB beyond 100 GB free); data is assumed to split evenly across logs, traces, and metrics.",
	dash0:
		"Dash0 bills per data point (spans & logs $0.60/M, metrics $0.20/M); Maple bills per GB, so the Maple estimate converts at roughly 1 KB per span and log record and 0.1 KB per metric data point. Your real ratio depends on attribute and payload sizes.",
	openobserve:
		"OpenObserve modeled at its headline $0.50/GB ingestion rate, which already includes the 30% annual-commitment discount; query fees ($0.01/GB scanned) and extended retention beyond the included 30 days for logs and traces ($0.02/GB per additional 30 days) are not included, which favors OpenObserve.",
} satisfies Record<Vendor, string>

export const MAPLE_PRICING_NOTE =
	"Maple pricing based on the Startup plan ($39/mo with 100 GB included per signal — logs, traces, metrics — then $0.30/GB, billed per signal), metered on uncompressed (decoded OTLP) bytes."

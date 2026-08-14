import { useState, useMemo, useRef } from "react"
import { trackLanding } from "../lib/telemetry"

export type Competitor = "datadog" | "grafana" | "new-relic" | "dash0"

interface SliderConfig {
	key: string
	label: string
	min: number
	max: number
	step: number
	default: number
	unit: string
}

export const competitorConfigs: Record<Competitor, { name: string; sliders: SliderConfig[] }> = {
	datadog: {
		name: "Datadog",
		sliders: [
			{
				key: "hosts",
				label: "Infrastructure hosts",
				min: 5,
				max: 500,
				step: 5,
				default: 15,
				unit: "hosts",
			},
			{ key: "apmHosts", label: "APM hosts", min: 0, max: 500, step: 5, default: 10, unit: "hosts" },
			{
				key: "logVolume",
				label: "Log volume",
				min: 10,
				max: 10000,
				step: 50,
				default: 100,
				unit: "GB/mo",
			},
			{ key: "teamSize", label: "Team size", min: 1, max: 200, step: 1, default: 10, unit: "users" },
		],
	},
	grafana: {
		name: "Grafana Cloud",
		sliders: [
			{
				key: "metricSeries",
				label: "Active metric series",
				min: 10,
				max: 2000,
				step: 10,
				default: 50,
				unit: "k series",
			},
			{
				key: "logVolume",
				label: "Log volume",
				min: 10,
				max: 10000,
				step: 50,
				default: 100,
				unit: "GB/mo",
			},
			{
				key: "traceVolume",
				label: "Trace volume",
				min: 10,
				max: 10000,
				step: 50,
				default: 100,
				unit: "GB/mo",
			},
			{ key: "teamSize", label: "Team size", min: 1, max: 200, step: 1, default: 10, unit: "users" },
		],
	},
	"new-relic": {
		name: "New Relic",
		sliders: [
			{
				key: "fullUsers",
				label: "Full platform users",
				min: 1,
				max: 200,
				step: 1,
				default: 10,
				unit: "users",
			},
			{
				key: "dataVolume",
				label: "Total data volume",
				min: 100,
				max: 10000,
				step: 50,
				default: 300,
				unit: "GB/mo",
			},
		],
	},
	dash0: {
		name: "Dash0",
		sliders: [
			{
				key: "spans",
				label: "Spans / mo",
				min: 10,
				max: 5000,
				step: 10,
				default: 100,
				unit: "M",
			},
			{
				key: "logs",
				label: "Log records / mo",
				min: 10,
				max: 5000,
				step: 10,
				default: 100,
				unit: "M",
			},
			{
				key: "metricPoints",
				label: "Metric data points / mo",
				min: 10,
				max: 20000,
				step: 50,
				default: 500,
				unit: "M",
			},
		],
	},
}

function calculateDatadog(values: Record<string, number>) {
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
			{
				label: "Log management",
				value: totalLog,
				detail: `${values.logVolume} GB ingested + indexing`,
			},
		].filter((item) => item.value > 0),
	}
}

function calculateGrafana(values: Record<string, number>) {
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

function calculateNewRelic(values: Record<string, number>) {
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
				detail: onStandard
					? `Standard: $10 first user + ${users - 1} × $99`
					: `Pro: ${users} users × $349/mo (annual)`,
			},
			{ label: "Data ingestion", value: dataOverage, detail: `${values.dataVolume} GB (100 GB free)` },
		],
	}
}

function calculateDash0(values: Record<string, number>) {
	// Dash0 published per-data-point pricing: spans & logs $0.60 per million, metrics $0.20 per million
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

function calculateMaple(values: Record<string, number>, competitor: Competitor) {
	// Maple Startup (autumn.config.ts): $39/mo with 100 GB included per signal
	// (logs, traces, metrics) and $0.30/GB overage billed per signal — the
	// allowances are not a fungible 300 GB pool. Maple meters decoded OTLP
	// payload bytes; where a competitor bills in counts instead of volume, the
	// branch converts using a per-item byte estimate documented at that branch.
	const baseCost = 39
	let logsGB = 0
	let tracesGB = 0
	let metricsGB = 0

	if (competitor === "datadog") {
		// Trace volume from APM hosts is a rough estimate: ~25 GB of spans per
		// host per month (≈10 spans/sec at ~1 KB/span). Real per-host volume
		// varies widely — Datadog's own included allotment is 150 GB/host.
		logsGB = values.logVolume
		tracesGB = values.apmHosts * 25
	} else if (competitor === "grafana") {
		// Grafana bills active series, which assumes 1 data point per minute
		// per series. 1k series × 43,200 min/mo × ~0.1 KB/point ≈ 4.32 GB.
		logsGB = values.logVolume
		tracesGB = values.traceVolume
		metricsGB = values.metricSeries * 4.32
	} else if (competitor === "dash0") {
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
			...(overage > 0
				? [
						{
							label: "Overage",
							value: overage,
							detail: `${Math.round(overageGB)} GB over × $0.30`,
						},
					]
				: []),
			{ label: "Team seats", value: 0, detail: "No per-seat fees" },
		],
	}
}

function Slider({
	config,
	value,
	onChange,
}: {
	config: SliderConfig
	value: number
	onChange: (v: number) => void
}) {
	const pct = ((value - config.min) / (config.max - config.min)) * 100

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-xs text-[oklch(0.65_0.02_60)]">{config.label}</label>
				<span className="text-xs font-mono text-[oklch(0.9_0.02_60)]">
					{config.unit.includes("GB") && value >= 1000
						? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} TB/mo`
						: `${value.toLocaleString()} ${config.unit}`}
				</span>
			</div>
			<div className="relative h-8 flex items-center">
				<div className="absolute inset-x-0 h-[2px] bg-[oklch(0.3_0.02_60)] rounded-full" />
				<div
					className="absolute h-[2px] bg-[oklch(0.75_0.12_70)] rounded-full"
					style={{ width: `${pct}%` }}
				/>
				<input
					type="range"
					min={config.min}
					max={config.max}
					step={config.step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="slider-input absolute inset-x-0 w-full h-8 appearance-none bg-transparent cursor-pointer"
				/>
			</div>
		</div>
	)
}

function formatCurrency(amount: number) {
	if (amount >= 100000) {
		return `$${(amount / 1000).toFixed(0)}k`
	}
	if (amount >= 1000) {
		return `$${(amount / 1000).toFixed(1)}k`
	}
	return `$${Math.round(amount).toLocaleString()}`
}

export function PricingCalculator({ competitor }: { competitor: Competitor }) {
	const config = competitorConfigs[competitor]

	const [values, setValues] = useState<Record<string, number>>(() => {
		const defaults: Record<string, number> = {}
		for (const slider of config.sliders) {
			defaults[slider.key] = slider.default
		}
		return defaults
	})

	const competitorCost = useMemo(() => {
		if (competitor === "datadog") return calculateDatadog(values)
		if (competitor === "grafana") return calculateGrafana(values)
		if (competitor === "dash0") return calculateDash0(values)
		return calculateNewRelic(values)
	}, [competitor, values])

	const mapleCost = useMemo(() => calculateMaple(values, competitor), [values, competitor])

	const savings = competitorCost.total - mapleCost.total
	const savingsPct = competitorCost.total > 0 ? Math.round((savings / competitorCost.total) * 100) : 0

	// A range input fires onChange per tick of the drag, so the event is emitted
	// once the slider settles — one row per adjustment, not one per pixel.
	const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const trackSliderSettled = (key: string, value: number) => {
		if (settleTimer.current) clearTimeout(settleTimer.current)
		settleTimer.current = setTimeout(() => {
			trackLanding("pricing_calculator_changed", { competitor, slider: key, value })
		}, 800)
	}

	return (
		<div>
			{/* Sliders */}
			<div className="border border-[oklch(0.3_0.02_60)] p-6 md:p-8 space-y-5">
				<div className="text-[10px] uppercase tracking-wider text-[oklch(0.5_0.02_60)]">
					Adjust your usage
				</div>
				{config.sliders.map((slider) => (
					<Slider
						key={slider.key}
						config={slider}
						value={values[slider.key]}
						onChange={(v) => {
							setValues((prev) => ({ ...prev, [slider.key]: v }))
							trackSliderSettled(slider.key, v)
						}}
					/>
				))}
			</div>

			{/* Results */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[oklch(0.3_0.02_60)] border border-[oklch(0.3_0.02_60)] mt-px">
				{/* Maple card */}
				<div className="bg-[oklch(0.15_0.02_60)] p-6 md:p-8">
					<div className="flex items-center justify-between mb-4">
						<span className="text-[10px] uppercase tracking-wider text-[oklch(0.75_0.12_70)]">
							Maple
						</span>
						<span className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-[oklch(0.75_0.12_70)]/30 bg-[oklch(0.75_0.12_70)]/10 text-[oklch(0.75_0.12_70)]">
							Recommended
						</span>
					</div>
					<div className="text-3xl md:text-4xl font-bold text-[oklch(0.75_0.12_70)] mb-4">
						{formatCurrency(mapleCost.total)}
						<span className="text-sm font-normal text-[oklch(0.5_0.02_60)]">/mo</span>
					</div>
					<div className="space-y-2">
						{mapleCost.breakdown.map((item) => (
							<div key={item.label} className="flex items-center justify-between text-xs">
								<span className="text-[oklch(0.65_0.02_60)]">{item.label}</span>
								<span className="font-mono text-[oklch(0.9_0.02_60)]">
									{item.value === 0 ? "Free" : `$${Math.round(item.value)}`}
								</span>
							</div>
						))}
					</div>
					<div className="mt-3 space-y-1">
						{mapleCost.breakdown.map((item) => (
							<div key={`${item.label}-d`} className="text-[10px] text-[oklch(0.45_0.02_60)]">
								{item.detail}
							</div>
						))}
					</div>
				</div>

				{/* Competitor card */}
				<div className="bg-[oklch(0.15_0.02_60)] p-6 md:p-8">
					<div className="mb-4">
						<span className="text-[10px] uppercase tracking-wider text-[oklch(0.5_0.02_60)]">
							{config.name}
						</span>
					</div>
					<div className="text-3xl md:text-4xl font-bold text-[oklch(0.9_0.02_60)] mb-4">
						{formatCurrency(competitorCost.total)}
						<span className="text-sm font-normal text-[oklch(0.5_0.02_60)]">/mo</span>
					</div>
					<div className="space-y-2">
						{competitorCost.breakdown.map((item) => (
							<div key={item.label} className="flex items-center justify-between text-xs">
								<span className="text-[oklch(0.65_0.02_60)]">{item.label}</span>
								<span className="font-mono text-[oklch(0.9_0.02_60)]">
									{item.value === 0 ? "Free" : `$${Math.round(item.value)}`}
								</span>
							</div>
						))}
					</div>
					<div className="mt-3 space-y-1">
						{competitorCost.breakdown.map((item) => (
							<div key={`${item.label}-d`} className="text-[10px] text-[oklch(0.45_0.02_60)]">
								{item.detail}
							</div>
						))}
					</div>
				</div>
			</div>

			{/* Savings callout */}
			{savings > 0 && (
				<div className="mt-px border-2 border-[oklch(0.75_0.12_70)]/40 bg-[oklch(0.75_0.12_70)]/10 p-6 md:p-8">
					<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
						<div>
							<div className="text-2xl md:text-3xl font-bold text-[oklch(0.75_0.12_70)]">
								Save {formatCurrency(savings)}/month
							</div>
							<p className="text-sm text-[oklch(0.65_0.02_60)] mt-1">
								That's{" "}
								<span className="font-semibold text-[oklch(0.75_0.12_70)]">
									{savingsPct}% less
								</span>{" "}
								than {config.name} — or{" "}
								<span className="font-semibold text-[oklch(0.75_0.12_70)]">
									{formatCurrency(savings * 12)}/year
								</span>{" "}
								back in your budget.
							</p>
						</div>
						<a
							href="https://app.maple.dev"
							className="shrink-0 bg-[oklch(0.75_0.12_70)] text-[oklch(0.15_0.02_60)] px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
						>
							Start free trial
						</a>
					</div>
				</div>
			)}

			{/* Disclaimer */}
			<p className="mt-4 text-[10px] text-[oklch(0.4_0.02_60)] leading-relaxed">
				Estimates based on published pricing as of August 2026. Actual costs may vary based on
				contract terms, volume discounts, and additional features. Maple pricing based on the Startup
				plan ($39/mo with 100 GB included per signal — logs, traces, metrics — then $0.30/GB, billed
				per signal), metered on uncompressed (decoded OTLP) bytes.
				{competitor === "grafana" &&
					" Grafana bills active series (1 data point per minute per series), so the Maple estimate converts 1k active series to ~4.32 GB/mo assuming ~0.1 KB per decoded metric data point — your real ratio depends on attribute sizes. Grafana log and trace rates model ingest (process + write); retention and query fees are not included."}
				{competitor === "datadog" &&
					" Trace volume is estimated at ~25 GB of spans per APM host per month, and Datadog log indexing assumes ~1 KB per event with ~15% of events indexed; actual volumes depend on request rate and instrumentation density."}
				{competitor === "new-relic" &&
					" New Relic modeled on Standard ($10 first user + $99/user, max 5) up to 5 full platform users and Pro ($349/user/mo, annual commitment) above, with the Original Data option ($0.40/GB beyond 100 GB free); data is assumed to split evenly across logs, traces, and metrics."}
				{competitor === "dash0" &&
					" Dash0 bills per data point (spans & logs $0.60/M, metrics $0.20/M); Maple bills per GB, so the Maple estimate converts at roughly 1 KB per span and log record and 0.1 KB per metric data point. Your real ratio depends on attribute and payload sizes."}
			</p>
		</div>
	)
}

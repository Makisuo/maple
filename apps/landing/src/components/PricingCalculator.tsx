import { useState, useMemo, useRef } from "react"
import { trackLanding } from "../lib/telemetry"
import { APP_SIGN_UP_URL } from "../lib/app-urls"
import {
	estimateMaple,
	estimateVendor,
	formatCurrency,
	formatSliderValue,
	MAPLE_PRICING_NOTE,
	PRICES_VERIFIED,
	vendorCaveat,
	vendorConfigs,
	type SliderConfig,
	type Vendor,
} from "../lib/vendor-pricing"

/**
 * The interactive half of the price comparison. All arithmetic lives in
 * `lib/vendor-pricing.ts` so the server-rendered receipts on `/compare/*`
 * price the reference workload with the same functions this island prices
 * the visitor's sliders with.
 */
export type Competitor = Vendor

/** "August 2026" from the `YYYY-MM` the price sheet carries. */
const PRICES_VERIFIED_LABEL = new Date(`${PRICES_VERIFIED}-15T00:00:00Z`).toLocaleDateString("en-US", {
	month: "long",
	year: "numeric",
	timeZone: "UTC",
})
export const competitorConfigs = vendorConfigs

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
				<label className="text-xs text-fg-muted">{config.label}</label>
				<span className="text-xs font-mono text-fg">{formatSliderValue(config, value)}</span>
			</div>
			<div className="relative h-8 flex items-center">
				<div className="absolute inset-x-0 h-[2px] bg-border rounded-full" />
				<div className="absolute h-[2px] bg-primary rounded-full" style={{ width: `${pct}%` }} />
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

/**
 * `compact` is the /compare/* shape: the receipts above the island already
 * show the reference month line by line, so the live result is one row of
 * totals under the sliders rather than a second pair of cards.
 */
export function PricingCalculator({ competitor, compact = false }: { competitor: Competitor; compact?: boolean }) {
	const config = competitorConfigs[competitor]

	const [values, setValues] = useState<Record<string, number>>(() => {
		const defaults: Record<string, number> = {}
		for (const slider of config.sliders) {
			defaults[slider.key] = slider.default
		}
		return defaults
	})

	const competitorCost = useMemo(() => estimateVendor(competitor, values), [competitor, values])
	const mapleCost = useMemo(() => estimateMaple(competitor, values), [values, competitor])

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

	const sliders = config.sliders.map((slider) => (
		<Slider
			key={slider.key}
			config={slider}
			value={values[slider.key]}
			onChange={(v) => {
				setValues((prev) => ({ ...prev, [slider.key]: v }))
				trackSliderSettled(slider.key, v)
			}}
		/>
	))

	if (compact) {
		return (
			<div className="overflow-hidden rounded-xl border border-border bg-bg-elevated">
				<div className="space-y-5 p-6 md:p-8">{sliders}</div>
				<dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">
					<div className="bg-bg-elevated px-6 py-5 md:px-8">
						<dt className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-primary">Maple</dt>
						<dd className="mt-2 font-mono text-2xl font-medium tabular-nums tracking-[-0.02em] text-primary md:text-3xl">
							{formatCurrency(mapleCost.total)}
							<span className="ml-1 text-xs font-normal text-fg-muted">/mo</span>
						</dd>
					</div>
					<div className="bg-bg-elevated px-6 py-5 md:px-8">
						<dt className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-fg-muted">{config.name}</dt>
						<dd className="mt-2 font-mono text-2xl font-medium tabular-nums tracking-[-0.02em] text-fg md:text-3xl">
							{formatCurrency(competitorCost.total)}
							<span className="ml-1 text-xs font-normal text-fg-muted">/mo</span>
						</dd>
					</div>
					<div className="col-span-2 bg-bg-elevated px-6 py-5 sm:col-span-1 md:px-8">
						<dt className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-fg-muted">Difference</dt>
						<dd className="mt-2 text-[13px] leading-relaxed text-fg">
							{savings >= 0
								? `${formatCurrency(savings)} less per month on Maple`
								: `${formatCurrency(-savings)} more per month on Maple`}
							<span className="block text-fg-muted">
								{formatCurrency(Math.abs(savings) * 12)} a year{savings > 0 ? ` · ${savingsPct}% less` : ""}
							</span>
						</dd>
					</div>
				</dl>
			</div>
		)
	}

	return (
		<div className="overflow-hidden rounded-xl border border-border bg-bg-elevated">
			{/* Sliders */}
			<div className="space-y-5 p-6 md:p-8">
				<div className="text-[10px] uppercase tracking-wider text-fg-muted">Adjust your usage</div>
				{sliders}
			</div>

			{/* Results */}
			<div className="grid grid-cols-1 gap-px border-t border-border bg-border md:grid-cols-2">
				{/* Maple card */}
				<div className="bg-bg-elevated p-6 md:p-8">
					<div className="flex items-center justify-between mb-4">
						<span className="text-[10px] uppercase tracking-wider text-primary">Maple</span>
						<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
							Recommended
						</span>
					</div>
					<div className="mb-4 font-mono text-3xl font-medium tabular-nums tracking-[-0.02em] text-primary md:text-4xl">
						{formatCurrency(mapleCost.total)}
						<span className="text-sm font-normal text-fg-muted">/mo</span>
					</div>
					<div className="space-y-2">
						{mapleCost.breakdown.map((item) => (
							<div key={item.label} className="flex items-center justify-between text-xs">
								<span className="text-fg-muted">{item.label}</span>
								<span className="font-mono text-fg">
									{item.value === 0 ? "Free" : `$${Math.round(item.value)}`}
								</span>
							</div>
						))}
					</div>
					<div className="mt-3 space-y-1">
						{mapleCost.breakdown.map((item) => (
							<div key={`${item.label}-d`} className="text-[10px] text-fg-muted/80">
								{item.detail}
							</div>
						))}
					</div>
				</div>

				{/* Competitor card */}
				<div className="bg-bg-elevated p-6 md:p-8">
					<div className="mb-4">
						<span className="text-[10px] uppercase tracking-wider text-fg-muted">
							{config.name}
						</span>
					</div>
					<div className="mb-4 font-mono text-3xl font-medium tabular-nums tracking-[-0.02em] text-fg md:text-4xl">
						{formatCurrency(competitorCost.total)}
						<span className="text-sm font-normal text-fg-muted">/mo</span>
					</div>
					<div className="space-y-2">
						{competitorCost.breakdown.map((item) => (
							<div key={item.label} className="flex items-center justify-between text-xs">
								<span className="text-fg-muted">{item.label}</span>
								<span className="font-mono text-fg">
									{item.value === 0 ? "Free" : `$${Math.round(item.value)}`}
								</span>
							</div>
						))}
					</div>
					<div className="mt-3 space-y-1">
						{competitorCost.breakdown.map((item) => (
							<div key={`${item.label}-d`} className="text-[10px] text-fg-muted/80">
								{item.detail}
							</div>
						))}
					</div>
				</div>
			</div>

			{/* Savings callout */}
			{savings > 0 && (
				<div className="border-t border-border bg-primary/[0.06] p-6 md:p-8">
					<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
						<div>
							<div className="font-mono text-2xl font-medium tabular-nums tracking-[-0.02em] text-primary md:text-3xl">
								Save {formatCurrency(savings)}/month
							</div>
							<p className="text-sm text-fg-muted mt-1">
								That's <span className="font-semibold text-primary">{savingsPct}% less</span>{" "}
								than {config.name} — or{" "}
								<span className="font-semibold text-primary">
									{formatCurrency(savings * 12)}/year
								</span>{" "}
								back in your budget.
							</p>
						</div>
						<a
							href={APP_SIGN_UP_URL}
							className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
						>
							Start free trial
						</a>
					</div>
				</div>
			)}

			{/* Disclaimer */}
			<p className="px-6 pb-6 pt-4 text-[10px] leading-relaxed text-fg-muted/80 md:px-8">
				Estimates based on published pricing as of {PRICES_VERIFIED_LABEL}. Actual costs may vary based on
				contract terms, volume discounts, and additional features. {MAPLE_PRICING_NOTE}{" "}
				{vendorCaveat[competitor]}
			</p>
		</div>
	)
}

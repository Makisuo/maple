import { useState, useMemo } from "react"

type Competitor = "datadog" | "grafana" | "new-relic"

interface SliderConfig {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  unit: string
}

const competitorConfigs: Record<
  Competitor,
  { name: string; sliders: SliderConfig[] }
> = {
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
}

function calculateDatadog(values: Record<string, number>) {
  const infraCost = values.hosts * 15
  const apmCost = values.apmHosts * 31
  // Assume ~10 million log events indexed for the log volume
  const logIngestion = values.logVolume * 0.10
  const logIndexing = (values.logVolume * 0.15) * 1.70 // ~0.15M events per GB indexed
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

function calculateGrafana(values: Record<string, number>) {
  const platformFee = 19
  const metricSeriesK = values.metricSeries
  const metricsOverage = Math.max(0, metricSeriesK - 10) * 6.50
  const logsOverage = Math.max(0, values.logVolume - 50) * 0.50
  const tracesOverage = Math.max(0, values.traceVolume - 50) * 0.50
  const userCost = values.teamSize * 8

  return {
    total: platformFee + metricsOverage + logsOverage + tracesOverage + userCost,
    breakdown: [
      { label: "Platform fee", value: platformFee, detail: "Base plan" },
      { label: "Metrics", value: metricsOverage, detail: `${metricSeriesK}k series (10k free)` },
      { label: "Logs", value: logsOverage, detail: `${values.logVolume} GB (50 GB free)` },
      { label: "Traces", value: tracesOverage, detail: `${values.traceVolume} GB (50 GB free)` },
      { label: "Users", value: userCost, detail: `${values.teamSize} users × $8` },
    ],
  }
}

function calculateNewRelic(values: Record<string, number>) {
  // Pro plan: $349/user/year ≈ $29.08/user/month for annual billing
  const userCost = values.fullUsers * 29.08
  const dataOverage = Math.max(0, values.dataVolume - 100) * 0.30

  return {
    total: userCost + dataOverage,
    breakdown: [
      { label: "Full platform users", value: userCost, detail: `${values.fullUsers} users × $29/mo (annual)` },
      { label: "Data ingestion", value: dataOverage, detail: `${values.dataVolume} GB (100 GB free)` },
    ],
  }
}

function calculateMaple(values: Record<string, number>, competitor: Competitor) {
  const baseCost = 39
  let totalDataGB: number

  if (competitor === "datadog") {
    // Estimate total data from log volume + trace equivalents from APM hosts
    totalDataGB = values.logVolume + values.apmHosts * 5 // ~5 GB traces per APM host
  } else if (competitor === "grafana") {
    totalDataGB = values.logVolume + values.traceVolume + (values.metricSeries * 0.1) // rough metrics GB
  } else {
    totalDataGB = values.dataVolume
  }

  // Maple: 100 GB each for logs, traces, metrics = 300 GB total included
  // Simplify: $0.25/GB overage beyond 300 GB total
  const overage = Math.max(0, totalDataGB - 300) * 0.25

  return {
    total: baseCost + overage,
    breakdown: [
      { label: "Startup plan", value: baseCost, detail: "300 GB included" },
      ...(overage > 0
        ? [{ label: "Overage", value: overage, detail: `${Math.round(totalDataGB - 300)} GB × $0.25` }]
        : []),
      { label: "Team seats", value: 0, detail: "Unlimited — always free" },
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
    return calculateNewRelic(values)
  }, [competitor, values])

  const mapleCost = useMemo(() => calculateMaple(values, competitor), [values, competitor])

  const savings = competitorCost.total - mapleCost.total
  const savingsPct = competitorCost.total > 0 ? Math.round((savings / competitorCost.total) * 100) : 0

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
            onChange={(v) => setValues((prev) => ({ ...prev, [slider.key]: v }))}
          />
        ))}
      </div>

      {/* Results */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[oklch(0.3_0.02_60)] border border-[oklch(0.3_0.02_60)] mt-px">
        {/* Maple card */}
        <div className="bg-[oklch(0.15_0.02_60)] p-6 md:p-8">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] uppercase tracking-wider text-[oklch(0.75_0.12_70)]">Maple</span>
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
            {mapleCost.breakdown.map((item) => (
              <div key={`${item.label}-detail`} className="hidden" />
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
                That's <span className="font-semibold text-[oklch(0.75_0.12_70)]">{savingsPct}% less</span> than {config.name} — or <span className="font-semibold text-[oklch(0.75_0.12_70)]">{formatCurrency(savings * 12)}/year</span> back in your budget.
              </p>
            </div>
            <a
              href="https://app.maple.dev"
              className="shrink-0 bg-[oklch(0.75_0.12_70)] text-[oklch(0.15_0.02_60)] px-6 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Get started free
            </a>
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <p className="mt-4 text-[10px] text-[oklch(0.4_0.02_60)] leading-relaxed">
        Estimates based on published pricing as of 2025. Actual costs may vary based on contract terms, volume discounts, and additional features.
        Maple pricing based on the Startup plan ($29/mo with 300 GB total included data).
      </p>
    </div>
  )
}

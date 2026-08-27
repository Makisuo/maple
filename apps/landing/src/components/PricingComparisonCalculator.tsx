import { useState } from "react"
import { competitorConfigs, PricingCalculator, type Competitor } from "./PricingCalculator"

const COMPETITORS: Competitor[] = ["datadog", "grafana", "new-relic", "dash0", "openobserve"]

/**
 * Wraps PricingCalculator with a competitor switcher so the /pricing page can
 * compare Maple against any vendor. The inner calculator is remounted via `key`
 * on each switch so its slider state re-seeds to the selected competitor's
 * defaults (its useState initializer runs once per mount).
 */
export function PricingComparisonCalculator() {
	const [competitor, setCompetitor] = useState<Competitor>("datadog")

	return (
		<div>
			<div className="mb-px flex flex-wrap items-center gap-x-4 gap-y-2 border border-[oklch(0.3_0.02_60)] px-4 py-3">
				<span className="text-[10px] uppercase tracking-wider text-[oklch(0.5_0.02_60)]">
					Compare against
				</span>
				<div role="tablist" aria-label="Compare against" className="inline-flex flex-wrap gap-1">
					{COMPETITORS.map((c) => {
						const active = c === competitor
						return (
							<button
								key={c}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => setCompetitor(c)}
								className={`px-3 py-1.5 text-xs font-medium transition-colors ${
									active
										? "bg-[oklch(0.75_0.12_70)] text-[oklch(0.15_0.02_60)]"
										: "border border-[oklch(0.3_0.02_60)] text-[oklch(0.65_0.02_60)] hover:border-[oklch(0.45_0.02_60)] hover:text-[oklch(0.9_0.02_60)]"
								}`}
							>
								{competitorConfigs[c].name}
							</button>
						)
					})}
				</div>
			</div>
			<PricingCalculator key={competitor} competitor={competitor} />
		</div>
	)
}

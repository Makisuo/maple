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
			<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="text-[10px] uppercase tracking-wider text-fg-muted">Compare against</span>
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
								className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors ${
									active
										? "bg-primary text-primary-foreground"
										: "border border-border bg-bg text-fg-muted hover:bg-bg-elevated hover:text-fg"
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

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"

import { formatCurrency } from "@/lib/billing/currency"
import { featureUnit, FEATURE_COLORS, type SpendModel } from "@/lib/billing/spend"
import { formatCount, formatUsage } from "@/lib/billing/usage"

/**
 * The four numbers that answer "what is this cycle costing me?" before the
 * reader touches a chart: spend so far, where it lands, the ceiling it's headed
 * for, and which signal is driving it.
 *
 * Deliberately four cards and not a chart summary — this row is what a customer
 * screenshots into a finance thread.
 */

function KpiCard({
	label,
	children,
	className,
}: {
	label: string
	children: React.ReactNode
	className?: string
}) {
	return (
		<div className={cn("border border-border/60 bg-card/40 p-4", className)}>
			<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
				{label}
			</span>
			<div className="mt-2">{children}</div>
		</div>
	)
}

const dollars = (cents: number, currency: string) => formatCurrency(cents / 100, currency)

export function BillingKpisSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<div key={i} className="border border-border/60 bg-card/40 p-4">
					<Skeleton className="h-2.5 w-20" />
					<Skeleton className="mt-3 h-7 w-28" />
					<Skeleton className="mt-3 h-3 w-36" />
				</div>
			))}
		</div>
	)
}

export function BillingKpis({
	model,
	limitCents,
	pausedAt,
}: {
	model: SpendModel
	/** Configured monthly ceiling, or null when the org has none. */
	limitCents: number | null
	/** Set when ingest is currently paused by that ceiling. */
	pausedAt: number | null
}) {
	const percentUsed = limitCents !== null && limitCents > 0 ? (model.spendCents / limitCents) * 100 : null
	const driver = model.topDriver

	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
			<KpiCard label="Spend so far">
				<p className="font-mono text-2xl tabular-nums">{dollars(model.spendCents, model.currency)}</p>
				<p className="mt-2 text-[11px] leading-snug text-muted-foreground">
					Day {model.dayOfCycle} of {model.cycleDays} · {dollars(model.baseCents, model.currency)}{" "}
					base + {dollars(model.overageCents, model.currency)} overage
					{model.partial && " · some legacy items aren't itemized"}
				</p>
			</KpiCard>

			<KpiCard label="Projected bill">
				<p className="font-mono text-2xl tabular-nums text-primary">
					{dollars(model.projectedCents, model.currency)}
				</p>
				<p className="mt-2 text-[11px] text-muted-foreground">At the current pace</p>
			</KpiCard>

			<KpiCard label="Spend limit">
				{limitCents === null ? (
					<>
						<p className="font-mono text-2xl tabular-nums text-muted-foreground">None</p>
						<p className="mt-2 text-[11px] text-muted-foreground">
							Set one below to get alerts before the bill grows
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline gap-2">
							<p className="font-mono text-2xl tabular-nums">
								{dollars(limitCents, model.currency)}
							</p>
							{percentUsed !== null && (
								<span
									className={cn(
										"text-[11px] tabular-nums",
										percentUsed >= 100
											? "text-severity-error"
											: percentUsed >= 80
												? "text-severity-warn"
												: "text-muted-foreground",
									)}
								>
									{Math.round(percentUsed)}% used
								</span>
							)}
						</div>
						{/* The bar is the point of this card: a number alone doesn't say
						    "close". Overage past the ceiling clamps at full width and turns
						    error-colored rather than overflowing the track. */}
						<div className="mt-3 h-1 w-full bg-muted">
							<div
								className={cn(
									"h-full",
									percentUsed !== null && percentUsed >= 100
										? "bg-severity-error"
										: percentUsed !== null && percentUsed >= 80
											? "bg-severity-warn"
											: "bg-severity-info",
								)}
								style={{ width: `${Math.min(100, percentUsed ?? 0)}%` }}
							/>
						</div>
						{pausedAt !== null && (
							<p className="mt-2 text-[11px] text-severity-error">Ingest paused at this limit</p>
						)}
					</>
				)}
			</KpiCard>

			<KpiCard label="Top cost driver">
				{driver === null ? (
					<>
						<p className="text-lg">Within included</p>
						<p className="mt-2 text-[11px] text-muted-foreground">
							No feature is over its allotment this cycle
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline gap-2">
							<span
								aria-hidden
								className="size-2 shrink-0 rounded-full"
								style={{ background: FEATURE_COLORS[driver.featureId] }}
							/>
							<span className="text-lg">{driver.label}</span>
							<span className="font-mono text-sm tabular-nums text-muted-foreground">
								{dollars(driver.overageCents, model.currency)}
							</span>
						</div>
						<p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
							{model.overageCents > 0
								? `${Math.round((driver.overageCents / model.overageCents) * 100)}% of overage · `
								: ""}
							{featureUnit(driver.featureId) === "GB"
								? formatUsage(driver.overageUnits)
								: formatCount(driver.overageUnits)}{" "}
							over included
						</p>
					</>
				)}
			</KpiCard>
		</div>
	)
}

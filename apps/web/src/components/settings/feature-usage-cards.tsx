import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { formatCurrency } from "@/lib/billing/currency"
import {
	featureUnit,
	FEATURE_COLORS,
	formatRateLabel,
	SPEND_FEATURES,
	type FeatureSpend,
	type SpendModel,
} from "@/lib/billing/spend"
import { formatCount, formatUsage } from "@/lib/billing/usage"

/**
 * One card per billable signal: how much was ingested, how much of it was
 * included, what the excess costs, and whether a cap is holding it back.
 *
 * These sit above the spend chart on purpose — they are the five things the
 * customer is billed for, and the chart is only their sum over time.
 */

const formatVolume = (featureId: string, value: number) =>
	featureUnit(featureId) === "GB" ? formatUsage(value) : formatCount(value)

export function FeatureUsageCardsSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
			{Array.from({ length: SPEND_FEATURES.length }).map((_, i) => (
				<div key={i} className="border border-border/60 bg-card/40 p-4">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="mt-3 h-6 w-32" />
					<Skeleton className="mt-3 h-1 w-full" />
					<Skeleton className="mt-4 h-3 w-28" />
				</div>
			))}
		</div>
	)
}

function FeatureCard({
	feature,
	currency,
	overageCap,
}: {
	feature: FeatureSpend
	currency: string
	/** Autumn-native paid overage cap, beyond the included allowance. */
	overageCap: number | null
}) {
	const color = FEATURE_COLORS[feature.featureId]
	const included = feature.unlimited ? null : feature.included
	// The meter shows an honest included-vs-overage split normalized to usage, so
	// a card whose usage is mostly overage reads that way at a glance.
	const includedFraction =
		included === null || feature.used <= 0 ? 100 : Math.min(100, (included / feature.used) * 100)
	// A hard-capped feature is rejected past its allotment rather than billed, so
	// it must never read as pending overage — that is the whole difference between
	// "you will be charged for this" and "we stopped accepting it".
	const hardCapped = feature.overageAllowed === false && !feature.unlimited
	const hasOverage = feature.overageUnits > 0 && !hardCapped
	const nativeCapReached = overageCap !== null && feature.overageUnits >= overageCap

	return (
		// Fixed-height slots for the title and the headline, so the meter and the
		// footer form one horizontal lane across all five cards. Height, not
		// nowrap: "Browser Sessions" is allowed to wrap to two lines (truncating it
		// to "Browse…" is worse), the slot just reserves the room whether it wraps
		// or not — so a one-word card doesn't pull its meter up.
		<div className="flex h-full flex-col border border-border/60 bg-card/40 p-4">
			<div className="flex h-9 items-start justify-between gap-2">
				<div className="flex min-w-0 items-start gap-2">
					<span
						aria-hidden
						className="mt-1.5 size-2 shrink-0 rounded-full"
						style={{ background: color }}
					/>
					<span className="line-clamp-2 text-sm leading-[18px]">{feature.label}</span>
				</div>
				{overageCap === null ? (
					<span className="shrink-0 border border-border/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
						NO CAP
					</span>
				) : (
					<span
						className={cn(
							"shrink-0 border px-1.5 py-0.5 font-mono text-[10px] leading-none",
							nativeCapReached
								? "border-severity-error/50 text-severity-error"
								: "border-primary/40 text-primary",
						)}
					>
						{nativeCapReached
							? "CAP REACHED"
							: `+${formatVolume(feature.featureId, overageCap)} CAP`}
					</span>
				)}
			</div>

			{/* Value and allotment stack rather than sit inline: at card width the
			    inline pair wraps for some units and not others, which is exactly what
			    knocks the meters out of alignment. */}
			<div className="mt-2 flex h-11 flex-col justify-start">
				<span className="font-mono text-xl leading-6 tabular-nums">
					{formatVolume(feature.featureId, feature.used)}
				</span>
				<span className="truncate text-[11px] leading-4 text-muted-foreground">
					{feature.unlimited
						? "unlimited"
						: included === null
							? // No allotment AND no rate means the plan doesn't carry this
								// feature at all — say that, rather than implying a zero quota.
								feature.ratePerUnit === null
								? "not on your plan"
								: "no allotment"
							: `of ${formatVolume(feature.featureId, included)} included`}
				</span>
			</div>

			<div className="mt-2 flex h-1 w-full shrink-0 gap-px bg-muted">
				<div style={{ width: `${includedFraction}%`, background: color }} />
				{hasOverage && <div className="flex-1 bg-primary" />}
			</div>

			<div className="mt-auto flex items-baseline justify-between gap-2 pt-4 text-[11px]">
				<span className="text-muted-foreground">
					{hasOverage ? (
						<>
							Overage{" "}
							<span className="font-mono tabular-nums text-foreground">
								{formatCurrency(feature.overageCents / 100, currency)}
							</span>
						</>
					) : hardCapped && feature.overageUnits > 0 ? (
						<span className="text-severity-warn">Over cap · rejected</span>
					) : (
						"No overage"
					)}
				</span>
				<span className="font-mono tabular-nums text-muted-foreground/70">
					{hardCapped ? "hard cap" : (formatRateLabel(feature) ?? "—")}
				</span>
			</div>
		</div>
	)
}

export function FeatureUsageCards({
	model,
	overageCaps,
}: {
	model: SpendModel
	overageCaps: Readonly<Record<string, number | null>>
}) {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
			{model.features.map((feature) => (
				<FeatureCard
					key={feature.featureId}
					feature={feature}
					currency={model.currency}
					overageCap={overageCaps[feature.featureId] ?? null}
				/>
			))}
		</div>
	)
}

import { useMemo, type ReactNode } from "react"
import { format } from "date-fns"
import type { BillingCustomer } from "@maple/domain/http"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/utils"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	billingCustomerAtom,
	billingPlansAtom,
	billingUsageAtom,
} from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { getLegacyPlanInfo, getTrialStatus, type TrialStatus } from "@/lib/billing/plan-gating"
import { getPlanLimits, type PlanLimits } from "@/lib/billing/plans"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { estimateCycleCost } from "@/lib/billing/cost-estimate"
import { UsageMeters } from "./usage-meters"
import { PricingCards } from "./pricing-cards"
import { CostBreakdown, CostBreakdownSkeleton } from "./cost-breakdown"
import { InvoicesSection } from "./invoices-section"

function limitsFromCustomer(balances: BillingCustomer["balances"]): PlanLimits | null {
	if (!balances) return null
	const defaults = getPlanLimits("starter")
	return {
		logsGB: balances.logs?.granted ?? defaults.logsGB,
		tracesGB: balances.traces?.granted ?? defaults.tracesGB,
		metricsGB: balances.metrics?.granted ?? defaults.metricsGB,
		retentionDays: balances.retention_days?.remaining ?? defaults.retentionDays,
		browserSessions: balances.browser_sessions?.granted ?? defaults.browserSessions,
	}
}

function DataPoint({
	label,
	value,
	accent,
	className,
	trailing,
}: {
	label: string
	value: string
	accent?: boolean
	className?: string
	/** Rendered inline with the value, on its baseline (e.g. a status badge). */
	trailing?: ReactNode
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
				{label}
			</span>
			<span className="flex items-center gap-2">
				<span className={cn("text-sm tabular-nums", accent && "text-primary", className)}>
					{value}
				</span>
				{trailing}
			</span>
		</div>
	)
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
			<h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
				{title}
			</h2>
			{subtitle && <span className="text-xs tabular-nums text-muted-foreground/60">{subtitle}</span>}
		</div>
	)
}

function SubscriptionStrip({
	trial,
	isLegacy,
	billingPeriodLabel,
	isLoading,
	onManageBilling,
}: {
	trial: TrialStatus
	isLegacy: boolean
	billingPeriodLabel: string
	isLoading: boolean
	onManageBilling: () => void
}) {
	if (isLoading) {
		return (
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
				<div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-10" />
						<Skeleton className="h-4 w-20" />
					</div>
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-12" />
						<Skeleton className="h-4 w-24" />
					</div>
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-2.5 w-12" />
						<Skeleton className="h-4 w-32" />
					</div>
				</div>
				<Skeleton className="h-8 w-32" />
			</div>
		)
	}

	const { isTrialing, daysRemaining, trialEndsAt, planName, planStatus } = trial
	if (!planStatus || !planName) return null

	const statusValue = isTrialing && daysRemaining != null ? `Trial · ${daysRemaining}d left` : "Active"

	return (
		<div>
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
				<div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
					<DataPoint
						label="Plan"
						value={planName}
						className="capitalize"
						trailing={
							isLegacy ? (
								<Badge size="sm" variant="warning">
									Legacy
								</Badge>
							) : undefined
						}
					/>
					<DataPoint label="Status" value={statusValue} accent={isTrialing} />
					<DataPoint label="Period" value={billingPeriodLabel} />
				</div>
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Manage billing
				</Button>
			</div>
			{isLegacy && (
				<p className="mt-3 text-xs text-muted-foreground">
					You're on a legacy plan that's no longer offered. Switch to a current plan below for the
					latest pricing and features.
				</p>
			)}
			{isTrialing && trialEndsAt && (
				<p className="mt-3 text-xs text-muted-foreground">
					Card charges when trial ends on {format(trialEndsAt, "MMM d")}. Cancel anytime before to
					avoid charges.
				</p>
			)}
		</div>
	)
}

function UsageSkeleton() {
	return (
		<div className="space-y-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<div key={i} className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Skeleton className="h-3 w-3 rounded-sm" />
						<Skeleton className="h-3 w-16" />
						<Skeleton className="ml-auto h-3 w-24" />
					</div>
					<Skeleton className="h-1.5 w-full" />
				</div>
			))}
		</div>
	)
}

export function BillingSection() {
	const customerResult = useAtomValue(billingCustomerAtom)
	const plansResult = useAtomValue(billingPlansAtom)
	const usageResult = useAtomValue(billingUsageAtom)
	const { openCustomerPortal } = useBillingActions()

	const customer = Result.isSuccess(customerResult) ? customerResult.value : undefined
	const plans = Result.isSuccess(plansResult) ? plansResult.value.plans : undefined
	const usageTotal = Result.isSuccess(usageResult) ? usageResult.value.total : undefined

	const isLoading = Result.isInitial(customerResult) || Result.isInitial(usageResult)
	// The estimate also needs the plan catalog (for base price + overage rates);
	// without it a legacy-looking partial estimate would flash during load.
	const isCostLoading = isLoading || Result.isInitial(plansResult)

	const trial = getTrialStatus(customer)
	const { isLegacy } = getLegacyPlanInfo(customer, plans)

	const billingPeriodLabel = useMemo(() => {
		const activeSub = customer?.subscriptions?.find((s) => s.status === "active")
		if (activeSub?.currentPeriodStart && activeSub?.currentPeriodEnd) {
			const start = new Date(activeSub.currentPeriodStart)
			const end = new Date(activeSub.currentPeriodEnd)
			return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`
		}
		const now = new Date()
		const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
		return `${format(startOfMonth, "MMM d")} – ${format(now, "MMM d, yyyy")}`
	}, [customer])

	const costEstimate = useMemo(
		() => estimateCycleCost({ customer, plans, usage: usageTotal }),
		[customer, plans, usageTotal],
	)

	const limits = limitsFromCustomer(customer?.balances) ?? getPlanLimits("starter")
	const usage: AggregatedUsage = {
		logsGB: usageTotal?.logs?.sum ?? 0,
		tracesGB: usageTotal?.traces?.sum ?? 0,
		metricsGB: usageTotal?.metrics?.sum ?? 0,
		browserSessions: usageTotal?.browser_sessions?.sum ?? 0,
	}

	return (
		<div>
			<SubscriptionStrip
				trial={trial}
				isLegacy={isLegacy}
				billingPeriodLabel={billingPeriodLabel}
				isLoading={Result.isInitial(customerResult)}
				onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
			/>

			<section className="mt-10">
				<SectionHeader title="Current usage" subtitle={billingPeriodLabel} />
				<div className="mt-5">
					{isLoading ? <UsageSkeleton /> : <UsageMeters usage={usage} limits={limits} />}
				</div>
			</section>

			{(isCostLoading || costEstimate !== null) && (
				<section className="mt-12">
					<SectionHeader title="Estimated costs" subtitle={billingPeriodLabel} />
					<div className="mt-3">
						{isCostLoading || !costEstimate ? (
							<CostBreakdownSkeleton />
						) : (
							<CostBreakdown estimate={costEstimate} />
						)}
					</div>
				</section>
			)}

			<section className="mt-12">
				<SectionHeader title="Plans" />
				<div className="mt-5">
					<PricingCards />
				</div>
			</section>

			<section className="mt-12">
				<SectionHeader title="Invoices" />
				<div className="mt-3">
					<InvoicesSection
						onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
					/>
				</div>
			</section>
		</div>
	)
}

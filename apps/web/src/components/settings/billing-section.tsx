import { useMemo, type ReactNode } from "react"
import { format } from "date-fns"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	billingCustomerAtom,
	billingDailySpendAtom,
	billingPlansAtom,
	billingUsageAtom,
} from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { getLegacyPlanInfo, getTrialStatus, type TrialStatus } from "@/lib/billing/plan-gating"
import { buildSpendModel } from "@/lib/billing/spend"
import { estimateCycleCost } from "@/lib/billing/cost-estimate"
import { maximumInvoiceCents, spendLimitFor } from "@/lib/billing/controls"
import { BillingKpis, BillingKpisSkeleton } from "./billing-kpis"
import { FeatureUsageCards, FeatureUsageCardsSkeleton } from "./feature-usage-cards"
import { SpendChart, SpendChartSkeleton } from "./spend-chart"
import { BillingControlsCard, BillingControlsCardSkeleton } from "./billing-controls-card"
import { PlanOffer } from "./plan-offer"
import { CostBreakdown, CostBreakdownSkeleton } from "./cost-breakdown"
import { InvoicesSection } from "./invoices-section"
import { BillingDetailsSection } from "./billing-details-section"

/**
 * Billing, spend-first.
 *
 * Reading order matches the question a customer actually arrives with: what am I
 * on → what is this cycle costing → which signals are driving it → how it accrues
 * → what stops it → the itemized proof → what plan options exist. The four
 * feature cards sit ABOVE the chart deliberately: they are the things being
 * billed, and the chart is only their sum over time.
 */

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

export function BillingSection({ isAdmin = true }: { isAdmin?: boolean }) {
	const customerResult = useAtomValue(billingCustomerAtom)
	const plansResult = useAtomValue(billingPlansAtom)
	const usageResult = useAtomValue(billingUsageAtom)
	const dailySpendResult = useAtomValue(billingDailySpendAtom)
	const { openCustomerPortal } = useBillingActions()

	const customer = Result.isSuccess(customerResult) ? customerResult.value : undefined
	const plans = Result.isSuccess(plansResult) ? plansResult.value.plans : undefined
	const usageTotal = Result.isSuccess(usageResult) ? usageResult.value.total : undefined
	const daily = Result.isSuccess(dailySpendResult) ? dailySpendResult.value : undefined

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

	// One spend model feeds the KPI row, the feature cards, and the chart, so the
	// three can't disagree about what this cycle costs.
	const model = useMemo(
		() => buildSpendModel({ customer, plans, usage: usageTotal, nowMs: Date.now() }),
		[customer, plans, usageTotal],
	)
	const maximumInvoice = maximumInvoiceCents(model, customer)
	const overageCaps = Object.fromEntries(
		(model?.features ?? []).map((feature) => [
			feature.featureId,
			spendLimitFor(customer, feature.featureId)?.overageLimit ?? null,
		]),
	)

	return (
		<div>
			<SubscriptionStrip
				trial={trial}
				isLegacy={isLegacy}
				billingPeriodLabel={billingPeriodLabel}
				isLoading={Result.isInitial(customerResult)}
				onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
			/>

			<section className="mt-8">
				{isLoading || model === null ? (
					<BillingKpisSkeleton />
				) : (
					<BillingKpis model={model} maximumInvoiceCents={maximumInvoice} />
				)}
			</section>

			<section className="mt-10">
				<SectionHeader title="Usage by feature" subtitle={billingPeriodLabel} />
				<div className="mt-4">
					{isLoading || model === null ? (
						<FeatureUsageCardsSkeleton />
					) : (
						<FeatureUsageCards model={model} overageCaps={overageCaps} />
					)}
				</div>
			</section>

			<section className="mt-10">
				{isLoading || model === null || Result.isInitial(dailySpendResult) ? (
					<SpendChartSkeleton />
				) : (
					<SpendChart model={model} daily={daily} />
				)}
			</section>

			<section className="mt-12">
				<SectionHeader
					title="Billing controls"
					subtitle="Stored and enforced by Autumn per feature"
				/>
				<div className="mt-4">
					{customer === undefined ? (
						<BillingControlsCardSkeleton />
					) : (
						<BillingControlsCard customer={customer} model={model} canEdit={isAdmin} />
					)}
				</div>
			</section>

			<section className="mt-12">
				<SectionHeader title="Billing details" subtitle="Printed on every invoice" />
				<div className="mt-4">
					<BillingDetailsSection canEdit={isAdmin} />
				</div>
			</section>

			<div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-2">
				{(isCostLoading || costEstimate !== null) && (
					<section>
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

				<section>
					<SectionHeader title="Invoices" />
					<div className="mt-3">
						<InvoicesSection
							onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
						/>
					</div>
				</section>
			</div>

			<section className="mt-12">
				<SectionHeader title="Plans" subtitle="Need higher volume or custom retention?" />
				<div className="mt-4">
					<PlanOffer
						model={model}
						onManageBilling={() => openCustomerPortal({ returnUrl: window.location.href })}
					/>
				</div>
			</section>
		</div>
	)
}

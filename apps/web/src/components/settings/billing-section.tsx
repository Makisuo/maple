import { useMemo } from "react"
import { useCustomer, useAggregateEvents } from "autumn-js/react"
import { PricingCards } from "./pricing-cards"
import { format } from "date-fns"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { getPlanLimits, type PlanLimits } from "@/lib/billing/plans"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { UsageMeters } from "./usage-meters"
import { useTrialStatus } from "@/hooks/use-trial-status"
import { cn } from "@maple/ui/utils"

type CustomerBalances = Record<string, { usage?: number; granted?: number; remaining?: number }> | undefined

function limitsFromCustomer(balances: CustomerBalances): PlanLimits | null {
	if (!balances) return null
	const defaults = getPlanLimits("starter")
	return {
		logsGB: balances.logs?.granted ?? defaults.logsGB,
		tracesGB: balances.traces?.granted ?? defaults.tracesGB,
		metricsGB: balances.metrics?.granted ?? defaults.metricsGB,
		retentionDays: balances.retention_days?.remaining ?? defaults.retentionDays,
	}
}

function DataPoint({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
				{label}
			</span>
			<span className={cn("text-sm tabular-nums", accent && "text-primary")}>{value}</span>
		</div>
	)
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
			<h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
				{title}
			</h2>
			{subtitle && (
				<span className="text-xs tabular-nums text-muted-foreground/60">{subtitle}</span>
			)}
		</div>
	)
}

function SubscriptionStrip({ billingPeriodLabel }: { billingPeriodLabel: string }) {
	const { isTrialing, daysRemaining, trialEndsAt, planName, planStatus, isLoading } = useTrialStatus()
	const { openCustomerPortal } = useCustomer()

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

	if (!planStatus) return null

	const statusValue =
		isTrialing && daysRemaining != null ? `Trial · ${daysRemaining}d left` : "Active"

	return (
		<div>
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
				<div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
					<DataPoint label="Plan" value={planName} />
					<DataPoint label="Status" value={statusValue} accent={isTrialing} />
					<DataPoint label="Period" value={billingPeriodLabel} />
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => openCustomerPortal({ returnUrl: window.location.href })}
				>
					Manage billing
				</Button>
			</div>
			{isTrialing && trialEndsAt && (
				<p className="mt-3 text-xs text-muted-foreground">
					Card charges when trial ends on {format(trialEndsAt, "MMM d")}. Cancel anytime before to avoid charges.
				</p>
			)}
		</div>
	)
}

function UsageSkeleton() {
	return (
		<div className="space-y-4">
			{Array.from({ length: 3 }).map((_, i) => (
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
	const { data: customer, isLoading: isCustomerLoading } = useCustomer()
	const { total, isLoading: isUsageLoading } = useAggregateEvents({
		featureId: ["logs", "traces", "metrics"],
		range: "1bc",
	})

	const isLoading = isCustomerLoading || isUsageLoading

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

	const limits = limitsFromCustomer(customer?.balances) ?? getPlanLimits("starter")
	const usage: AggregatedUsage = {
		logsGB: total?.logs?.sum ?? 0,
		tracesGB: total?.traces?.sum ?? 0,
		metricsGB: total?.metrics?.sum ?? 0,
	}

	return (
		<div>
			<SubscriptionStrip billingPeriodLabel={billingPeriodLabel} />

			<section className="mt-10">
				<SectionHeader title="Current usage" subtitle={billingPeriodLabel} />
				<div className="mt-5">
					{isLoading ? <UsageSkeleton /> : <UsageMeters usage={usage} limits={limits} />}
				</div>
			</section>

			<section className="mt-12">
				<SectionHeader title="Plans" />
				<div className="mt-5">
					<PricingCards />
				</div>
			</section>
		</div>
	)
}

import { useMemo } from "react"
import { useCustomer, useAggregateEvents } from "autumn-js/react"
import { PricingCards } from "./pricing-cards"
import { format } from "date-fns"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { getPlanLimits, type PlanLimits } from "@/lib/billing/plans"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { UsageMeters } from "./usage-meters"
import { useTrialStatus } from "@/hooks/use-trial-status"
import { ClockIcon } from "@/components/icons"

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

function CurrentPlanCard() {
  const { isTrialing, daysRemaining, trialEndsAt, planName, planStatus, isLoading } = useTrialStatus()
  const { openCustomerPortal } = useCustomer()

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
      </Card>
    )
  }

  if (!planStatus) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm font-medium">{planName}</CardTitle>
          {isTrialing && (
            <Badge variant="secondary" className="text-[10px] font-medium">
              Free Trial
            </Badge>
          )}
        </div>
        {isTrialing && daysRemaining != null && trialEndsAt ? (
          <CardDescription className="space-y-1">
            <span className="flex items-center gap-1.5 text-sm">
              <ClockIcon size={14} className="text-muted-foreground" />
              {daysRemaining} days remaining · ends {format(trialEndsAt, "MMM d")}
            </span>
            <span className="block text-xs text-muted-foreground">
              Your card will be charged when the trial ends. Cancel anytime before to avoid charges.
            </span>
          </CardDescription>
        ) : (
          <CardDescription className="text-sm">
            Current active plan
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <Button variant="outline" size="sm" onClick={() => openCustomerPortal({ returnUrl: window.location.href })}>
          Manage billing
        </Button>
      </CardContent>
    </Card>
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
    const activeSub = customer?.subscriptions?.find(
      (s) => s.status === "active",
    )
    if (activeSub?.currentPeriodStart && activeSub?.currentPeriodEnd) {
      const start = new Date(activeSub.currentPeriodStart)
      const end = new Date(activeSub.currentPeriodEnd)
      return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`
    }
    // Fallback: calendar month → today
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
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <CurrentPlanCard />

        {isLoading ? (
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent className="space-y-5">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ) : (
          <UsageMeters
            usage={usage}
            limits={limits}
            billingPeriodLabel={billingPeriodLabel}
          />
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      ) : (
        <PricingCards />
      )}
    </div>
  )
}

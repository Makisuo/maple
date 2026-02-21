import { useMemo } from "react"
import { useCustomer } from "autumn-js/react"
import { PricingCards } from "./pricing-cards"
import { format } from "date-fns"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@maple/ui/components/ui/card"
import { getPlanLimits, type PlanLimits } from "@/lib/billing/plans"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { UsageMeters } from "./usage-meters"

type CustomerFeatures = Record<string, { usage?: number | null; included_usage?: number | null; balance?: number | null }> | undefined

function limitsFromCustomer(features: CustomerFeatures): PlanLimits | null {
  if (!features) return null
  const defaults = getPlanLimits("starter")
  return {
    logsGB: features.logs?.included_usage ?? defaults.logsGB,
    tracesGB: features.traces?.included_usage ?? defaults.tracesGB,
    metricsGB: features.metrics?.included_usage ?? defaults.metricsGB,
    retentionDays: features.retention_days?.balance ?? defaults.retentionDays,
  }
}

function usageFromCustomer(features: CustomerFeatures): AggregatedUsage {
  if (!features) return { logsGB: 0, tracesGB: 0, metricsGB: 0 }
  return {
    logsGB: features.logs?.usage ?? 0,
    tracesGB: features.traces?.usage ?? 0,
    metricsGB: features.metrics?.usage ?? 0,
  }
}

export function BillingSection() {
  const { customer, isLoading: isCustomerLoading } = useCustomer()

  const now = useMemo(() => new Date(), [])
  const startOfMonth = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), 1),
    [now],
  )
  const billingPeriodLabel = `${format(startOfMonth, "MMM d")} – ${format(now, "MMM d, yyyy")}`

  const limits = limitsFromCustomer(customer?.features) ?? getPlanLimits("starter")
  const usage = usageFromCustomer(customer?.features)

  return (
    <div className="space-y-6">
      {isCustomerLoading ? (
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

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Plans</h3>
        {isCustomerLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : (
          <PricingCards />
        )}
      </div>
    </div>
  )
}

import { useMemo } from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useCustomer } from "autumn-js/react"
import { PricingCards } from "./pricing-cards"
import { format } from "date-fns"

import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { formatForTinybird } from "@/lib/time-utils"
import { aggregateUsage } from "@/lib/billing/usage"
import { getPlanLimits, type PlanLimits } from "@/lib/billing/plans"
import { UsageMeters } from "./usage-meters"

function limitsFromCustomer(
  features: Record<string, { included_usage?: number | null; balance?: number | null }> | undefined,
): PlanLimits | null {
  if (!features) return null
  return {
    logsGB: features.logs_gb?.included_usage ?? 1,
    tracesGB: features.traces_gb?.included_usage ?? 1,
    metricsGB: features.metrics_gb?.included_usage ?? 0.5,
    retentionDays: features.retention_days?.balance ?? 7,
  }
}

export function BillingSection() {
  const { customer, isLoading: isCustomerLoading } = useCustomer()

  const now = useMemo(() => new Date(), [])
  const startOfMonth = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), 1),
    [now],
  )
  const startTime = useMemo(() => formatForTinybird(startOfMonth), [startOfMonth])
  const endTime = useMemo(() => formatForTinybird(now), [now])

  const billingPeriodLabel = `${format(startOfMonth, "MMM d")} – ${format(now, "MMM d, yyyy")}`

  const limits = limitsFromCustomer(customer?.features) ?? getPlanLimits("free")

  const usageResult = useAtomValue(
    getServiceUsageResultAtom({ data: { startTime, endTime } }),
  )

  return (
    <div className="space-y-6">
      {Result.builder(usageResult)
        .onInitial(() => (
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
        ))
        .onError(() => (
          <Card>
            <CardHeader>
              <CardTitle>Current Usage</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Unable to load usage data.
              </p>
            </CardContent>
          </Card>
        ))
        .onSuccess((response) => {
          const usage = aggregateUsage(response.data)
          return (
            <UsageMeters
              usage={usage}
              limits={limits}
              billingPeriodLabel={billingPeriodLabel}
            />
          )
        })
        .render()}

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
        </CardHeader>
        <CardContent>
          {isCustomerLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <PricingCards />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

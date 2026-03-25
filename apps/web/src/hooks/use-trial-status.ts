import { useMemo } from "react"
import { useCustomer } from "autumn-js/react"
import { getActivePlan } from "@/lib/billing/plan-gating"

export function useTrialStatus() {
  const { data: customer, isLoading } = useCustomer()

  return useMemo(() => {
    const sub = getActivePlan(customer)

    if (!sub) {
      return {
        isTrialing: false,
        daysRemaining: null,
        trialEndsAt: null,
        planName: null,
        planId: null,
        planStatus: null,
        isLoading,
      }
    }

    const isTrialing = sub.trialEndsAt != null && sub.trialEndsAt > Date.now()
    let daysRemaining: number | null = null
    let trialEndsAt: Date | null = null

    if (isTrialing && sub.trialEndsAt) {
      trialEndsAt = new Date(sub.trialEndsAt)
      const msRemaining = trialEndsAt.getTime() - Date.now()
      daysRemaining = msRemaining > 0 ? Math.ceil(msRemaining / (1000 * 60 * 60 * 24)) : 0
    }

    return {
      isTrialing,
      daysRemaining,
      trialEndsAt,
      planName: sub.plan?.name ?? sub.planId,
      planId: sub.planId,
      planStatus: sub.status,
      isLoading,
    }
  }, [customer, isLoading])
}

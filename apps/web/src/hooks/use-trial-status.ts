import { useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { getActivePlan } from "@/lib/billing/plan-gating"

export function useTrialStatus() {
  const customerResult = useAtomValue(
    MapleApiAtomClient.query("billing", "getCustomer", {}),
  )
  const customer = Result.builder(customerResult)
    .onSuccess((c) => c)
    .orElse(() => null)
  const isLoading = Result.isInitial(customerResult)

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

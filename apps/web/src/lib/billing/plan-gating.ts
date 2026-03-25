import { useCustomer } from "autumn-js/react"

type Customer = NonNullable<ReturnType<typeof useCustomer>["data"]>

type Subscription = Customer["subscriptions"][number]

function isLegacyFreePlan(sub: Subscription): boolean {
  if (sub.planId.toLowerCase() === "free") return true
  return sub.plan?.name?.toLowerCase() === "free"
}

export function getActivePlan(customer: Customer | null | undefined): Subscription | null {
  if (!customer) return null

  return customer.subscriptions.find((sub) => {
    if (sub.addOn || sub.autoEnable) return false
    if (isLegacyFreePlan(sub)) return false
    return sub.status === "active"
  }) ?? null
}

export function hasSelectedPlan(customer: Customer | null | undefined): boolean {
  return getActivePlan(customer) !== null
}

export function hasBringYourOwnCloudAddOn(customer: Customer | null | undefined): boolean {
  if (!customer) return false

  return !!customer.flags.bringyourowncloud
}

import type { Customer } from "autumn-js"

const ALLOWED_PRODUCT_STATUSES = new Set(["active", "trialing", "past_due"])
const BRING_YOUR_OWN_CLOUD_ADD_ON_ID = "bringyourowncloud"

function isLegacyFreeProduct(product: Customer["products"][number]): boolean {
  if (product.id.toLowerCase() === "free") return true
  return product.name?.toLowerCase() === "free"
}

export function getActivePlan(customer: Customer | null | undefined): Customer["products"][number] | null {
  if (!customer) return null

  return customer.products.find((product) => {
    if (product.is_add_on || product.is_default) return false
    if (isLegacyFreeProduct(product)) return false
    return ALLOWED_PRODUCT_STATUSES.has(product.status)
  }) ?? null
}

export function hasSelectedPlan(customer: Customer | null | undefined): boolean {
  return getActivePlan(customer) !== null
}

export function hasBringYourOwnCloudAddOn(customer: Customer | null | undefined): boolean {
  if (!customer) return false

  return customer.products.some((product) => {
    if (!product.is_add_on) return false
    if (product.id.toLowerCase() !== BRING_YOUR_OWN_CLOUD_ADD_ON_ID) return false
    return ALLOWED_PRODUCT_STATUSES.has(product.status)
  })
}

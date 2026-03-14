import { describe, expect, it } from "vitest"
import type { Customer } from "autumn-js"
import { hasBringYourOwnCloudAddOn, hasSelectedPlan } from "./plan-gating"

function buildCustomer(products: Customer["products"]): Customer {
  return {
    id: "cus_1",
    created_at: Date.now(),
    name: "Test",
    email: "test@maple.dev",
    fingerprint: null,
    stripe_id: null,
    env: "sandbox" as Customer["env"],
    metadata: {},
    products,
    features: {},
  }
}

function buildProduct(
  partial: Partial<Customer["products"][number]> = {},
): Customer["products"][number] {
  return {
    id: "starter",
    name: "Starter",
    group: null,
    status: "active" as Customer["products"][number]["status"],
    started_at: Date.now(),
    canceled_at: null,
    version: 1,
    is_add_on: false,
    is_default: false,
    items: [],
    ...partial,
  }
}

describe("hasSelectedPlan", () => {
  it("returns false when customer is missing", () => {
    expect(hasSelectedPlan(null)).toBe(false)
    expect(hasSelectedPlan(undefined)).toBe(false)
  })

  it("returns true for active paid base plans", () => {
    const customer = buildCustomer([buildProduct()])
    expect(hasSelectedPlan(customer)).toBe(true)
  })

  it("returns true for trialing and past_due plans", () => {
    const trialingCustomer = buildCustomer([
      buildProduct({ status: "trialing" as Customer["products"][number]["status"] }),
    ])
    const pastDueCustomer = buildCustomer([
      buildProduct({ status: "past_due" as Customer["products"][number]["status"] }),
    ])

    expect(hasSelectedPlan(trialingCustomer)).toBe(true)
    expect(hasSelectedPlan(pastDueCustomer)).toBe(true)
  })

  it("returns false for free, add-on, default, or scheduled-only products", () => {
    const freeCustomer = buildCustomer([buildProduct({ id: "free", name: "Free" })])
    const addOnCustomer = buildCustomer([buildProduct({ is_add_on: true })])
    const defaultCustomer = buildCustomer([buildProduct({ is_default: true })])
    const scheduledCustomer = buildCustomer([
      buildProduct({ status: "scheduled" as Customer["products"][number]["status"] }),
    ])

    expect(hasSelectedPlan(freeCustomer)).toBe(false)
    expect(hasSelectedPlan(addOnCustomer)).toBe(false)
    expect(hasSelectedPlan(defaultCustomer)).toBe(false)
    expect(hasSelectedPlan(scheduledCustomer)).toBe(false)
  })
})

describe("hasBringYourOwnCloudAddOn", () => {
  it("returns false when customer is missing", () => {
    expect(hasBringYourOwnCloudAddOn(null)).toBe(false)
    expect(hasBringYourOwnCloudAddOn(undefined)).toBe(false)
  })

  it("returns true for active bringyourowncloud add-on", () => {
    const customer = buildCustomer([
      buildProduct({
        id: "bringyourowncloud",
        is_add_on: true,
      }),
    ])

    expect(hasBringYourOwnCloudAddOn(customer)).toBe(true)
  })

  it("returns true for trialing and past_due bringyourowncloud add-ons", () => {
    const trialingCustomer = buildCustomer([
      buildProduct({
        id: "bringyourowncloud",
        is_add_on: true,
        status: "trialing" as Customer["products"][number]["status"],
      }),
    ])
    const pastDueCustomer = buildCustomer([
      buildProduct({
        id: "bringyourowncloud",
        is_add_on: true,
        status: "past_due" as Customer["products"][number]["status"],
      }),
    ])

    expect(hasBringYourOwnCloudAddOn(trialingCustomer)).toBe(true)
    expect(hasBringYourOwnCloudAddOn(pastDueCustomer)).toBe(true)
  })

  it("returns false for inactive bringyourowncloud add-ons", () => {
    const scheduledCustomer = buildCustomer([
      buildProduct({
        id: "bringyourowncloud",
        is_add_on: true,
        status: "scheduled" as Customer["products"][number]["status"],
      }),
    ])
    const canceledCustomer = buildCustomer([
      buildProduct({
        id: "bringyourowncloud",
        is_add_on: true,
        status: "canceled" as Customer["products"][number]["status"],
      }),
    ])

    expect(hasBringYourOwnCloudAddOn(scheduledCustomer)).toBe(false)
    expect(hasBringYourOwnCloudAddOn(canceledCustomer)).toBe(false)
  })

  it("returns false for non-matching add-on ids", () => {
    const customer = buildCustomer([
      buildProduct({
        id: "tinybird",
        is_add_on: true,
      }),
    ])

    expect(hasBringYourOwnCloudAddOn(customer)).toBe(false)
  })

  it("matches bringyourowncloud add-on ids case-insensitively", () => {
    const customer = buildCustomer([
      buildProduct({
        id: "BringYourOwnCloud",
        is_add_on: true,
      }),
    ])

    expect(hasBringYourOwnCloudAddOn(customer)).toBe(true)
  })
})

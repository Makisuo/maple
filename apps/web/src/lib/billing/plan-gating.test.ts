import { describe, expect, it } from "vitest"
import { useCustomer } from "autumn-js/react"
import { hasBringYourOwnCloudAddOn, hasSelectedPlan } from "./plan-gating"

type Customer = NonNullable<ReturnType<typeof useCustomer>["data"]>
type Subscription = Customer["subscriptions"][number]

function buildCustomer(
  subscriptions: Subscription[],
  overrides: { flags?: Customer["flags"]; balances?: Customer["balances"] } = {},
): Customer {
  return {
    id: "cus_1",
    createdAt: Date.now(),
    name: "Test",
    email: "test@maple.dev",
    fingerprint: null,
    stripeId: null,
    env: "sandbox" as Customer["env"],
    metadata: {},
    sendEmailReceipts: false,
    billingControls: {},
    subscriptions,
    purchases: [],
    balances: overrides.balances ?? {},
    flags: overrides.flags ?? {},
  }
}

function buildSubscription(
  partial: Partial<Subscription> = {},
): Subscription {
  return {
    id: "sub_1",
    planId: "starter",
    plan: { id: "starter", name: "Starter", description: null, group: null, version: 1, addOn: false, autoEnable: false, price: null, items: [], createdAt: Date.now(), env: "sandbox", archived: false, baseVariantId: null },
    autoEnable: false,
    addOn: false,
    status: "active" as Subscription["status"],
    pastDue: false,
    canceledAt: null,
    expiresAt: null,
    trialEndsAt: null,
    startedAt: Date.now(),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    quantity: 1,
    ...partial,
  }
}

describe("hasSelectedPlan", () => {
  it("returns false when customer is missing", () => {
    expect(hasSelectedPlan(null)).toBe(false)
    expect(hasSelectedPlan(undefined)).toBe(false)
  })

  it("returns true for active paid base plans", () => {
    const customer = buildCustomer([buildSubscription()])
    expect(hasSelectedPlan(customer)).toBe(true)
  })

  it("returns true for trialing plans (active status with trialEndsAt set)", () => {
    const trialingCustomer = buildCustomer([
      buildSubscription({ status: "active", trialEndsAt: Date.now() + 86400000 }),
    ])
    expect(hasSelectedPlan(trialingCustomer)).toBe(true)
  })

  it("returns false for free, add-on, auto-enabled, or scheduled-only subscriptions", () => {
    const freeCustomer = buildCustomer([
      buildSubscription({ planId: "free", plan: { id: "free", name: "Free", description: null, group: null, version: 1, addOn: false, autoEnable: true, price: null, items: [], createdAt: Date.now(), env: "sandbox", archived: false, baseVariantId: null } }),
    ])
    const addOnCustomer = buildCustomer([buildSubscription({ addOn: true })])
    const defaultCustomer = buildCustomer([buildSubscription({ autoEnable: true })])
    const scheduledCustomer = buildCustomer([
      buildSubscription({ status: "scheduled" as Subscription["status"] }),
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

  it("returns true when bringyourowncloud flag is present", () => {
    const customer = buildCustomer([], {
      flags: {
        bringyourowncloud: {
          id: "flag_1",
          planId: null,
          expiresAt: null,
          featureId: "bringyourowncloud",
        },
      },
    })

    expect(hasBringYourOwnCloudAddOn(customer)).toBe(true)
  })

  it("returns false when bringyourowncloud flag is missing", () => {
    const customer = buildCustomer([])

    expect(hasBringYourOwnCloudAddOn(customer)).toBe(false)
  })
})

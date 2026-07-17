import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

// Reactivity keys: a mutation that bumps a key invalidates every query atom
// registered with it. attach/portal change the customer (and thus per-plan
// eligibility), so they bump customer + plans. Module-level so every consumer
// shares one fetch + one cache (the array compares by reference).
export const BILLING_CUSTOMER_KEY = "billingCustomer"
export const BILLING_PLANS_KEY = "billingPlans"
export const BILLING_USAGE_KEY = "billingUsage"
export const BILLING_INVOICES_KEY = "billingInvoices"

// Read atoms. Transient token-settle 401s are retried by the shared client
// (atom-client.ts scopes a 401 retry to /api/billing/*), and effect-atom
// refetches on remount + reactivity invalidation — so these can't freeze the
// way the old autumn-js QueryClient (retry:false) did.
export const billingCustomerAtom = MapleApiAtomClient.query("billing", "getCustomer", {
	reactivityKeys: [BILLING_CUSTOMER_KEY],
})

export const billingPlansAtom = MapleApiAtomClient.query("billingPublic", "listPlans", {
	reactivityKeys: [BILLING_PLANS_KEY],
})

// The billing page always meters the same four features over one billing cycle,
// so a single static atom (not a family) is enough.
export const billingUsageAtom = MapleApiAtomClient.query("billing", "getUsage", {
	query: { featureId: ["logs", "traces", "metrics", "browser_sessions"], range: "1bc" },
	reactivityKeys: [BILLING_USAGE_KEY],
})

export const billingInvoicesAtom = MapleApiAtomClient.query("billing", "listInvoices", {
	reactivityKeys: [BILLING_INVOICES_KEY],
})

// Mutations.
export const attachMutation = MapleApiAtomClient.mutation("billing", "attach")
export const previewAttachMutation = MapleApiAtomClient.mutation("billing", "previewAttach")
export const openCustomerPortalMutation = MapleApiAtomClient.mutation("billing", "openCustomerPortal")

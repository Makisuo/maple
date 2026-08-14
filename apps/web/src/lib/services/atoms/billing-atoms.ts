import { retainedQuery } from "@/lib/services/common/atom-client"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

// Reactivity keys: a mutation that bumps a key invalidates every query atom
// registered with it. attach/portal change the customer (and thus per-plan
// eligibility), so they bump customer + plans. Module-level so every consumer
// shares one fetch + one cache (the array compares by reference).
export const BILLING_CUSTOMER_KEY = "billingCustomer"
export const BILLING_PLANS_KEY = "billingPlans"
export const BILLING_USAGE_KEY = "billingUsage"
export const BILLING_INVOICES_KEY = "billingInvoices"

// Read atoms. Transient token-settle 401s are retried by the shared client
// (api-client-transform.ts scopes a 401 retry to the billing paths), and effect-atom
// refetches on remount + reactivity invalidation — so these can't freeze the
// way the old autumn-js QueryClient (retry:false) did.
export const billingCustomerAtom = retainedInternalQuery("billing", "getCustomer", {
	reactivityKeys: [BILLING_CUSTOMER_KEY],
})

export const billingPlansAtom = retainedQuery("billingPublic", "listPlans", {
	reactivityKeys: [BILLING_PLANS_KEY],
})

// The billing page always meters the same four features over one billing cycle,
// so a single static atom (not a family) is enough.
export const billingUsageAtom = retainedInternalQuery("billing", "getUsage", {
	query: { featureId: ["logs", "traces", "metrics", "browser_sessions"], range: "1bc" },
	reactivityKeys: [BILLING_USAGE_KEY],
})

export const billingInvoicesAtom = retainedInternalQuery("billing", "listInvoices", {
	reactivityKeys: [BILLING_INVOICES_KEY],
})

// Warehouse-backed daily volume behind the spend chart. Shares the customer's
// reactivity key: the series is scoped to the subscription's cycle, so a plan
// change re-fetches it.
export const billingDailySpendAtom = retainedInternalQuery("billing", "getDailySpend", {
	reactivityKeys: [BILLING_CUSTOMER_KEY],
})

export const attachMutation = MapleInternalAtomClient.mutation("billing", "attach")
export const previewAttachMutation = MapleInternalAtomClient.mutation("billing", "previewAttach")
export const openCustomerPortalMutation = MapleInternalAtomClient.mutation("billing", "openCustomerPortal")
export const updateBillingControlsMutation = MapleInternalAtomClient.mutation(
	"billing",
	"updateBillingControls",
)

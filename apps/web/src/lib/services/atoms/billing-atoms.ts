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
// Billing details (company name, address, tax IDs) live on the Stripe customer,
// not the Autumn one, so they get their own key: no customer-level mutation
// changes them and none of theirs changes the customer.
export const BILLING_PROFILE_KEY = "billingProfile"

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

// The billing page always meters the same five features over the current
// billing cycle (the API resolves the window), so a single static atom (not a
// family) is enough.
export const billingUsageAtom = retainedInternalQuery("billing", "getUsage", {
	query: {
		featureId: ["logs", "traces", "metrics", "browser_sessions", "product_events"],
	},
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

// Settings-only read of the Stripe-side billing details. Not fetched on
// every page like the customer, so no edge cache behind it either.
export const billingProfileAtom = retainedInternalQuery("billing", "getBillingProfile", {
	reactivityKeys: [BILLING_PROFILE_KEY],
})

export const attachMutation = MapleInternalAtomClient.mutation("billing", "attach")
export const previewAttachMutation = MapleInternalAtomClient.mutation("billing", "previewAttach")
export const openCustomerPortalMutation = MapleInternalAtomClient.mutation("billing", "openCustomerPortal")
export const updateBillingControlsMutation = MapleInternalAtomClient.mutation(
	"billing",
	"updateBillingControls",
)
export const updateBillingProfileMutation = MapleInternalAtomClient.mutation(
	"billing",
	"updateBillingProfile",
)
export const addBillingTaxIdMutation = MapleInternalAtomClient.mutation("billing", "addBillingTaxId")
export const removeBillingTaxIdMutation = MapleInternalAtomClient.mutation("billing", "removeBillingTaxId")

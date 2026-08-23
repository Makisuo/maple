import { useCallback } from "react"
import { Cause, Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { trackProduct } from "@/lib/analytics"
import { useAtomSet } from "@/lib/effect-atom"
import {
	AttachRequest,
	type AttachResult,
	CustomerPortalRequest,
	PreviewAttachRequest,
	type PreviewAttachResult,
} from "@maple/domain/http"
import {
	BILLING_CUSTOMER_KEY,
	BILLING_INVOICES_KEY,
	BILLING_PLANS_KEY,
	attachMutation,
	openCustomerPortalMutation,
	previewAttachMutation,
} from "@/lib/services/atoms/billing-atoms"

// attach / openCustomerPortal change the customer, its per-plan eligibility, and
// can produce a new invoice — invalidate customer, plan catalog, and invoices.
const MUTATION_KEYS = [BILLING_CUSTOMER_KEY, BILLING_PLANS_KEY, BILLING_INVOICES_KEY]

function unwrap<A>(exit: Exit.Exit<A, unknown>): A {
	if (Exit.isSuccess(exit)) return exit.value
	// Surface the upstream BillingUpstreamError (a real Error with `.message`) so
	// callers' `try/catch` + `err.message` keeps working as it did with autumn.
	throw Cause.squash(exit.cause)
}

/**
 * Billing mutations backed by effect-atom. `attach`/`previewAttach` throw on
 * failure (preserving the existing `try/catch`/toast call sites);
 * `openCustomerPortal` toasts on failure and redirects on success, so call sites
 * can fire-and-forget it.
 */
export function useBillingActions() {
	const attachSet = useAtomSet(attachMutation, { mode: "promiseExit" })
	const previewSet = useAtomSet(previewAttachMutation, { mode: "promiseExit" })
	const portalSet = useAtomSet(openCustomerPortalMutation, { mode: "promiseExit" })

	const attach = useCallback(
		async ({ planId, successUrl }: { planId: string; successUrl?: string }): Promise<AttachResult> => {
			const result = unwrap(
				await attachSet({
					payload: new AttachRequest(
						successUrl === undefined ? { planId } : { planId, successUrl },
					),
					reactivityKeys: MUTATION_KEYS,
				}),
			)
			// Every caller redirects to `paymentUrl` when present, so this is the last
			// moment the session is still ours: record checkout intent before the tab
			// leaves for Stripe. `plan_started` itself is emitted server-side.
			if (result.paymentUrl) trackProduct("plan_checkout_started", { plan_id: planId })
			return result
		},
		[attachSet],
	)

	const previewAttach = useCallback(
		async ({ planId }: { planId: string }): Promise<PreviewAttachResult> =>
			unwrap(await previewSet({ payload: new PreviewAttachRequest({ planId }) })),
		[previewSet],
	)

	const openCustomerPortal = useCallback(
		async ({ returnUrl }: { returnUrl?: string }): Promise<void> => {
			const exit = await portalSet({
				payload: new CustomerPortalRequest({ returnUrl }),
				reactivityKeys: MUTATION_KEYS,
			})
			if (Exit.isSuccess(exit)) {
				window.location.href = exit.value.url
				return
			}
			const error = Cause.squash(exit.cause)
			toastManager.add({
				title: error instanceof Error ? error.message : "Couldn't open the billing portal.",
				type: "error",
			})
		},
		[portalSet],
	)

	return { attach, previewAttach, openCustomerPortal }
}

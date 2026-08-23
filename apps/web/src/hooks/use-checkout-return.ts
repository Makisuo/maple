import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { billingCustomerAtom } from "@/lib/services/atoms/billing-atoms"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import {
	CHECKOUT_CONFIRM_POLL_MS,
	CHECKOUT_CONFIRM_TIMEOUT_MS,
	isCheckoutReturn,
	withoutCheckoutReturn,
} from "@/lib/billing/checkout-return"
import { trackProduct } from "@/lib/analytics"

export type CheckoutReturnStatus =
	/** Not a checkout return — render the plan offer as usual. */
	| "idle"
	/** Back from Stripe, customer still planless: waiting on the Stripe→Autumn sync. */
	| "confirming"
	/** The plan showed up. Callers usually redirect or re-render as active. */
	| "confirmed"
	/** Waited the full window without a plan — show the offer again, with a note. */
	| "timed_out"

/**
 * Drives the page a buyer lands on after Stripe Checkout (see
 * `lib/billing/checkout-return.ts` for why the marker exists).
 *
 * While `confirming`, the customer atom is re-read every
 * `CHECKOUT_CONFIRM_POLL_MS` until it carries an active plan or
 * `CHECKOUT_CONFIRM_TIMEOUT_MS` elapses. Either way the marker is then stripped
 * from the URL (replace, no history entry) so a reload doesn't re-enter the wait.
 */
export function useCheckoutReturn(): CheckoutReturnStatus {
	const location = useLocation()
	const navigate = useNavigate()
	const returning = isCheckoutReturn(location.searchStr)
	const customerResult = useAtomValue(billingCustomerAtom)
	const refreshCustomer = useAtomRefresh(billingCustomerAtom)
	const confirmed = Result.isSuccess(customerResult) && hasSelectedPlan(customerResult.value)
	const [timedOut, setTimedOut] = useState(false)

	// External-system sync: a timer against the billing backend, not derived state.
	useEffect(() => {
		if (!returning) return
		if (confirmed || timedOut) {
			trackProduct("plan_checkout_returned", { confirmed })
			navigate({
				to: ".",
				search: (prev: Record<string, unknown>) => withoutCheckoutReturn(prev),
				replace: true,
			})
			return
		}
		const startedAt = Date.now()
		const interval = setInterval(() => {
			if (Date.now() - startedAt >= CHECKOUT_CONFIRM_TIMEOUT_MS) {
				setTimedOut(true)
				return
			}
			refreshCustomer()
		}, CHECKOUT_CONFIRM_POLL_MS)
		return () => clearInterval(interval)
	}, [returning, confirmed, timedOut, refreshCustomer, navigate])

	if (!returning) return "idle"
	if (confirmed) return "confirmed"
	if (timedOut) return "timed_out"
	return "confirming"
}

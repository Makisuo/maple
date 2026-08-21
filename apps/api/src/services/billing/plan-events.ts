import { Effect } from "effect"
import type { AttachResult } from "@maple/domain/http"
import type { ProductEventsApi } from "@/services/product-events/ProductEventsService"

/**
 * `plan_started` for the no-redirect `attach` outcome.
 *
 * `billing.attach` with `redirect_mode: "if_required"` either returns a Stripe
 * `paymentUrl` (the plan starts later, on the Stripe → Autumn side, and the
 * Autumn `billing.updated` webhook is the truth) or applies the change inline
 * for a customer with a payment method on file. Both paths eventually produce
 * a webhook, so this emit is the LOW-LATENCY complement, not the only signal:
 * it carries `trigger=attach` and the acting `user_id`, which the webhook can
 * never know. Consumers dedupe on `(group_id, plan_id)` within a window — see
 * `autumn-events.ts` for why there is no `subscription_id` to key on.
 */
export const emitPlanStartedFromAttach = (
	productEvents: ProductEventsApi,
	input: {
		readonly orgId: string
		readonly userId: string
		readonly planId: string
		readonly result: AttachResult
	},
): Effect.Effect<void> => {
	const redirected = input.result.paymentUrl !== undefined && input.result.paymentUrl !== null
	if (redirected) return Effect.void
	return productEvents.track({
		name: "plan_started",
		userId: input.userId,
		groupId: input.orgId,
		attributes: { plan_id: input.planId, trigger: "attach" },
	})
}

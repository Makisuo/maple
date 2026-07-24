import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { useBillingActions } from "@/hooks/use-billing-actions"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { CircleWarningIcon } from "@/components/icons"
import { getPastDueSubscription } from "@/lib/billing/plan-gating"

// Dev-only escape hatch so the banner can be eyeballed without a past-due Autumn
// customer: load any page with `?payment_preview=1`. Compiled out of production
// builds (import.meta.env.DEV).
function previewPastDue(): boolean {
	if (!import.meta.env.DEV || typeof window === "undefined") return false
	return new URLSearchParams(window.location.search).get("payment_preview") === "1"
}

/**
 * Critical alert shown in the app shell when the org's subscription has overdue
 * payments (Autumn `subscription.pastDue`). Prompts the user to update their
 * payment method via the Autumn customer portal. Non-dismissible — it stays put
 * until the payment is resolved.
 */
export function PaymentFailedBanner() {
	const { data: customer } = useMapleCustomer()
	const { openCustomerPortal } = useBillingActions()
	const pastDue = previewPastDue() || getPastDueSubscription(customer) !== null

	if (!pastDue) return null

	return (
		<div className="px-4 pt-3">
			<Alert variant="error">
				<CircleWarningIcon size={16} />
				<AlertTitle>Payment failed</AlertTitle>
				<AlertDescription>
					We couldn't process your most recent payment. Update your payment method to keep your data
					flowing.
				</AlertDescription>
				<AlertAction>
					<Button size="sm" onClick={() => openCustomerPortal({ returnUrl: window.location.href })}>
						Update payment method
					</Button>
				</AlertAction>
			</Alert>
		</div>
	)
}

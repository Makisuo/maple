import { Link } from "@tanstack/react-router"
import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { CircleWarningIcon } from "@/components/icons"
import { getLapsedPlan } from "@/lib/billing/plan-gating"

// Dev-only escape hatch so the banner can be eyeballed without a lapsed Autumn
// customer: load any page with `?subscription_ended_preview=1`. Compiled out of
// production builds (import.meta.env.DEV).
function previewLapsed(): boolean {
	if (!import.meta.env.DEV || typeof window === "undefined") return false
	return new URLSearchParams(window.location.search).get("subscription_ended_preview") === "1"
}

/**
 * Critical alert shown in the app shell when the org held a plan and no longer
 * does — cancelled, expired, or otherwise lapsed. These are returning customers,
 * so they keep the app (their history is still here to read); what they've lost
 * is ingestion, which the gateway rejects with a 402 until a plan is active
 * again. Non-dismissible — it stays put until they resubscribe.
 */
export function SubscriptionEndedBanner() {
	const { data: customer } = useMapleCustomer()
	const lapsed = getLapsedPlan(customer)
	const preview = previewLapsed()

	if (!lapsed && !preview) return null

	const planName = lapsed?.plan?.name ?? lapsed?.planId ?? null

	return (
		<div className="px-4 pt-3">
			<Alert variant="error">
				<CircleWarningIcon size={16} />
				<AlertTitle>Subscription ended</AlertTitle>
				<AlertDescription>
					{planName ? `Your ${planName} plan has ended.` : "Your plan has ended."} Your existing
					data is still here, but new telemetry is being rejected until you pick a plan.
				</AlertDescription>
				<AlertAction>
					<Button size="sm" render={<Link to="/select-plan" />}>
						Choose a plan
					</Button>
				</AlertAction>
			</Alert>
		</div>
	)
}

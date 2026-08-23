import { Spinner } from "@maple/ui/components/ui/spinner"

/**
 * What the buyer sees between Stripe sending them back and Autumn confirming
 * the subscription — in place of the plan offer, so the "Start trial" button
 * they just used cannot be shown to them a second time.
 */
export function CheckoutConfirmingPanel() {
	return (
		<div
			role="status"
			aria-live="polite"
			className="mx-auto flex max-w-md flex-col items-center gap-3 border border-border/60 bg-card/40 px-6 py-10 text-center"
		>
			<Spinner className="size-5" />
			<p className="text-sm font-medium">Confirming your subscription…</p>
			<p className="text-sm text-muted-foreground">
				Stripe is letting us know your checkout finished. This usually takes a few seconds — there's
				nothing else to click.
			</p>
		</div>
	)
}

/** Shown above the offer once the wait gave up, so a slow sync doesn't read as "it failed". */
export function CheckoutTimedOutNotice() {
	return (
		<p
			role="status"
			className="border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
		>
			We haven't heard back from Stripe yet. If you completed checkout, your plan will appear here
			shortly — there's no need to subscribe again. If you left checkout, pick a plan below.
		</p>
	)
}

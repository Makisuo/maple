import { useAuth } from "@clerk/clerk-react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { RocketIcon } from "@/components/icons"
import { BootSplash } from "@/components/boot-splash"
import { PricingCards } from "@/components/settings/pricing-cards"
import { hasLapsedPlan, hasSelectedPlan } from "@/lib/billing/plan-gating"
import { TRIAL_DURATION_DAYS } from "@/lib/billing/plans"
import { parseRedirectUrl } from "@/lib/redirect-utils"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const SelectPlanSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
	// Stripe Checkout return marker — see `lib/billing/checkout-return.ts`.
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const Route = createFileRoute("/select-plan")({
	component: SelectPlanPage,
	validateSearch: Schema.toStandardSchemaV1(SelectPlanSearch),
})

// Dev-only escape hatch, mirroring `SubscriptionEndedBanner`'s: load the page
// with `?subscription_ended_preview=1` to review the reactivation framing without
// a lapsed Autumn customer. Compiled out of production builds.
function previewLapsed(): boolean {
	if (!import.meta.env.DEV || typeof window === "undefined") return false
	return new URLSearchParams(window.location.search).get("subscription_ended_preview") === "1"
}

function resolveRedirectTarget(target: string | undefined): string {
	if (!target) return "/"
	return target.startsWith("/") ? target : "/"
}

function SelectPlanPage() {
	// Clerk hooks below require ClerkProvider, which is absent when auth is
	// disabled (self-hosted). Gate at this hook-free boundary so the inner
	// component can call hooks unconditionally.
	if (!isClerkAuthEnabled) {
		return <Navigate to="/" replace />
	}

	return <SelectPlanPageInner />
}

function SelectPlanPageInner() {
	const { isLoaded, isSignedIn, orgId } = useAuth()
	const { data: customer, isLoading: isCustomerLoading } = useMapleCustomer()
	const { redirect_url } = Route.useSearch()

	if (!isLoaded || isCustomerLoading) {
		return <BootSplash />
	}

	const redirectTarget = resolveRedirectTarget(redirect_url)

	if (!isSignedIn) {
		return <Navigate to="/sign-in" search={{ redirect_url: redirectTarget }} replace />
	}

	if (!orgId) {
		return <Navigate to="/org-required" search={{ redirect_url: redirectTarget }} replace />
	}

	if (hasSelectedPlan(customer)) {
		const target = parseRedirectUrl(redirectTarget)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	// A returning subscriber whose plan lapsed is not trial-eligible and does not
	// need the pitch — they need to restart ingestion. Same cards, different frame.
	const isReactivating = previewLapsed() || hasLapsedPlan(customer)

	return (
		<main className="relative min-h-screen overflow-hidden bg-background flex flex-col items-center justify-center py-12">
			{/* Premium Background Grid / Glow */}
			<div className="pointer-events-none absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]">
				<div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
			</div>

			<div className="pointer-events-none absolute inset-0">
				<div className="absolute top-[20%] left-[50%] -translate-x-1/2 -translate-y-1/2 size-[40rem] rounded-full bg-primary/5 blur-[100px]" />
			</div>

			<section className="relative mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 md:px-8 z-10">
				<div className="text-center flex flex-col items-center">
					{!isReactivating && (
						<div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] font-medium tracking-wider text-primary uppercase mb-6">
							<RocketIcon size={14} />
							{TRIAL_DURATION_DAYS}-day free trial
						</div>
					)}
					<h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground [text-wrap:balance]">
						{isReactivating ? "Pick up where you left off" : "Start your free trial"}
					</h1>
					<p className="text-muted-foreground mt-4 text-sm md:text-base leading-relaxed max-w-lg mx-auto [text-wrap:balance]">
						{isReactivating
							? "Your data is still here. Choose a plan to start ingesting again — cancel anytime."
							: `Try Maple free for ${TRIAL_DURATION_DAYS} days. You won't be charged until the trial ends. Cancel anytime.`}
					</p>
				</div>

				<div className="mt-4">
					<PricingCards />
				</div>
			</section>
		</main>
	)
}

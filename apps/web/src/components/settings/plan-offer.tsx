import { useState } from "react"
import { toast } from "sonner"

import type { CatalogPlan } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/utils"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { billingCustomerAtom, billingPlansAtom } from "@/lib/services/atoms/billing-atoms"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { getTrialStatus } from "@/lib/billing/plan-gating"
import { getPlanFeatures, TRIAL_DURATION_DAYS } from "@/lib/billing/plans"
import { featureUnit, type SpendModel } from "@/lib/billing/spend"

/**
 * The plans section: one offer, not a tier ladder.
 *
 * `apps/api/autumn.config.ts` sells exactly one self-serve plan, so a card-per-
 * tier grid manufactured a choice that doesn't exist — the same conclusion
 * `apps/landing/src/components/PricingTable.astro` reached for marketing. This is
 * the in-app version of that layout: a plate for the offer, and Enterprise as a
 * one-line rail beneath it rather than a peer card that competes with it.
 *
 * If a second self-serve plan is ever added, the plate lists them stacked and
 * this comment is the signal to revisit the layout.
 */

const ENTERPRISE_CALL_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"
const ENTERPRISE_FROM_PRICE = "From $2,000"

const includedRun = (plan: CatalogPlan): string =>
	plan.items
		.filter((item) => item.featureId && item.included != null)
		.map((item) => {
			const unit = featureUnit(item.featureId as string)
			const amount = Number(item.included).toLocaleString()
			return unit === "GB" ? `${amount} GB ${item.featureId}` : `${amount} sessions`
		})
		.join(" · ")

export function PlanOfferSkeleton() {
	return (
		<div className="space-y-3">
			<Skeleton className="h-32 w-full rounded-none" />
			<Skeleton className="h-16 w-full rounded-none" />
		</div>
	)
}

/**
 * The plan a custom-priced customer is actually on, rendered as their current
 * plan. Their plan is not for sale, so it can never come from the catalog — the
 * numbers here are their own, from the expanded subscription plus balances.
 */
function CustomPlanPlate({ model, onManageBilling }: { model: SpendModel; onManageBilling: () => void }) {
	const price = model.basePlan?.price?.amount
	const interval = model.basePlan?.price?.interval ?? "month"
	// A hard-capped plan bills nothing past its allotments, so "+ usage" would be
	// a straight untruth on it.
	const billsUsage = model.features.some(
		(feature) => feature.overageAllowed !== false && feature.ratePerUnit !== null,
	)
	const included = model.features
		.filter((feature) => feature.included != null || feature.unlimited)
		.map((feature) =>
			feature.unlimited
				? `unlimited ${feature.label.toLowerCase()}`
				: `${Number(feature.included).toLocaleString()} ${featureUnit(feature.featureId) === "GB" ? "GB" : ""} ${feature.label.toLowerCase()}`.replace(
						/\s+/g,
						" ",
					),
		)
		.join(" · ")

	return (
		<div className="flex flex-col gap-6 border border-primary/40 bg-primary/[0.03] p-5 lg:flex-row lg:items-start lg:justify-between">
			<div className="max-w-sm">
				<div className="flex items-center gap-2">
					<span className="text-sm">{model.planName ?? "Your plan"}</span>
					<span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
						Current plan
					</span>
				</div>
				<div className="mt-3 flex items-baseline gap-2">
					<span className="font-mono text-3xl tabular-nums">
						{price == null ? "Custom" : `$${price}`}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{price == null
							? "negotiated pricing"
							: billsUsage
								? `/${interval} + usage`
								: `/${interval}`}
					</span>
				</div>
				<p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
					{billsUsage
						? "A custom plan — your allotments and rates are your own, not the published ones."
						: "A custom plan with hard caps — usage past your allotments is rejected, never billed."}
				</p>
			</div>

			<div className="flex-1 lg:px-6">
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
					Included every cycle
				</span>
				<p className="mt-2 font-mono text-[11px] leading-relaxed text-foreground/85">
					{included.length > 0 ? included : "Allotments are set on your contract."}
				</p>
			</div>

			<div className="flex w-full shrink-0 flex-col gap-2 lg:w-44">
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Manage plan
				</Button>
				<p className="text-center text-[11px] text-muted-foreground">Invoices and payment method</p>
			</div>
		</div>
	)
}

export function PlanOffer({
	model,
	onManageBilling,
}: {
	/** Needed to render a custom plan, whose terms exist only on the customer. */
	model: SpendModel | null
	onManageBilling: () => void
}) {
	const plansResult = useAtomValue(billingPlansAtom)
	const customerResult = useAtomValue(billingCustomerAtom)
	const { attach } = useBillingActions()
	const refreshCustomer = useAtomRefresh(billingCustomerAtom)
	const [attaching, setAttaching] = useState<string | null>(null)

	const { isTrialing, daysRemaining } = getTrialStatus(
		Result.isSuccess(customerResult) ? customerResult.value : undefined,
	)

	if (Result.isInitial(plansResult)) return <PlanOfferSkeleton />
	if (!Result.isSuccess(plansResult)) {
		return <p className="text-sm text-muted-foreground">Unable to load pricing plans.</p>
	}

	const plans = plansResult.value.plans
	const offers = plans.filter((plan) => !plan.addOn && !plan.autoEnable)
	const addOns = plans.filter((plan) => plan.addOn)
	// A customer on a plan that isn't in the catalog (custom or grandfathered) must
	// see THEIR plan here. Showing the catalog's offer with a "Current plan" chip
	// would quote them a price they don't pay.
	const showCustomPlate = model?.isCustomPlan === true && model.planName !== null

	async function handleSubscribe(planId: string) {
		setAttaching(planId)
		try {
			const result = await attach({ planId })
			if (result.paymentUrl) {
				window.location.href = result.paymentUrl
				return
			}
			toast.success("Plan updated successfully.")
			refreshCustomer()
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong. Please try again.")
		} finally {
			setAttaching(null)
		}
	}

	return (
		<div className="space-y-3">
			{showCustomPlate && model && <CustomPlanPlate model={model} onManageBilling={onManageBilling} />}
			{offers.map((plan) => {
				const isActive = !showCustomPlate && plan.customerEligibility?.status === "active"
				const trialAvailable = plan.customerEligibility?.trialAvailable === true
				const platformFeatures = getPlanFeatures(plan.id?.toLowerCase() ?? "startup")
				const retention = platformFeatures.find((feature) => feature.label === "Data retention")

				return (
					<div
						key={plan.id}
						className={cn(
							"flex flex-col gap-6 border p-5 lg:flex-row lg:items-start lg:justify-between",
							isActive ? "border-primary/40 bg-primary/[0.03]" : "border-border/60 bg-card/40",
						)}
					>
						<div className="max-w-sm">
							<div className="flex items-center gap-2">
								<span className="text-sm">{plan.name}</span>
								{isActive && (
									<span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
										{isTrialing && daysRemaining != null
											? `Trial · ${daysRemaining}d left`
											: "Current plan"}
									</span>
								)}
							</div>
							<div className="mt-3 flex items-baseline gap-2">
								<span className="font-mono text-3xl tabular-nums">
									${plan.price?.amount ?? 0}
								</span>
								<span className="text-[11px] text-muted-foreground">
									/{plan.price?.interval ?? "month"} + usage
								</span>
							</div>
							<p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
								Everything in Maple. Pay per GB past what's included.
							</p>
						</div>

						<div className="flex-1 lg:px-6">
							<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
								Included every cycle
							</span>
							<p className="mt-2 font-mono text-[11px] leading-relaxed text-foreground/85">
								{includedRun(plan)}
								{retention && ` · ${retention.value.toLowerCase()} retention`}
							</p>
							{addOns.length > 0 && (
								<div className="mt-3 space-y-1">
									{addOns.map((addOn) => {
										const addOnActive = addOn.customerEligibility?.status === "active"
										return (
											<p key={addOn.id} className="text-[11px] text-muted-foreground">
												{addOnActive ? "Add-on active · " : "Add-on available · "}
												{addOn.name}
												{addOn.price?.amount != null &&
													` +$${addOn.price.amount}/${addOn.price.interval ?? "month"}`}
											</p>
										)
									})}
								</div>
							)}
						</div>

						<div className="flex w-full shrink-0 flex-col gap-2 lg:w-44">
							{isActive ? (
								<Button variant="outline" size="sm" onClick={onManageBilling}>
									Manage plan
								</Button>
							) : (
								<Button
									size="sm"
									disabled={attaching === plan.id}
									onClick={() => handleSubscribe(plan.id)}
								>
									{attaching === plan.id ? (
										<Spinner className="size-4" />
									) : trialAvailable ? (
										`Start ${plan.freeTrial?.durationLength ?? TRIAL_DURATION_DAYS}-day trial`
									) : (
										"Subscribe"
									)}
								</Button>
							)}
							<p className="text-center text-[11px] text-muted-foreground">
								{isActive ? "Invoices and payment method" : "$0 due today · cancel anytime"}
							</p>
						</div>
					</div>
				)
			})}

			{/* Enterprise is a rail, not a peer: it keeps the "From $2,000" anchor
			    that makes the self-serve price read as small, without spending a
			    full card of attention on a call-us flow. */}
			<div className="flex flex-col gap-4 border border-primary/25 bg-primary/[0.04] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
						Enterprise
					</span>
					<p className="mt-1.5 max-w-[48ch] text-[11px] leading-relaxed text-foreground/85">
						Higher volume, custom retention, priority support.
					</p>
				</div>
				<div className="flex shrink-0 items-center justify-between gap-5 sm:justify-end">
					<span className="whitespace-nowrap font-mono text-sm tabular-nums text-primary">
						{ENTERPRISE_FROM_PRICE}
					</span>
					<Button
						variant="outline"
						size="sm"
						className="border-primary/40 text-primary hover:bg-primary/10"
						onClick={() => window.open(ENTERPRISE_CALL_URL, "_blank", "noopener,noreferrer")}
					>
						Talk to the founder →
					</Button>
				</div>
			</div>
		</div>
	)
}

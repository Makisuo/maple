import { useEffect } from "react"
import { useCustomer } from "autumn-js/react"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { TRIAL_DURATION_DAYS } from "@/lib/billing/plans"
import { PricingCards } from "@/components/settings/pricing-cards"
import { Button } from "@maple/ui/components/ui/button"
import { ArrowLeftIcon } from "@/components/icons"

export function StepPlan({
	isComplete,
	onComplete,
	onBack,
}: {
	isComplete: boolean
	onComplete: () => void
	onBack?: () => void
}) {
	const { data: customer, isLoading } = useCustomer()
	const selectedPlan = hasSelectedPlan(customer)

	useEffect(() => {
		if (selectedPlan && !isComplete) {
			onComplete()
		}
	}, [selectedPlan, isComplete, onComplete])

	return (
		<div className="flex-1 flex flex-col items-center px-6 py-12 overflow-auto">
			<div className="w-full max-w-5xl">
				<div className="text-center mb-10">
					<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
						Pick a plan
					</span>
					<h2 className="text-3xl font-semibold tracking-tight mt-2">
						Pick a plan to keep going
					</h2>
					<p className="text-muted-foreground text-[15px] mt-3 max-w-lg mx-auto">
						Start a {TRIAL_DURATION_DAYS}-day free trial: we'll save your card now and won't
						charge until day {TRIAL_DURATION_DAYS}. Cancel anytime from settings.
					</p>
				</div>

				{isLoading ? <PricingSkeleton /> : <PricingCards />}

				{onBack && (
					<div className="mt-8 flex items-center justify-start">
						<Button variant="ghost" onClick={onBack} className="gap-2">
							<ArrowLeftIcon size={14} />
							Back
						</Button>
					</div>
				)}
			</div>
		</div>
	)
}

function PricingSkeleton() {
	return (
		<div
			role="status"
			aria-label="Loading plans"
			className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto"
		>
			{[0, 1, 2].map((i) => (
				<div
					key={`plan-skeleton-${i}`}
					className="rounded-xl border bg-card p-6 space-y-4"
					style={{ animationDelay: `${i * 80}ms` }}
				>
					<div className="h-5 w-24 rounded bg-muted/60 animate-pulse" />
					<div className="h-8 w-32 rounded bg-muted/60 animate-pulse" />
					<div className="space-y-2 pt-2">
						<div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
						<div className="h-3 w-5/6 rounded bg-muted/40 animate-pulse" />
						<div className="h-3 w-4/6 rounded bg-muted/40 animate-pulse" />
						<div className="h-3 w-3/6 rounded bg-muted/40 animate-pulse" />
					</div>
					<div className="h-10 w-full rounded-lg bg-muted/60 animate-pulse" />
				</div>
			))}
		</div>
	)
}

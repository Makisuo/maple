import { useState } from "react"
import { useCustomer, useListPlans } from "autumn-js/react"
import { toast } from "sonner"

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number]
type PlanItem = Plan["items"][number]

import { cn } from "@maple/ui/utils"
import { TRIAL_DURATION_DAYS, getPlanFeatures, getPlanDescription } from "@/lib/billing/plans"
import { useTrialStatus } from "@/hooks/use-trial-status"
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
	CardDescription,
} from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@maple/ui/components/ui/dialog"
import { FileIcon, PulseIcon, ChartLineIcon, CircleCheckIcon } from "@/components/icons"
import type { IconComponent } from "@/components/icons"

const FEATURE_ICONS: Record<string, IconComponent> = {
	logs: FileIcon,
	traces: PulseIcon,
	metrics: ChartLineIcon,
}

const HIDDEN_FEATURE_IDS = new Set<string>(["ai_input_tokens", "ai_output_tokens"])

function getPlanSlug(plan: Plan): string {
	if (plan.autoEnable) return "starter"
	const id = plan.id?.toLowerCase()
	if (id === "starter" || id === "startup") return id
	const name = plan.name?.toLowerCase()
	if (name === "starter" || name === "startup") return name
	return "startup"
}

function getPlanPrice(plan: Plan): {
	price: string
	interval?: string
} {
	if (plan.autoEnable) return { price: "$0" }
	if (plan.price) {
		return {
			price: `$${plan.price.amount}`,
			interval: plan.price.interval ? `/${plan.price.interval}` : undefined,
		}
	}
	return { price: plan.name }
}

function formatIncludedUsage(item: PlanItem): string {
	if (item.unlimited) return "Unlimited"
	if (item.included != null) {
		return `${Number(item.included)} GB`
	}
	return ""
}

function normalizeDetailText(text: string): string {
	return text.replace(/\bper\s+(?:[\d,]+\s+)?(?:logs?|traces?|metrics?)\b/i, "per GB")
}

function getFeatureRows(plan: Plan) {
	return plan.items
		.filter((item) => item.featureId && !HIDDEN_FEATURE_IDS.has(item.featureId))
		.map((item) => ({
			featureId: item.featureId,
			label: item.feature?.name ?? item.featureId,
			value: formatIncludedUsage(item),
			detail: item.display?.secondaryText ? normalizeDetailText(item.display.secondaryText) : undefined,
		}))
}

const ENTERPRISE_DATA_FEATURES = [
	{ featureId: "logs", label: "Logs", value: "Custom" },
	{ featureId: "traces", label: "Traces", value: "Custom" },
	{ featureId: "metrics", label: "Metrics", value: "Custom" },
]

function getScenario(plan: Plan): string {
	const eligibility = plan.customerEligibility
	if (!eligibility) return "new"
	if (eligibility.status === "active") return "active"
	if (eligibility.status === "scheduled") return "scheduled"
	return eligibility.attachAction === "upgrade"
		? "upgrade"
		: eligibility.attachAction === "downgrade"
			? "downgrade"
			: "new"
}

function getButtonConfig(plan: Plan) {
	const scenario = getScenario(plan)

	switch (scenario) {
		case "active":
			return {
				label: "Current plan",
				variant: "secondary" as const,
				disabled: true,
			}
		case "scheduled":
			return {
				label: "Scheduled",
				variant: "secondary" as const,
				disabled: true,
			}
		case "upgrade":
			return {
				label: "Upgrade",
				variant: "default" as const,
				disabled: false,
			}
		case "downgrade":
			return {
				label: "Downgrade",
				variant: "outline" as const,
				disabled: false,
			}
		default:
			return {
				label: "Subscribe",
				variant: "outline" as const,
				disabled: false,
			}
	}
}

const currencyFormatters = new Map<string, Intl.NumberFormat>()

function formatCurrency(amount: number, currency: string): string {
	const key = currency.toUpperCase()
	let formatter = currencyFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: key,
			minimumFractionDigits: 2,
		})
		currencyFormatters.set(key, formatter)
	}
	return formatter.format(amount)
}

interface CheckoutPreview {
	planId: string
	planName: string
	lines: { description: string; amount: number }[]
	total: number
	currency: string
	nextCycle?: { starts_at: number; total: number }
}

export function PricingCards() {
	const { data: plans, isLoading, error } = useListPlans()
	const { attach, previewAttach, refetch } = useCustomer()
	const { isTrialing, daysRemaining } = useTrialStatus()
	const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null)
	const [confirmDialog, setConfirmDialog] = useState<CheckoutPreview | null>(null)
	const [isAttaching, setIsAttaching] = useState(false)

	if (isLoading) {
		return (
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{Array.from({ length: 2 }).map((_, i) => (
					<Card key={i}>
						<CardHeader>
							<Skeleton className="h-3 w-16" />
							<Skeleton className="mt-2 h-7 w-24" />
							<Skeleton className="mt-1 h-3 w-32" />
						</CardHeader>
						<CardContent className="space-y-3">
							<Skeleton className="h-3 w-20" />
							{Array.from({ length: 3 }).map((_, j) => (
								<Skeleton key={j} className="h-4 w-full" />
							))}
							<Skeleton className="mt-2 h-px w-full" />
							<Skeleton className="h-3 w-24" />
							{Array.from({ length: 6 }).map((_, j) => (
								<Skeleton key={`f${j}`} className="h-3.5 w-full" />
							))}
						</CardContent>
						<CardFooter>
							<Skeleton className="h-8 w-full" />
						</CardFooter>
					</Card>
				))}
			</div>
		)
	}

	if (error || !plans) {
		return <p className="text-muted-foreground text-sm">Unable to load pricing plans.</p>
	}

	// Filter out add-on and auto-enabled (free) plans for the main grid
	const visiblePlans = plans.filter((p) => !p.addOn && !p.autoEnable)

	async function handleCheckout(planId: string) {
		const plan = plans?.find((p) => p.id === planId)
		const scenario = plan ? getScenario(plan) : "new"

		// For upgrades/downgrades, show a preview first
		if (scenario === "upgrade" || scenario === "downgrade") {
			setLoadingPlanId(planId)
			try {
				const preview = await previewAttach({ planId })
				setConfirmDialog({
					planId,
					planName: plan?.name ?? planId,
					lines: preview.lineItems.map((l) => ({
						description: l.description,
						amount: l.total,
					})),
					total: preview.total,
					currency: preview.currency,
					nextCycle: preview.nextCycle
						? { starts_at: preview.nextCycle.startsAt, total: preview.nextCycle.total }
						: undefined,
				})
			} catch (err) {
				const message = err instanceof Error ? err.message : "Something went wrong. Please try again."
				toast.error(message)
			} finally {
				setLoadingPlanId(null)
			}
			return
		}

		// For new subscriptions, attach directly (redirects to checkout if needed)
		setLoadingPlanId(planId)
		try {
			const result = await attach({ planId })

			if (result.paymentUrl) {
				window.location.href = result.paymentUrl
				return
			}

			toast.success("Plan updated successfully.")
			await refetch()
		} catch (err) {
			const message = err instanceof Error ? err.message : "Something went wrong. Please try again."
			toast.error(message)
		} finally {
			setLoadingPlanId(null)
		}
	}

	async function handleConfirmAttach() {
		if (!confirmDialog) return
		setIsAttaching(true)
		try {
			const result = await attach({ planId: confirmDialog.planId })
			if (result.paymentUrl) {
				window.location.href = result.paymentUrl
				return
			}
			toast.success("Plan updated successfully.")
			await refetch()
			setConfirmDialog(null)
		} catch (err) {
			const message = err instanceof Error ? err.message : "Something went wrong. Please try again."
			toast.error(message)
		} finally {
			setIsAttaching(false)
		}
	}

	function handleEnterpriseContact() {
		window.open(
			"https://cal.com/david-granzin/30min?overlayCalendar=true",
			"_blank",
			"noopener,noreferrer",
		)
	}

	const enterprisePlanFeatures = getPlanFeatures("enterprise")

	return (
		<div className="space-y-6">
			{/* Normal Plans Grid */}
			<div
				className={cn(
					"grid grid-cols-1 gap-4",
					visiblePlans.length === 2 && "sm:grid-cols-2",
					visiblePlans.length >= 3 && "sm:grid-cols-3",
				)}
			>
				{visiblePlans.map((plan) => {
					const scenario = getScenario(plan)
					const isActive = scenario === "active"
					const isUpgrade = !isActive && scenario === "upgrade"
					const { price, interval } = getPlanPrice(plan)
					const features = getFeatureRows(plan)
					const planFeatures = getPlanFeatures(getPlanSlug(plan))
					const btn = getButtonConfig(plan)
					const trialAvailable = plan.customerEligibility?.trialAvailable

					return (
						<Card
							key={plan.id}
							className={cn(
								"flex flex-col transition-colors",
								isActive && "bg-muted/40",
								isUpgrade && "bg-muted/30 ring-1 ring-primary/30",
							)}
						>
							<CardHeader>
								<div className="flex items-center justify-between gap-2">
									<CardTitle
										className={cn(
											"text-[10px] font-medium uppercase tracking-[0.14em]",
											isUpgrade ? "text-primary" : "text-muted-foreground",
										)}
									>
										{plan.name}
									</CardTitle>
									{isActive && isTrialing && daysRemaining != null ? (
										<Badge variant="secondary" className="text-[10px] font-medium">
											Trial · {daysRemaining}d left
										</Badge>
									) : isActive ? (
										<Badge variant="secondary" className="text-[10px] font-medium">
											Current
										</Badge>
									) : isUpgrade ? (
										<Badge variant="secondary" className="text-[10px] font-medium text-primary">
											Recommended
										</Badge>
									) : null}
								</div>
								<div className="mt-3 flex items-baseline gap-1">
									<span className="text-3xl font-semibold tracking-tight tabular-nums">
										{price}
									</span>
									{interval && (
										<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider ml-1">
											{interval}
										</span>
									)}
								</div>
								<CardDescription className="mt-2 text-sm leading-relaxed text-muted-foreground">
									{plan.description ?? getPlanDescription(getPlanSlug(plan))}
								</CardDescription>
							</CardHeader>

							<CardContent className="flex flex-col gap-5 flex-1">
								{features.length > 0 && (
									<div>
										<div className="text-muted-foreground/70 mb-3 text-[10px] font-medium uppercase tracking-[0.14em]">
											Data included
										</div>
										<div className="space-y-2.5">
											{features.map((feature) => {
												const Icon = FEATURE_ICONS[feature.featureId]
												return (
													<div
														key={feature.featureId}
														className="flex items-center justify-between text-sm"
													>
														<div className="text-muted-foreground flex items-center gap-2.5">
															{Icon && <Icon className="size-4 opacity-70" />}
															<span className="font-medium">
																{feature.label}
															</span>
														</div>
														<div className="text-right">
															<span className="font-semibold tabular-nums text-foreground">
																{feature.value}
															</span>
															{feature.detail && (
																<p className="text-muted-foreground/70 text-[10px] mt-0.5 font-medium">
																	{feature.detail}
																</p>
															)}
														</div>
													</div>
												)
											})}
										</div>
									</div>
								)}

								<Separator className="bg-border/60" />

								<div>
									<div className="text-muted-foreground/70 mb-3 text-[10px] font-medium uppercase tracking-[0.14em]">
										Platform features
									</div>
									<div className="space-y-2.5">
										{planFeatures.map((feature) => (
											<div
												key={feature.label}
												className="flex items-start gap-2.5 text-sm"
											>
												<CircleCheckIcon className="text-primary size-4 shrink-0 mt-0.5" />
												<span className="text-muted-foreground leading-snug">
													{feature.label}
												</span>
												{feature.value && (
													<span className="font-semibold tabular-nums text-xs ml-auto shrink-0">
														{feature.value}
													</span>
												)}
											</div>
										))}
									</div>
								</div>
							</CardContent>

							<CardFooter className="mt-auto flex-col gap-2 items-stretch">
								<Button
									variant={trialAvailable && !btn.disabled ? "default" : btn.variant}
									disabled={btn.disabled || loadingPlanId === plan.id}
									className="w-full font-medium"
									onClick={() => handleCheckout(plan.id)}
								>
									{loadingPlanId === plan.id ? (
										<Spinner className="size-4" />
									) : trialAvailable && !btn.disabled ? (
										`Start ${plan.freeTrial?.durationLength ?? TRIAL_DURATION_DAYS}-day trial`
									) : isActive && isTrialing ? (
										"Trialing"
									) : (
										btn.label
									)}
								</Button>
								{trialAvailable && !btn.disabled && (
									<p className="text-[11px] text-muted-foreground text-center tabular-nums">
										$0 due today · Card required · Cancel anytime
									</p>
								)}
							</CardFooter>
						</Card>
					)
				})}
			</div>

			{/* Enterprise tonal band */}
			<section className="rounded-lg border border-border/60 bg-background">
				<div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between">
					<div className="max-w-xl space-y-2">
						<div className="text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
							Enterprise
						</div>
						<div className="text-2xl font-semibold tracking-tight tabular-nums">Custom</div>
						<p className="text-sm text-muted-foreground leading-relaxed">
							Built for high-volume teams with custom compliance, data retention, and dedicated
							support requirements.
						</p>
					</div>
					<Button
						variant="default"
						className="w-full sm:w-auto shrink-0"
						onClick={handleEnterpriseContact}
					>
						Talk to founder
					</Button>
				</div>
				<div className="border-t border-border/60 grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
					<div className="p-6">
						<div className="text-muted-foreground/70 mb-3 text-[10px] font-medium uppercase tracking-[0.14em]">
							Data included
						</div>
						<div className="space-y-2.5">
							{ENTERPRISE_DATA_FEATURES.map((feature) => {
								const Icon = FEATURE_ICONS[feature.featureId]
								return (
									<div
										key={feature.featureId}
										className="flex items-center justify-between gap-4 text-sm"
									>
										<div className="text-muted-foreground flex items-center gap-2.5">
											{Icon && <Icon className="size-4 opacity-70" />}
											<span className="font-medium">{feature.label}</span>
										</div>
										<span className="font-semibold tabular-nums text-foreground">
											{feature.value}
										</span>
									</div>
								)
							})}
						</div>
					</div>
					<div className="p-6">
						<div className="text-muted-foreground/70 mb-3 text-[10px] font-medium uppercase tracking-[0.14em]">
							Platform features
						</div>
						<div className="space-y-2.5">
							{enterprisePlanFeatures.map((feature) => (
								<div key={feature.label} className="flex items-start gap-2.5 text-sm">
									<CircleCheckIcon className="text-primary size-4 shrink-0 mt-0.5" />
									<span className="text-muted-foreground leading-snug">
										{feature.label}
									</span>
									{feature.value && (
										<span className="font-semibold tabular-nums text-xs ml-auto shrink-0">
											{feature.value}
										</span>
									)}
								</div>
							))}
						</div>
					</div>
				</div>
			</section>

			<Dialog
				open={confirmDialog !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmDialog(null)
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Confirm plan change</DialogTitle>
						<DialogDescription>
							You're switching to{" "}
							<span className="text-foreground font-medium">{confirmDialog?.planName}</span>.
						</DialogDescription>
					</DialogHeader>

					{confirmDialog && (
						<div className="space-y-2 text-xs">
							{confirmDialog.lines.map((line, i) => (
								<div key={i} className="flex justify-between">
									<span className="text-muted-foreground">{line.description}</span>
									<span className="tabular-nums">
										{formatCurrency(line.amount, confirmDialog.currency)}
									</span>
								</div>
							))}
							<Separator />
							<div className="flex justify-between font-medium">
								<span>Due today</span>
								<span className="tabular-nums">
									{formatCurrency(confirmDialog.total, confirmDialog.currency)}
								</span>
							</div>
							{confirmDialog.nextCycle && (
								<p className="text-muted-foreground text-xs">
									Then{" "}
									{formatCurrency(confirmDialog.nextCycle.total, confirmDialog.currency)}{" "}
									starting{" "}
									{new Date(confirmDialog.nextCycle.starts_at).toLocaleDateString()}
								</p>
							)}
						</div>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmDialog(null)}
							disabled={isAttaching}
						>
							Cancel
						</Button>
						<Button onClick={handleConfirmAttach} disabled={isAttaching}>
							{isAttaching ? <Spinner className="size-3.5" /> : "Confirm"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

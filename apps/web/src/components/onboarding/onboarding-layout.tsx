import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { cn } from "@maple/ui/lib/utils"
import { OnboardingOrgSwitcher, OnboardingUserMenu } from "./onboarding-header-actions"

export function OnboardingLayout({
	currentStep,
	totalSteps = 3,
	stepLabel,
	children,
}: {
	currentStep: number
	totalSteps?: number
	stepLabel?: string
	children: React.ReactNode
}) {
	return (
		<div className="relative min-h-screen bg-background flex flex-col overflow-hidden">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60"
				style={{
					background:
						"radial-gradient(60% 80% at 50% 0%, hsl(var(--primary) / 0.08) 0%, hsl(var(--primary) / 0.02) 45%, transparent 75%)",
				}}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_60%)]"
				style={{
					backgroundImage:
						"radial-gradient(circle at 1px 1px, hsl(var(--foreground) / 0.04) 1px, transparent 0)",
					backgroundSize: "24px 24px",
				}}
			/>

			<header className="relative z-10 flex items-center justify-between px-6 py-5 shrink-0">
				<div className="flex items-center gap-2.5">
					<MapleMark size={26} className="text-primary shrink-0" />
					<span className="text-base font-semibold tracking-tight">Maple</span>
				</div>

				<div className="flex items-center gap-1.5">
					{Array.from({ length: totalSteps }).map((_, i) => {
						const reached = i < currentStep
						return (
							<div key={i} className="flex h-1 w-7 items-center justify-center">
								<div
									className={cn(
										"h-full w-full origin-center overflow-hidden rounded-full bg-muted transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
										reached ? "scale-x-100" : "scale-x-[0.5714]",
									)}
								>
									<div
										className={cn(
											"h-full origin-left rounded-full bg-primary transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
											reached ? "scale-x-100" : "scale-x-0",
										)}
									/>
								</div>
							</div>
						)
					})}
				</div>

				<div className="flex items-center gap-3">
					<OnboardingOrgSwitcher />
					<span className="hidden text-sm text-muted-foreground tabular-nums sm:inline">
						{stepLabel ?? `Step ${currentStep} of ${totalSteps}`}
					</span>
					<OnboardingUserMenu />
				</div>
			</header>

			<main className="relative z-10 flex-1 flex flex-col">{children}</main>
		</div>
	)
}

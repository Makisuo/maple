import { motion } from "motion/react"
import { cn } from "@maple/ui/utils"
import {
	OnboardingOrgSwitcher,
	OnboardingUserMenu,
} from "./onboarding-header-actions"

const PIP_TRANSITION = { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const }

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
					<div className="size-7 rounded-md bg-primary shadow-sm shadow-primary/30" />
					<span className="text-base font-semibold tracking-tight">Maple</span>
				</div>

				<div className="flex items-center gap-1.5">
					{Array.from({ length: totalSteps }).map((_, i) => {
						const reached = i < currentStep
						return (
							<motion.div
								key={i}
								className={cn("h-1 rounded-full bg-muted overflow-hidden")}
								animate={{ width: reached ? 28 : 16 }}
								transition={PIP_TRANSITION}
							>
								<motion.div
									className="h-full bg-primary rounded-full origin-left"
									initial={false}
									animate={{ scaleX: reached ? 1 : 0 }}
									transition={PIP_TRANSITION}
								/>
							</motion.div>
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

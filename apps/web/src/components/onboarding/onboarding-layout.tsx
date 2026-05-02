import { cn } from "@maple/ui/utils"

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
		<div className="min-h-screen bg-background flex flex-col">
			<header className="flex items-center justify-between px-6 py-5 shrink-0">
				<div className="flex items-center gap-2.5">
					<div className="size-7 rounded-md bg-primary" />
					<span className="text-base font-semibold tracking-tight">Maple</span>
				</div>

				<div className="flex items-center gap-1.5">
					{Array.from({ length: totalSteps }).map((_, i) => (
						<div
							key={i}
							className={cn(
								"h-1 w-7 rounded-full transition-colors duration-300",
								i < currentStep ? "bg-primary" : "bg-muted",
							)}
						/>
					))}
				</div>

				<span className="text-sm text-muted-foreground tabular-nums">
					{stepLabel ?? `Step ${currentStep} of ${totalSteps}`}
				</span>
			</header>

			<main className="flex-1 flex flex-col">{children}</main>
		</div>
	)
}

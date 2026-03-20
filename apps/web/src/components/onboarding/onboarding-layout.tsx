import { cn } from "@maple/ui/utils"

const TOTAL_STEPS = 4

export function OnboardingLayout({
  currentStep,
  stepLabel,
  children,
}: {
  currentStep: number
  stepLabel?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-6 py-5 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-md bg-primary" />
          <span className="text-base font-semibold tracking-tight">Maple</span>
        </div>

        {/* Progress Bar */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "h-1 w-7 rounded-full transition-colors duration-300",
                i < currentStep ? "bg-primary" : "bg-muted",
              )}
            />
          ))}
        </div>

        {/* Step Label */}
        <span className="text-sm text-muted-foreground tabular-nums">
          {stepLabel ?? `Step ${currentStep} of ${TOTAL_STEPS}`}
        </span>
      </header>

      {/* Content */}
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  )
}

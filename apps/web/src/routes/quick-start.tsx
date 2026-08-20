import { useState, type ReactNode } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useAuth } from "@clerk/clerk-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { BootSplash } from "@/components/boot-splash"
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout"
import { QUALIFY_QUESTIONS, StepQualifyQuestion } from "@/components/onboarding/step-qualify"
import { StepPlan } from "@/components/onboarding/step-plan"
import { StepDemo } from "@/components/onboarding/step-demo"

import { useQuickStart, type StepId } from "@/hooks/use-quick-start"
import { hasLapsedPlan, hasSelectedPlan } from "@/lib/billing/plan-gating"
import { STEP_IDS, type RoleOption } from "@/atoms/quick-start-atoms"

export const Route = createFileRoute("/quick-start")({
	component: QuickStartPage,
})

export const STEP_MOTION = {
	duration: 0.28,
	ease: [0.16, 1, 0.3, 1] as const,
}

function QuickStartPage() {
	const { orgId } = useAuth()
	const {
		activeStep,
		setActiveStep,
		completeStep,
		isStepComplete,
		qualifyAnswers,
		setQualifyAnswers,
		setDemoDataRequested,
	} = useQuickStart(orgId)

	const { data: customer, isLoading: isCustomerLoading } = useMapleCustomer()
	const planSelected = hasSelectedPlan(customer)
	// A returning subscriber whose plan lapsed can still land here by bookmark or
	// back button. They have already onboarded, so send them to the app — the
	// reactivation banner there is what they need, not the new-user wizard.
	const planLapsed = hasLapsedPlan(customer)

	// "plan" completion is the live Autumn plan state, never a persisted flag.
	// A stale flag would disagree with __root.tsx's no-plan guard and trap the
	// user in an infinite /quick-start <-> / redirect loop that freezes the tab.
	const onboardingComplete = isStepComplete("role") && isStepComplete("demo") && planSelected

	const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
	const stepLabel = `Step ${currentStepNumber} of ${STEP_IDS.length}`

	// Track the previous step index for slide direction by adjusting state
	// during render — the documented React pattern for previous-render values.
	const [stepWindow, setStepWindow] = useState<[number, number]>([currentStepNumber, currentStepNumber])
	if (stepWindow[1] !== currentStepNumber) {
		setStepWindow([stepWindow[1], currentStepNumber])
	}
	const direction = currentStepNumber >= stepWindow[0] ? 1 : -1

	// Wait for the customer before rendering a step: deciding from an unsettled
	// query flashes "what's your role?" at a returning subscriber before the
	// bail-out below can fire.
	if (isCustomerLoading) {
		return <BootSplash />
	}

	if (onboardingComplete || planLapsed) {
		return <Navigate to="/" replace />
	}

	return (
		<OnboardingLayout currentStep={currentStepNumber} totalSteps={STEP_IDS.length} stepLabel={stepLabel}>
			<AnimatePresence mode="wait" custom={direction} initial={false}>
				{activeStep === "role" && (
					<MotionStep key="role" direction={direction}>
						<StepQualifyQuestion
							{...QUALIFY_QUESTIONS.role}
							value={qualifyAnswers.role}
							onSelect={(role: RoleOption) => setQualifyAnswers({ ...qualifyAnswers, role })}
							onContinue={() => completeStep("role")}
						/>
					</MotionStep>
				)}

				{activeStep === "demo" && (
					<MotionStep key="demo" direction={direction}>
						<StepDemo
							onComplete={() => completeStep("demo")}
							onRequestDemo={() => setDemoDataRequested(true)}
							onSkipDemo={() => setDemoDataRequested(false)}
							onBack={() => setActiveStep("role")}
						/>
					</MotionStep>
				)}

				{activeStep === "plan" && (
					<MotionStep key="plan" direction={direction}>
						<StepPlan onBack={() => setActiveStep("demo")} />
					</MotionStep>
				)}
			</AnimatePresence>
		</OnboardingLayout>
	)
}

function MotionStep({ children, direction }: { children: ReactNode; direction: number }) {
	const reduceMotion = useReducedMotion()
	return (
		<motion.div
			custom={direction}
			initial={{ opacity: 0, x: reduceMotion ? 0 : direction * 24 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: reduceMotion ? 0 : direction * -24 }}
			transition={reduceMotion ? { duration: 0 } : STEP_MOTION}
			className="flex flex-1 flex-col"
		>
			{children}
		</motion.div>
	)
}

import { useState } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useAuth } from "@clerk/clerk-react"
import { AnimatePresence, motion } from "motion/react"
import { useCustomer } from "autumn-js/react"

import { OnboardingLayout } from "@/components/onboarding/onboarding-layout"
import {
	QUALIFY_QUESTIONS,
	StepQualifyQuestion,
} from "@/components/onboarding/step-qualify"
import { StepPlan } from "@/components/onboarding/step-plan"
import { StepDemo } from "@/components/onboarding/step-demo"

import { useQuickStart, type StepId } from "@/hooks/use-quick-start"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
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

	const { data: customer } = useCustomer()
	const planSelected = hasSelectedPlan(customer)

	// "plan" completion is the live Autumn plan state, never a persisted flag.
	// A stale flag would disagree with __root.tsx's no-plan guard and trap the
	// user in an infinite /quick-start <-> / redirect loop that freezes the tab.
	const onboardingComplete =
		isStepComplete("role") && isStepComplete("demo") && planSelected

	const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
	const stepLabel = `Step ${currentStepNumber} of ${STEP_IDS.length}`

	// Track the previous step index for slide direction by adjusting state
	// during render — the documented React pattern for previous-render values.
	const [stepWindow, setStepWindow] = useState<[number, number]>([
		currentStepNumber,
		currentStepNumber,
	])
	if (stepWindow[1] !== currentStepNumber) {
		setStepWindow([stepWindow[1], currentStepNumber])
	}
	const direction = currentStepNumber >= stepWindow[0] ? 1 : -1

	if (onboardingComplete) {
		return <Navigate to="/" replace />
	}

	return (
		<OnboardingLayout
			currentStep={currentStepNumber}
			totalSteps={STEP_IDS.length}
			stepLabel={stepLabel}
		>
			<AnimatePresence mode="wait" custom={direction} initial={false}>
				{activeStep === "role" && (
					<MotionStep key="role" direction={direction}>
						<StepQualifyQuestion
							{...QUALIFY_QUESTIONS.role}
							value={qualifyAnswers.role}
							onSelect={(role: RoleOption) =>
								setQualifyAnswers({ ...qualifyAnswers, role })
							}
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

function MotionStep({
	children,
	direction,
}: {
	children: React.ReactNode
	direction: number
}) {
	return (
		<motion.div
			custom={direction}
			initial={{ opacity: 0, x: direction * 24 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: direction * -24 }}
			transition={STEP_MOTION}
			className="flex-1 flex flex-col"
		>
			{children}
		</motion.div>
	)
}

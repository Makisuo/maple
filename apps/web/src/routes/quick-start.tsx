import { useEffect, useRef } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
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
	const navigate = useNavigate()
	const {
		activeStep,
		setActiveStep,
		completeStep,
		uncompleteStep,
		isStepComplete,
		isComplete,
		qualifyAnswers,
		setQualifyAnswers,
		setDemoDataRequested,
	} = useQuickStart(orgId)

	const { data: customer } = useCustomer()
	const planSelected = hasSelectedPlan(customer)

	// The "plan" step's completion must mirror the live Autumn plan state.
	// If it goes stale (persisted true with no active plan), __root.tsx bounces
	// the user back here forever — an infinite redirect loop that freezes the tab.
	useEffect(() => {
		if (planSelected && !isStepComplete("plan")) {
			completeStep("plan")
		} else if (!planSelected && isStepComplete("plan")) {
			uncompleteStep("plan")
			if (activeStep !== "plan") {
				setActiveStep("plan")
			}
		}
	}, [planSelected, activeStep, isStepComplete, completeStep, uncompleteStep, setActiveStep])

	useEffect(() => {
		if (isComplete) {
			navigate({ to: "/" })
		}
	}, [isComplete, navigate])

	const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
	const stepLabel = `Step ${currentStepNumber} of ${STEP_IDS.length}`

	const previousStepIndexRef = useRef(currentStepNumber)
	const direction =
		currentStepNumber >= previousStepIndexRef.current ? 1 : -1

	useEffect(() => {
		previousStepIndexRef.current = currentStepNumber
	}, [currentStepNumber])

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

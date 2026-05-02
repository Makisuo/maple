import { useEffect } from "react"
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

function QuickStartPage() {
	const { orgId } = useAuth()
	const navigate = useNavigate()
	const {
		activeStep,
		setActiveStep,
		completeStep,
		isStepComplete,
		isComplete,
		qualifyAnswers,
		setQualifyAnswers,
		setDemoDataRequested,
	} = useQuickStart(orgId)

	useEffect(() => {
		if (isComplete) {
			navigate({ to: "/" })
		}
	}, [isComplete, navigate])

	const { data: customer } = useCustomer()
	const planSelected = hasSelectedPlan(customer)

	useEffect(() => {
		if (activeStep !== "plan") return
		if (!planSelected) return
		completeStep("plan")
	}, [activeStep, planSelected, completeStep])

	useEffect(() => {
		if (activeStep === "plan" || isStepComplete("plan")) return
		if (planSelected) {
			completeStep("plan")
		}
	}, [activeStep, planSelected, isStepComplete, completeStep])

	const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
	const stepLabel = `Step ${currentStepNumber} of ${STEP_IDS.length}`

	return (
		<OnboardingLayout
			currentStep={currentStepNumber}
			totalSteps={STEP_IDS.length}
			stepLabel={stepLabel}
		>
			<AnimatePresence mode="wait">
				{activeStep === "role" && (
					<MotionStep key="role">
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
					<MotionStep key="demo">
						<StepDemo
							onComplete={() => completeStep("demo")}
							onRequestDemo={() => setDemoDataRequested(true)}
							onSkipDemo={() => setDemoDataRequested(false)}
							onBack={() => setActiveStep("role")}
						/>
					</MotionStep>
				)}

				{activeStep === "plan" && (
					<MotionStep key="plan">
						<StepPlan
							isComplete={isStepComplete("plan")}
							onComplete={() => completeStep("plan")}
							onBack={() => setActiveStep("demo")}
						/>
					</MotionStep>
				)}
			</AnimatePresence>
		</OnboardingLayout>
	)
}

function MotionStep({ children }: { children: React.ReactNode }) {
	return (
		<motion.div
			initial={{ opacity: 0, x: 20 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: -20 }}
			transition={{ duration: 0.3, ease: "easeInOut" }}
			className="flex-1 flex flex-col"
		>
			{children}
		</motion.div>
	)
}

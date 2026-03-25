import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useAuth } from "@clerk/clerk-react"
import { AnimatePresence, motion } from "motion/react"
import { useCustomer } from "autumn-js/react"

import { OnboardingLayout } from "@/components/onboarding/onboarding-layout"
import { StepWelcome } from "@/components/onboarding/step-welcome"
import { StepConnect } from "@/components/onboarding/step-connect"
import { StepListening } from "@/components/onboarding/step-listening"
import { StepPlan } from "@/components/onboarding/step-plan"

import { useQuickStart, type StepId } from "@/hooks/use-quick-start"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { STEP_IDS } from "@/atoms/quick-start-atoms"

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
    selectedFramework,
    setSelectedFramework,
  } = useQuickStart(orgId)

  // Redirect to dashboard when all steps are complete
  useEffect(() => {
    if (isComplete) {
      navigate({ to: "/" })
    }
  }, [isComplete, navigate])

  // Fetch API keys
  const keysResult = useAtomValue(
    MapleApiAtomClient.query("ingestKeys", "get", {}),
  )
  const apiKey = Result.isSuccess(keysResult) ? keysResult.value.publicKey : "Loading..."

  // Auto-complete plan step when plan is selected
  const { data: customer } = useCustomer()
  useEffect(() => {
    if (isStepComplete("plan")) return
    if (hasSelectedPlan(customer)) {
      completeStep("plan")
    }
  }, [customer])

  const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
  const stepLabel =
    activeStep === "listening" && isStepComplete("listening")
      ? "Complete"
      : `Step ${currentStepNumber} of 4`

  return (
    <OnboardingLayout currentStep={currentStepNumber} stepLabel={stepLabel}>
      <AnimatePresence mode="wait">
        {activeStep === "welcome" && (
          <MotionStep key="welcome">
            <StepWelcome
              selectedFramework={selectedFramework}
              onSelectFramework={setSelectedFramework}
              onContinue={() => {
                completeStep("welcome")
              }}
            />
          </MotionStep>
        )}

        {activeStep === "connect" && (
          <MotionStep key="connect">
            <StepConnect
              framework={selectedFramework ?? "nodejs"}
              ingestUrl={ingestUrl}
              apiKey={apiKey}
              onBack={() => setActiveStep("welcome")}
              onContinue={() => {
                completeStep("connect")
              }}
            />
          </MotionStep>
        )}

        {activeStep === "listening" && (
          <MotionStep key="listening">
            <StepListening
              isComplete={isStepComplete("listening")}
              onComplete={() => {
                completeStep("listening")
              }}
              onSkip={() => {
                completeStep("listening")
              }}
            />
          </MotionStep>
        )}

        {activeStep === "plan" && (
          <MotionStep key="plan">
            <StepPlan
              isComplete={isStepComplete("plan")}
              onComplete={() => {
                completeStep("plan")
              }}
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

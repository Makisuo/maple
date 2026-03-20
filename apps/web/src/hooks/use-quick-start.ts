import { useCallback } from "react"
import { useAtom } from "@/lib/effect-atom"
import type { FrameworkId } from "@/components/quick-start/sdk-snippets"
import {
  quickStartAtomFamily,
  STEP_IDS,
  type StepId,
} from "@/atoms/quick-start-atoms"

export type { StepId }

export function useQuickStart(orgId?: string | null) {
  const key = orgId ?? "default"
  const [state, setState] = useAtom(quickStartAtomFamily(key))

  const setActiveStep = useCallback(
    (id: StepId) => {
      setState((prev) => ({ ...prev, activeStep: id }))
    },
    [setState],
  )

  const completeStep = useCallback(
    (id: StepId) => {
      setState((prev) => {
        // Auto-advance to next step if not complete
        const currentIndex = STEP_IDS.indexOf(id)
        const nextStep =
          currentIndex < STEP_IDS.length - 1
            ? STEP_IDS[currentIndex + 1]
            : prev.activeStep

        return {
          ...prev,
          completedSteps: { ...prev.completedSteps, [id]: true },
          activeStep: nextStep,
        }
      })
    },
    [setState],
  )

  const uncompleteStep = useCallback(
    (id: StepId) => {
      setState((prev) => {
        const { [id]: _, ...rest } = prev.completedSteps
        return { ...prev, completedSteps: rest }
      })
    },
    [setState],
  )

  const setSelectedFramework = useCallback(
    (framework: FrameworkId) => {
      setState((prev) => ({ ...prev, selectedFramework: framework }))
    },
    [setState],
  )

  const dismiss = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: true }))
  }, [setState])

  const undismiss = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: false }))
  }, [setState])

  const reset = useCallback(() => {
    setState({
      completedSteps: {},
      dismissed: false,
      selectedFramework: null,
      activeStep: "welcome",
    })
  }, [setState])

  const isStepComplete = useCallback(
    (id: StepId) => !!state.completedSteps[id],
    [state.completedSteps],
  )

  const completedCount = STEP_IDS.filter(
    (id) => state.completedSteps[id],
  ).length
  const totalSteps = STEP_IDS.length
  const progressPercent = Math.round((completedCount / totalSteps) * 100)
  const isDismissed = state.dismissed
  const isComplete = completedCount === totalSteps

  return {
    activeStep: state.activeStep as StepId,
    setActiveStep,
    completeStep,
    uncompleteStep,
    dismiss,
    undismiss,
    reset,
    isStepComplete,
    completedCount,
    totalSteps,
    progressPercent,
    isDismissed,
    isComplete,
    selectedFramework: state.selectedFramework as FrameworkId | null,
    setSelectedFramework,
  }
}

import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export const STEP_IDS = ["welcome", "connect", "listening", "plan"] as const

export type StepId = (typeof STEP_IDS)[number]
export interface QuickStartState {
	completedSteps: Record<string, boolean>
	dismissed: boolean
	selectedFramework: string | null
	activeStep: string
}

const QuickStartSchema = Schema.Struct({
	completedSteps: Schema.Record(Schema.String, Schema.Boolean),
	dismissed: Schema.Boolean,
	selectedFramework: Schema.NullOr(Schema.String),
	activeStep: Schema.String,
}) as Schema.Codec<QuickStartState>

const DEFAULT_STATE: QuickStartState = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "welcome",
}

export const quickStartAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-v2-${orgId}`,
		schema: QuickStartSchema,
		defaultValue: () => DEFAULT_STATE,
	}),
)

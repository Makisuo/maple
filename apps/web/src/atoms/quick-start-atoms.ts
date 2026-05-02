import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export const STEP_IDS = ["role", "demo", "plan"] as const

export type StepId = (typeof STEP_IDS)[number]

export const ROLE_OPTIONS = ["engineer", "devops_sre", "eng_leader", "founder"] as const
export type RoleOption = (typeof ROLE_OPTIONS)[number]

export interface QualifyAnswers {
	role: RoleOption | null
}

export interface QuickStartState {
	completedSteps: Record<string, boolean>
	dismissed: boolean
	selectedFramework: string | null
	activeStep: string
	qualifyAnswers: QualifyAnswers
	demoDataRequested: boolean
	checklistDismissed: boolean
	checklistExpanded: boolean
	firstActionHintDismissed: boolean
}

const QualifyAnswersSchema = Schema.Struct({
	role: Schema.NullOr(Schema.String),
})

const QuickStartSchema = Schema.Struct({
	completedSteps: Schema.Record(Schema.String, Schema.Boolean),
	dismissed: Schema.Boolean,
	selectedFramework: Schema.NullOr(Schema.String),
	activeStep: Schema.String,
	qualifyAnswers: QualifyAnswersSchema,
	demoDataRequested: Schema.Boolean,
	checklistDismissed: Schema.Boolean,
	checklistExpanded: Schema.Boolean,
	firstActionHintDismissed: Schema.Boolean,
}) as Schema.Codec<QuickStartState>

export const DEFAULT_QUICK_START_STATE: QuickStartState = {
	completedSteps: {},
	dismissed: false,
	selectedFramework: null,
	activeStep: "role",
	qualifyAnswers: { role: null },
	demoDataRequested: false,
	checklistDismissed: false,
	checklistExpanded: true,
	firstActionHintDismissed: false,
}

export const quickStartAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-v6-${orgId}`,
		schema: QuickStartSchema,
		defaultValue: () => DEFAULT_QUICK_START_STATE,
	}),
)

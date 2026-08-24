// The funnel definition vocabulary shared by the dashboard funnel widget and
// the step builder it mounts.
//
// A definition is `steps` + `keyBy` + `windowSeconds` (+ optional
// `breakdownBy`), exactly the option bag `productEventsFunnelQuery` takes; the
// wire schemas live in `@maple/query-model` and are reused here unchanged so a
// widget's stored config and an API request decode the same shape.

import {
	FUNNEL_MAX_STEPS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	FunnelSessionDimension,
	type FunnelBreakdownBy as FunnelBreakdownByType,
	type FunnelKeyBy as FunnelKeyByType,
	type FunnelSessionDimension as FunnelSessionDimensionType,
	type FunnelStep as FunnelStepType,
} from "@maple/query-model"

export type {
	FunnelBreakdownByType as FunnelBreakdownBy,
	FunnelSessionDimensionType as FunnelSessionDimension,
}

export { FUNNEL_MAX_STEPS }

export const DEFAULT_FUNNEL_KEY_BY: FunnelKeyByType = "person"
export const DEFAULT_FUNNEL_WINDOW_SECONDS = 24 * 3600

export const FUNNEL_WINDOW_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
	{ value: 3600, label: "1 hour" },
	{ value: 24 * 3600, label: "24 hours" },
	{ value: 7 * 24 * 3600, label: "7 days" },
	{ value: 30 * 24 * 3600, label: "30 days" },
]

export const FUNNEL_KEY_BY_OPTIONS: ReadonlyArray<{
	readonly value: FunnelKeyByType
	readonly label: string
	readonly description: string
}> = [
	{
		value: "person",
		label: "Person",
		description:
			"User id when known, else the visitor — anonymous and signed-in activity collapse into one.",
	},
	{ value: "visitor", label: "Visitor", description: "The browser's anonymous visitor id." },
	{ value: "user", label: "User", description: "Identified users only." },
	{
		value: "session",
		label: "Session",
		description: "Each session on its own; server events take no part.",
	},
]

export { FUNNEL_SESSION_DIMENSION_LABEL }

export const FUNNEL_SESSION_DIMENSIONS: ReadonlyArray<FunnelSessionDimensionType> =
	FunnelSessionDimension.literals

/** A fresh event step; the builder's default when a step is added. */
export const emptyEventStep = (): FunnelStepType => ({ kind: "event", eventName: "" })

/** Steps with something to match on. A blank event name is a step still being typed. */
export const completedSteps = (steps: ReadonlyArray<FunnelStepType>): ReadonlyArray<FunnelStepType> =>
	steps.filter((step) => {
		switch (step.kind) {
			case "event":
				return step.eventName.trim() !== ""
			case "page":
				return step.pagePath.trim() !== ""
			case "session":
				return step.value.trim() !== ""
		}
	})


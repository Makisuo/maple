// The funnel definition vocabulary shared by the /analytics Funnels view, the
// dashboard funnel widget and the step builder they both mount.
//
// A definition is `steps` + `keyBy` + `windowSeconds` (+ optional
// `breakdownBy`), exactly the option bag `productEventsFunnelQuery` takes; the
// wire schemas live in `@maple/query-model` and are reused here unchanged so a
// URL, a widget's stored config and an API request all decode the same shape.

import { Schema } from "effect"
import {
	FUNNEL_MAX_STEPS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelSessionDimension,
	FunnelStep,
	funnelStepLabel,
	type FunnelBreakdownBy as FunnelBreakdownByType,
	type FunnelKeyBy as FunnelKeyByType,
	type FunnelSessionDimension as FunnelSessionDimensionType,
	type FunnelStep as FunnelStepType,
} from "@maple/query-model"

export type { FunnelStepType as FunnelStep, FunnelKeyByType as FunnelKeyBy }
export type {
	FunnelBreakdownByType as FunnelBreakdownBy,
	FunnelSessionDimensionType as FunnelSessionDimension,
}

export { FUNNEL_MAX_STEPS }

export interface FunnelDefinition {
	readonly steps: ReadonlyArray<FunnelStepType>
	readonly keyBy: FunnelKeyByType
	readonly windowSeconds: number
	readonly breakdownBy?: FunnelBreakdownByType
}

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

/** URL search-param fields for the /analytics Funnels view. Spread into `validateSearch`. */
export const funnelSearchFields = {
	view: Schema.optional(Schema.Literals(["overview", "funnels"])),
	steps: Schema.optional(Schema.Array(FunnelStep)),
	keyBy: Schema.optional(FunnelKeyBy),
	window: Schema.optional(Schema.Number),
	breakdown: Schema.optional(FunnelBreakdownBy),
} as const

export type AnalyticsView = "overview" | "funnels"

/** Read a definition off the route's decoded search object, defaults filled in. */
export const funnelFromSearch = (search: {
	readonly steps?: ReadonlyArray<FunnelStepType>
	readonly keyBy?: FunnelKeyByType
	readonly window?: number
	readonly breakdown?: FunnelBreakdownByType
}): FunnelDefinition => ({
	steps: search.steps ?? [],
	keyBy: search.keyBy ?? DEFAULT_FUNNEL_KEY_BY,
	windowSeconds:
		search.window !== undefined && Number.isFinite(search.window) && search.window > 0
			? search.window
			: DEFAULT_FUNNEL_WINDOW_SECONDS,
	...(search.breakdown !== undefined ? { breakdownBy: search.breakdown } : undefined),
})

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

/** Human label for a step — the bar label in the chart and the row label in the table. */
export const stepLabel = funnelStepLabel

/** What the breakdown select shows for a `breakdownBy` value. */
export const breakdownLabel = (breakdownBy: FunnelBreakdownByType): string =>
	breakdownBy.startsWith("attribute:")
		? `attribute ${breakdownBy.slice("attribute:".length)}`
		: FUNNEL_SESSION_DIMENSION_LABEL[breakdownBy as FunnelSessionDimensionType]

/** Encode a definition into the search-param fields (empty steps drop the keys). */
export const funnelToSearch = (definition: FunnelDefinition) => ({
	steps: definition.steps.length > 0 ? definition.steps : undefined,
	keyBy: definition.keyBy === DEFAULT_FUNNEL_KEY_BY ? undefined : definition.keyBy,
	window: definition.windowSeconds === DEFAULT_FUNNEL_WINDOW_SECONDS ? undefined : definition.windowSeconds,
	breakdown: definition.breakdownBy,
})

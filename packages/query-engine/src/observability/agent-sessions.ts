import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type {
	AgentSessionsFacetsOutput,
	AgentSessionsListOutput,
	AgentTracesListOutput,
} from "../ch/queries/agent-sessions"

/**
 * The shared filter payload for the Agent Sessions feature — one shape feeds
 * the sessions list, the raw AI-traces list, and both tabs' facets, so the
 * sidebar counts can never mean something different from the rows.
 *
 * `vendors`/`serviceNames` are containment filters: "has at least one matching
 * AI span". Classification is per-span and multi-vendor traces are the norm
 * (a CrewAI orchestration span parenting openinference-instrumented OpenAI
 * calls), so exact-match semantics would be a lie.
 */
export interface AgentSessionsFilterInput {
	readonly startTime: string
	readonly endTime: string
	/** Vendor slugs from `@maple/domain` `AI_VENDORS`, including `unknown:*`. */
	readonly vendors?: readonly string[]
	readonly serviceNames?: readonly string[]
	readonly hasErrors?: boolean
}

export interface ListAgentSessionsInput extends AgentSessionsFilterInput {
	readonly limit?: number
	readonly offset?: number
}

/**
 * List AI agent sessions: spans whose classified session key resolved at
 * session granularity, grouped by key hash and ordered by latest activity.
 * Counts cover only the key-carrying spans — resolving a session's full traces
 * and display key is the detail read's job.
 */
export const listAgentSessions = Effect.fn("Observability.listAgentSessions")(function* (
	input: ListAgentSessionsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.agentSessionsListQuery({
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list", context: "listAgentSessions" })
})

export interface ListAgentTracesInput extends AgentSessionsFilterInput {
	readonly limit?: number
	readonly offset?: number
}

/**
 * List raw AI traces: every AI-classified span at any session-key state,
 * grouped by trace. This is the companion tab to `listAgentSessions` — spans
 * that never resolved a session key (`bestSessionKeyState < 6`) only surface
 * here, with the state explaining why.
 */
export const listAgentTraces = Effect.fn("Observability.listAgentTraces")(function* (
	input: ListAgentTracesInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.agentTracesListQuery({
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list", context: "listAgentTraces" })
})

export interface AgentSessionsFacetsInput extends AgentSessionsFilterInput {
	/** Counting unit: distinct sessions or distinct traces — match the open tab. */
	readonly tab: "sessions" | "traces"
}

/**
 * Facet counts (vendor / service / has-errors) for the quickfilter sidebar,
 * counted per session or per trace to match the open tab. Each dimension's own
 * selection is excluded from its branch so it doesn't collapse to one option.
 */
export const agentSessionsFacets = Effect.fn("Observability.agentSessionsFacets")(function* (
	input: AgentSessionsFacetsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compileUnion(
		CH.agentSessionsFacetsQuery({
			tab: input.tab,
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, {
		profile: "list",
		context: "agentSessionsFacets",
	})
})

/**
 * The vocabulary a turn speaks: what goes in, what comes out, and what one step carries.
 *
 * Separate from `turn.ts` so the loop's control flow reads as control flow. Everything here is data
 * plus two small stamping helpers; nothing here decides anything.
 */
import type { ChatEvent, ChatTaskRef } from "@maple/domain/chat-session"
import type { AnyTool, FinishReason, Message, Model, Usage } from "@maple/llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import type { McpToolExecutorApi } from "@/mcp/dispatcher"
import type { AgentDefinition } from "../agents"
import type { StepRetryBudget, TaskBudget } from "./budgets"
import type { DoomLoopState } from "./stop"

/** Distributive `Omit`, so each union member keeps its own shape. */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never

/**
 * Events this turn wants appended to the session log. `seq` is assigned by the Durable Object,
 * which owns the ordering, so the loop emits everything without one. `user-message` is excluded:
 * the session records the user turn at submission time, before the loop runs.
 */
export type ChatTurnEvent = WithoutSeq<Exclude<ChatEvent, { type: "user-message" }>>

/**
 * The one tool a turn can *answer through*, supplied as a single value.
 *
 * The name and the implementation used to arrive separately — a `Tools` record merged into the
 * turn's tool map, plus a `closingSubmit: { toolName }` naming which key of it closes the turn — and
 * nothing tied the two together. Every disagreement between them was silent and shipped: the
 * investigation chat session supplied `submit_diagnosis` and no closing name, so an investigation
 * that spent its whole step budget reached the tool-less closing step, answered in prose, and left
 * `investigations.diagnosis` null. A name with no matching tool was equally representable and simply
 * fell back to the prose closing step.
 *
 * Absent means the turn has no structured answer at all — plain attended chat. Present means exactly
 * this tool, under exactly this name, is offered to the model.
 *
 * `closes` is the remaining choice, and it is required rather than defaulted so no caller can make
 * it by omission:
 *
 *   - `true` — the turn's answer *is* this call. The step that closes a cut-short turn carries this
 *     one tool with `toolChoice` forcing it, a step that produced prose instead of calling it is
 *     asked once more through it, and the call itself ends the turn. Headless passes.
 *   - `false` — the tool is merely available. The turn closes in prose like any attended one, and a
 *     call to it is dispatched and then followed like any other tool result. This is what a human
 *     follow-up inside an investigation gets: it *may* file a superseding diagnosis, but a question
 *     about the existing one must not be answered by rewriting it.
 *
 * It is supplied by the caller rather than built inside the loop because its handler needs
 * `InvestigationService`, which would otherwise drag the service graph into the loop's imports.
 */
export interface TurnCompletion {
	/** The name the model sees, and the key it is registered under in the turn's tool map. */
	readonly name: string
	readonly tool: AnyTool
	/** Whether this call is the turn's answer, rather than one tool among many. */
	readonly closes: boolean
}

export interface ChatTurnInput {
	readonly sessionId: string
	readonly tenant: TenantContext
	/** Closed, tenant-mandatory MCP execution boundary captured by the caller's runtime. */
	readonly toolExecutor: McpToolExecutorApi
	readonly model: Model
	/** The full transcript so far, oldest first, already including the new user message. */
	readonly messages: ReadonlyArray<Message>
	readonly messageId: string
	/**
	 * The tool this turn answers *through*, if it has one. See {@link TurnCompletion}.
	 */
	readonly completion?: TurnCompletion
	/**
	 * Whether this turn still holds the session's turn slot.
	 *
	 * Checked between steps so an abort takes effect at the next boundary instead of only after the
	 * in-flight model call drains, and so a turn that has been superseded stops writing into a
	 * conversation that has moved on. Defaults to "always current" for callers with no session.
	 */
	readonly isCurrent?: () => boolean
	/**
	 * A *soft* stop, deliberately not `isCurrent`.
	 *
	 * `isCurrent` returning false is a real abort: the turn was superseded, the session already wrote
	 * a terminal event, and this turn must write nothing more. This is the other thing — "you are out
	 * of wall clock" — and the correct response to it is to finish by answering, not to vanish.
	 *
	 * Conflating the two is what made a headless pass that hit its deadline indistinguishable from
	 * one that found nothing: the loop returned an empty stream, the submit tool was never called,
	 * and the lane was recorded as a no-finding.
	 */
	readonly softStop?: () => boolean
	/** Accumulates this turn's token usage; see {@link TurnUsage}. */
	readonly usage?: TurnUsage
	/** Mutable outcome facts annotated on the enclosing `chat.turn` span by the session runner. */
	readonly observability?: TurnObservability
	/**
	 * Which agent this turn runs as. Defaults to the primary agent the session id names, so existing
	 * callers keep the behaviour their mode already had.
	 */
	readonly agent?: AgentDefinition
	/**
	 * Set when this turn is a sub-agent nested inside a parent turn: every event it produces is
	 * stamped with this ref, which is what routes them into the parent's task card rather than the
	 * top-level conversation.
	 */
	readonly task?: ChatTaskRef
	/** Nesting depth. 0 is the conversation's own turn. */
	readonly depth?: number
	/** Shared across the parent and every descendant; see {@link TaskBudget}. */
	readonly taskBudget?: TaskBudget
	/**
	 * Sink for events produced by a nested sub-agent turn.
	 *
	 * A side channel rather than a merge into the returned stream. `Stream.merge` would race the
	 * parent's terminal `turn-end` against undrained child events, and `ChatSession.pump` closes the
	 * SSE connection on a terminal event — so a child's tail could be written to the durable log
	 * *after* the turn had been declared over. The consumer's `Stream.runForEach` is strictly
	 * sequential, so an event emitted from inside a tool's `execute` is deterministically ordered
	 * after the tool-call announcement that introduced it and before the tool-result that closes it.
	 */
	readonly emit?: (event: ChatTurnEvent) => void
}

/** Where one step sits in the turn. `attempt` is 0-based and resets per step. */
export interface StepState {
	readonly step: number
	readonly attempt: number
	readonly budget: StepRetryBudget
	/** Resolved once at the top of the turn, so every step agrees on the ruleset and step cap. */
	readonly agent: AgentDefinition
	/** Shared with every descendant sub-agent turn. */
	readonly taskBudget: TaskBudget
	/** One semantic recovery is allowed for a completed response with no visible output. */
	readonly emptyRecoveryUsed: boolean
	/**
	 * This is the step that closes a turn which ran out of steps or clock. Its natural exit is
	 * "no tool calls", which would otherwise report `"stop"` and lose the signal the client badges
	 * on — so the reason is carried here instead.
	 *
	 * Two shapes, because there are two kinds of answer. `"prose"` is the tool-less step attended
	 * chat gets. `"submit"` carries the single forced submit tool a headless pass answers through
	 * (see {@link ChatTurnInput.closingSubmit}); its one tool call is dispatched and then the turn
	 * ends, never recursing.
	 */
	readonly closing?: "prose" | "submit"
	/**
	 * Repeated-batch detector state (`./stop.ts`).
	 *
	 * Threaded through the recursion like `step` and `attempt` rather than shared like `budget` and
	 * `taskBudget`: those two are *turn-wide* totals every branch draws down, while this is a property
	 * of one chain of steps. A sub-agent starts a fresh chain, and its loop is not the parent's.
	 */
	readonly doomLoop: DoomLoopState
}

/**
 * Running token total for one turn, accumulated across its steps.
 *
 * Mutable and shared rather than returned, because the one consumer — `submit_diagnosis` — is a
 * *tool* invoked mid-turn, so there is no "after the turn" moment at which to hand it a total.
 * In practice the diagnosis call is the last thing an investigation does, so this is the whole turn
 * bar the final assistant message. Before this, `SubmitDiagnosisRequest` was built with no usage at
 * all, so `InvestigationService`'s `if (env && (inputTokens || outputTokens))` was always false:
 * `investigations.model` stayed null and Autumn was never metered for autonomous investigations,
 * which the pre-`@maple/llm` workflow path did meter.
 */
export interface TurnUsage {
	input: number
	output: number
	cacheRead: number
}

export const makeTurnUsage = (): TurnUsage => ({ input: 0, output: 0, cacheRead: 0 })

/**
 * Low-cardinality facts collected by the loop and emitted once on the enclosing turn span.
 *
 * Mutable for the same reason as {@link TurnUsage}: the stream discovers its final outcome after
 * the caller has already created the span, and nested sub-agents deliberately receive no reference
 * to this record so they cannot overwrite the parent turn's attributes.
 */
export interface TurnObservability {
	outcome?: "stop" | "aborted" | "error" | "max-steps" | "unknown"
	finishReason?: FinishReason
	emptyOutput: boolean
	recoveryCount: number
	failureReason?: string
}

export const makeTurnObservability = (): TurnObservability => ({
	emptyOutput: false,
	recoveryCount: 0,
})

export const addUsage = (total: TurnUsage, usage: Usage | undefined): void => {
	total.input += usage?.inputTokens ?? 0
	total.output += usage?.outputTokens ?? 0
	total.cacheRead += usage?.cacheReadInputTokens ?? 0
}

/**
 * Stamp an event with the ref that routes it into a parent's task card.
 *
 * Every emission site goes through this, so a sub-agent's events can never leak into the top-level
 * conversation by omission — the tag is applied once, at the boundary, rather than remembered at
 * each of the seven places a turn emits. Typed structurally so this module does not depend on the
 * whole turn input.
 */
export const tagged = <E extends ChatTurnEvent>(source: { readonly task?: ChatTaskRef }, event: E): E =>
	source.task === undefined ? event : { ...event, task: source.task }

export const turnEnd = (
	input: { readonly messageId: string; readonly task?: ChatTaskRef },
	reason: Extract<ChatEvent, { type: "turn-end" }>["reason"],
	error?: string,
): ChatTurnEvent =>
	tagged(input, {
		type: "turn-end",
		messageId: input.messageId,
		reason,
		...(!(error === undefined) ? { error } : undefined),
	})

/** A turn with no session attached (tests, one-shot callers) is always current. */
export const isCurrent = (input: ChatTurnInput): boolean => input.isCurrent === undefined || input.isCurrent()

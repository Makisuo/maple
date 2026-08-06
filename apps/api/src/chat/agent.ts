/**
 * The Maple chat agent turn, in process on `@maple/llm`.
 *
 * This is the streaming sibling of `workflows/triage-agent.ts`: same tool wrapping, same
 * multi-turn loop, but it emits `ChatEvent`s as they happen instead of returning a structured
 * result, and it gates mutating tools.
 *
 * **Approvals are a real interrupt now.** Flue's event stream had no human-in-the-loop primitive,
 * so `apps/chat-flue/src/lib/approval.ts` swapped every mutating tool for one whose `execute`
 * returned a `{ status: "proposed" }` marker without mutating — a propose-then-apply stub the web
 * client then re-ran through `POST /api/chat/apply`. Here the loop simply *stops* on a gated call:
 * it emits a `tool-call` event with `proposed: true` and ends the turn. Nothing fabricates a tool
 * result, so the model is never told a mutation happened when it did not.
 *
 * `POST /api/chat/apply` still exists and is still how the approved mutation runs — it is the
 * user's action, authenticated as the user, which is exactly where it belongs.
 */
import {
	investigationIdFromChatSessionId,
	type ChatEvent,
	type ChatTaskRef,
} from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import { AiTriageResult, SubmitDiagnosisRequest } from "@maple/domain/http"
import { InvestigationId } from "@maple/domain/primitives"
import {
	LLM,
	LLMEvent,
	LLMResponse,
	Message,
	ToolResultPart,
	type LLMRequest,
	type Model,
	type Usage,
} from "@maple/llm"
import { Tool, ToolFailure, ToolRuntime, toDefinitions, type Tools } from "@maple/llm"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { contextLimitOf, outputLimitOf, toLlmCallError } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"

import { buildMapleTools, summarizeToolFailure, withRuntimeServices } from "@/mcp/tools/llm-tools"
import { isNearContextLimit, pruneToolResults } from "./context-budget"
import { agentForSession, buildSystemPrompt, spawnableFor, type AgentDefinition } from "./agents"
import { buildTaskTool, hasStepBudget, makeTaskBudget, type TaskBudget } from "./task-tool"
import {
	isRetryableStepFailure,
	makeStepRetryBudget,
	stepRetryDelayMs,
	MAX_STEP_ATTEMPTS,
	STEP_RETRY_BUDGET_MS,
	type StepRetryBudget,
} from "./llm-retry"

const decodeInvestigationIdOption = Schema.decodeUnknownOption(InvestigationId)

/**
 * Hard cap on *tool-calling* assistant turns per submission.
 *
 * A turn that hits it gets one further, tool-less step so the model can answer from what it found;
 * see `MAX_STEPS_NOTICE`.
 */
const MAX_STEPS = 10

/**
 * What the model is told when it runs out of steps.
 *
 * The turn used to stop dead here, so the user was left with a wall of tool rows and no words —
 * the model had gathered the answer and never got to say it.
 */
const MAX_STEPS_NOTICE =
	"You have reached the maximum number of tool calls for this turn. Do NOT call any more tools. " +
	"Using only what you have already found, give the user your answer now, and say plainly what " +
	"you could not determine."

/** Fan-out cap for tool calls issued in the same assistant turn. */
const TOOL_CONCURRENCY = 4

/**
 * How many text deltas are folded into one emitted event, and how long a partial batch waits.
 *
 * Roughly one animation frame. Every delta that leaves this stream becomes a durable SQLite row, an
 * SSE frame and a React state commit, and the browser cannot show more than one update per frame
 * anyway — so batching to that granularity costs no perceptible smoothness and removes most of the
 * per-token work at all three layers. The size cap keeps a fast provider from letting a batch grow
 * unboundedly within the window.
 */
const DELTA_BATCH_SIZE = 24
const DELTA_BATCH_WINDOW = "16 millis"

/**
 * Running token total for one turn, accumulated across its steps.
 *
 * Mutable and shared rather than returned, because the one consumer — `submit_diagnosis` — is a
 * *tool* invoked mid-turn, so there is no "after the turn" moment at which to hand it a total.
 * In practice the diagnosis call is the last thing an investigation does, so this is the whole
 * turn bar the final assistant message. Before this, `SubmitDiagnosisRequest` was built with no
 * usage at all, so `InvestigationService`'s `if (env && (inputTokens || outputTokens))` was always
 * false: `investigations.model` stayed null and Autumn was never metered for autonomous
 * investigations, which the pre-`@maple/llm` workflow path did meter.
 */
export interface TurnUsage {
	input: number
	output: number
	cacheRead: number
}

export const makeTurnUsage = (): TurnUsage => ({ input: 0, output: 0, cacheRead: 0 })

const addUsage = (total: TurnUsage, usage: Usage | undefined): void => {
	total.input += usage?.inputTokens ?? 0
	total.output += usage?.outputTokens ?? 0
	total.cacheRead += usage?.cacheReadInputTokens ?? 0
}

export interface ChatTurnInput {
	readonly sessionId: string
	readonly tenant: TenantContext
	readonly model: Model
	/** The full transcript so far, oldest first, already including the new user message. */
	readonly messages: ReadonlyArray<Message>
	readonly messageId: string
	/**
	 * Investigate-mode sessions get a `submit_diagnosis` tool. It is supplied rather than built
	 * here because it needs `InvestigationService`, which would otherwise drag the service graph
	 * into this module's imports.
	 */
	readonly extraTools?: Tools
	/**
	 * Whether this turn still holds the session's turn slot.
	 *
	 * Checked between steps so an abort takes effect at the next boundary instead of only after the
	 * in-flight model call drains, and so a turn that has been superseded stops writing into a
	 * conversation that has moved on. Defaults to "always current" for callers with no session.
	 */
	readonly isCurrent?: () => boolean
	/** Accumulates this turn's token usage; see {@link TurnUsage}. */
	readonly usage?: TurnUsage
	/**
	 * Which agent this turn runs as. Defaults to the primary agent the session id names, so
	 * existing callers keep the behaviour their mode already had.
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
	 * parent's terminal `turn-end` against undrained child events, and `ChatSession.pump` closes
	 * the SSE connection on a terminal event — so a child's tail could be written to the durable log
	 * *after* the turn had been declared over. The consumer's `Stream.runForEach` is strictly
	 * sequential, so an event emitted from inside a tool's `execute` is deterministically ordered
	 * after the tool-call announcement that introduced it and before the tool-result that closes it.
	 */
	readonly emit?: (event: ChatTurnEvent) => void
}

/**
 * The `submit_diagnosis` tool for an investigate-mode session (`"<orgId>:inv-<id>"`).
 *
 * The agent calls it exactly once at the end of its autonomous pass and its arguments ARE the
 * structured report — `AiTriageResult` directly, not the Valibot mirror `apps/chat-flue` had to
 * keep in sync by hand.
 *
 * Deliberately not approval-gated: it is the structured-output channel, not a user-facing
 * mutation. The investigation id and org ride from the session id, so the agent never chooses
 * which investigation it writes.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous turn, so resolving it
 * through the Effect requirements channel would make `InvestigationService` require itself.
 */
export type SubmitDiagnosis = (
	orgId: TenantContext["orgId"],
	investigationId: InvestigationId,
	request: SubmitDiagnosisRequest,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Effect.Effect<unknown, unknown, any>

export const buildSubmitDiagnosisTool = (
	sessionId: string,
	tenant: TenantContext,
	submitDiagnosis: SubmitDiagnosis,
	usage: TurnUsage,
	model: Model,
): Tools => {
	const tools: Tools = {}
	const rawId = investigationIdFromChatSessionId(sessionId)
	if (!rawId) return tools
	// `decodeUnknownSync` here turned a session id whose `inv-` suffix was not a UUID into a thrown
	// defect on a user-supplied string. An unparseable id simply means this conversation is not an
	// investigation, so it gets no `submit_diagnosis` tool.
	const decoded = decodeInvestigationIdOption(rawId)
	if (Option.isNone(decoded)) return tools
	const investigationId = decoded.value
	tools.submit_diagnosis = Tool.make({
		description:
			"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
			"after you have gathered evidence, with your final assessment. It persists the report " +
			"and renders it for the user. After calling it, stop unless the user asks a follow-up.",
		parameters: AiTriageResult,
		success: Schema.String,
		execute: (report) =>
			withRuntimeServices(
				submitDiagnosis(
					tenant.orgId,
					investigationId,
					new SubmitDiagnosisRequest({
						report,
						model: String(model.id),
						inputTokens: usage.input,
						outputTokens: usage.output,
					}),
				).pipe(
					Effect.as("Diagnosis recorded."),
					// Named failures only. `catchCause` + `String(cause)` fed the model a rendered
					// Effect cause — stack frames, and connection details out of a DatabaseError.
					Effect.catchCause((cause) =>
						Effect.fail(
							new ToolFailure({
								message: `submit_diagnosis failed: ${summarizeToolFailure(cause)}`,
							}),
						),
					),
				),
			),
	})
	return tools
}

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model
 * sees is identical to the read-only case — but the loop never dispatches it, because it breaks on
 * the proposal first, and `POST /api/chat/apply` remains the only path that actually mutates.
 */
const buildChatTools = (tenant: TenantContext, ruleset: PermissionRuleset): Tools =>
	buildMapleTools(tenant, {
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})

/** Distributive `Omit`, so each union member keeps its own shape. */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never

/**
 * Events this turn wants appended to the session log. `seq` is assigned by the Durable Object,
 * which owns the ordering, so the agent emits everything without one. `user-message` is excluded:
 * the session records the user turn at submission time, before the agent runs.
 */
export type ChatTurnEvent = WithoutSeq<Exclude<ChatEvent, { type: "user-message" }>>

/**
 * Run one submission to completion, streaming `ChatTurnEvent`s.
 *
 * The model is *streamed*, not `generate`d, so text deltas reach the session log — and through it
 * the client — while the turn is still running. The raw `LLMEvent`s are folded into an
 * `LLMResponse` on the way past so the assistant turn can be appended to the transcript verbatim
 * for the next step.
 */
export const runChatTurn = (input: ChatTurnInput): Stream.Stream<ChatTurnEvent> =>
	Stream.unwrap(
		Effect.sync(() => {
			const agent = input.agent ?? agentForSession(input.sessionId)
			const taskBudget = input.taskBudget ?? makeTaskBudget()
			const tools = {
				...buildChatTools(input.tenant, agent.permission),
				// Delegation is opt-in per agent: an agent with no `spawns` never sees `task` at all.
				...buildTaskTool(input, spawnableFor(agent), taskBudget, runChatTurn),
				...input.extraTools,
			}
			const request = LLM.request({
				id: input.messageId,
				model: input.model,
				system: buildSystemPrompt(agent),
				messages: [...input.messages],
				tools: toDefinitions(tools),
			})
			const start = tagged(input, { type: "turn-start", messageId: input.messageId })
			const state: StepState = {
				step: 0,
				attempt: 0,
				budget: makeStepRetryBudget(),
				agent,
				taskBudget,
			}
			return Stream.concat(Stream.fromIterable([start]), runStep(input, tools, request, state))
		}),
	)

/**
 * Where one step sits in the turn.
 *
 * `attempt` is 0-based and resets per step; `budget` is shared across the whole turn, because a
 * per-step cap composes badly over `MAX_STEPS` steps — ten steps each retrying three times is
 * minutes of pure backoff, and the DO's turn slot is held the entire time.
 */
interface StepState {
	readonly step: number
	readonly attempt: number
	readonly budget: StepRetryBudget
	/** Resolved once at the top of the turn, so every step agrees on the ruleset and step cap. */
	readonly agent: AgentDefinition
	/** Shared with every descendant sub-agent turn. */
	readonly taskBudget: TaskBudget
	/**
	 * This is the tool-less step that closes a turn which ran out of steps. Its natural exit is
	 * "no tool calls", which would otherwise report `"stop"` and lose the signal the client badges
	 * on — so the reason is carried here instead.
	 */
	readonly closing?: true
}

/**
 * Stamp an event with the ref that routes it into a parent's task card.
 *
 * Every emission site goes through this, so a sub-agent's events can never leak into the top-level
 * conversation by omission — the tag is applied once, at the boundary, rather than remembered at
 * each of the seven places a turn emits.
 */
const tagged = <E extends ChatTurnEvent>(input: ChatTurnInput, event: E): E =>
	input.task === undefined ? event : { ...event, task: input.task }

const turnEnd = (
	input: ChatTurnInput,
	reason: Extract<ChatEvent, { type: "turn-end" }>["reason"],
	error?: string,
): ChatTurnEvent =>
	tagged(input, {
		type: "turn-end",
		messageId: input.messageId,
		reason,
		...(error === undefined ? {} : { error }),
	})

/** A turn with no session attached (tests, one-shot callers) is always current. */
const isCurrent = (input: ChatTurnInput): boolean => input.isCurrent === undefined || input.isCurrent()

/**
 * One assistant turn, then either settle its tool calls and recurse, or stop.
 *
 * Recursion rather than a loop because each step's output is a `Stream` that must be concatenated
 * lazily: the next request cannot be built until the current step's tool results exist.
 */
const runStep = (
	input: ChatTurnInput,
	tools: Tools,
	request: LLMRequest,
	state: StepState,
): Stream.Stream<ChatTurnEvent> =>
	Stream.suspend(() => {
		// Counted per model call, not per logical step, because a retry costs the same wall clock
		// and the same money. Shared with every descendant, so a fan-out of sub-agents cannot
		// multiply its way past the turn's ceiling.
		state.taskBudget.stepsUsed += 1

		const collected: Array<LLMEvent> = []
		// Set by the catch below. `Stream.concat`'s second half runs unconditionally, so without an
		// explicit flag a failed stream that still assembled a partial response would emit a
		// *second* terminal event after the error one — and, if that partial response carried tool
		// calls, would dispatch them and recurse after the turn had already been declared over.
		// Those extra events land invisibly (the SSE route stops at the first `turn-end`) and
		// surface on the next reload.
		let failed = false
		// Characters of *this attempt's* text that reached the log. Counted after the batching
		// window, not at the raw delta, so it matches exactly what the consumer appended — that
		// equality is what makes `retractChars` a complete undo rather than an approximation.
		//
		// It also means a batch still buffering when the stream fails contributes nothing, because
		// `Stream.groupedWithin` discards its pending buffer on an upstream failure rather than
		// flushing it. So a provider that dies inside one batching window costs a retraction of
		// zero, and only text that actually reached a consumer is ever taken back.
		let emitted = 0

		const live: Stream.Stream<ChatTurnEvent> = LLM.stream(request).pipe(
			Stream.tap((event) => Effect.sync(() => collected.push(event))),
			Stream.filter((event) => event.type === "text-delta" && event.text !== ""),
			// One durable row, one SSE frame and one React commit per *token* is more fidelity than
			// a screen can show. Coalescing into roughly one frame's worth of deltas is invisible
			// to a reader and cuts all three by about an order of magnitude. Only text deltas are
			// batched, and only against each other — `collected` still holds every raw event, and
			// tool calls and the terminal event live in the concatenated segment below, so nothing
			// here can reorder them.
			Stream.groupedWithin(DELTA_BATCH_SIZE, DELTA_BATCH_WINDOW),
			Stream.map((events): ChatTurnEvent => {
				const text = events.map((event) => ("text" in event ? event.text : "")).join("")
				emitted += text.length
				return tagged(input, { type: "text-delta", messageId: input.messageId, text })
			}),
			// A model failure either retries the step or ends the turn as a recorded event. Either
			// way it does not kill the stream: the session log is durable, so a client reconnecting
			// after the failure must still be able to read what happened.
			Stream.catch((error) => {
				failed = true
				const called = toLlmCallError("chat.turn", error)

				// Aborted mid-stream. The DO already recorded the terminal event when it cleared the
				// claim, so emitting anything here would be a second one.
				if (!isCurrent(input)) return Stream.empty

				// Overflow is the one failure worth retrying with a *different* request. Sending the
				// same oversized transcript again cannot start fitting, so `isRetryableStepFailure`
				// refuses it — but a pruned transcript is a genuinely new attempt. This is what
				// `LlmCallError.contextOverflow` was added for; nothing acted on it before.
				if (called.contextOverflow) {
					const pruned = pruneToolResults(request)
					if (pruned === request || state.attempt + 1 >= MAX_STEP_ATTEMPTS) {
						return Stream.fromIterable([turnEnd(input, "error", called.message)])
					}
					return Stream.concat(
						Stream.fromIterable([
							tagged(input, {
								type: "turn-retry" as const,
								messageId: input.messageId,
								attempt: state.attempt + 2,
								retractChars: emitted,
								reason: called.reason,
								delayMs: 0,
							}),
						]),
						runStep(input, tools, pruned, { ...state, attempt: state.attempt + 1 }),
					)
				}

				const delayMs = stepRetryDelayMs(state.attempt)
				const affordable = state.budget.spentMs + delayMs <= STEP_RETRY_BUDGET_MS
				if (
					!isRetryableStepFailure(called) ||
					state.attempt + 1 >= MAX_STEP_ATTEMPTS ||
					!affordable
				) {
					return Stream.fromIterable([turnEnd(input, "error", called.message)])
				}
				state.budget.spentMs += delayMs

				// The retraction and the progress signal are one event: either alone is useless.
				// Safe to express as a character count because a failed attempt emitted nothing but
				// text — tool calls live in `settleAndRecurse`, which `failed` short-circuits.
				const marker = tagged(input, {
					type: "turn-retry" as const,
					messageId: input.messageId,
					attempt: state.attempt + 2,
					retractChars: emitted,
					reason: called.reason,
					delayMs,
				})
				return Stream.concat(
					Stream.fromIterable([marker]),
					// `Stream.unwrap` + `Effect.sleep` rather than `Stream.retry`: a schedule would
					// resubscribe this whole pipeline, replaying the deltas it already emitted, and
					// would leave nowhere to put the retraction between attempts.
					Stream.unwrap(
						Effect.sleep(Duration.millis(delayMs)).pipe(
							Effect.map(() =>
								// Re-checked *after* the sleep: an abort landing during backoff wins.
								isCurrent(input)
									? runStep(input, tools, request, {
											...state,
											attempt: state.attempt + 1,
										})
									: Stream.empty,
							),
						),
					),
				)
			}),
		)

		const settleAndRecurse = Stream.unwrap(
			Effect.gen(function* () {
				if (failed) return Stream.empty
				// Aborted between steps: the session already recorded the terminal event, so stop
				// without emitting a second one.
				if (!isCurrent(input)) return Stream.empty

				const response = LLMResponse.fromEvents(collected)
				// A stream that neither failed nor assembled still ended the turn; say so, rather
				// than leaving the log with no terminal event at all.
				if (!response) return Stream.fromIterable([turnEnd(input, "stop")])

				if (input.usage) addUsage(input.usage, response.usage)

				const calls = response.events
					.filter(LLMEvent.is.toolCall)
					.filter((call) => !call.providerExecuted)

				if (calls.length === 0) {
					return Stream.fromIterable([turnEnd(input, state.closing ? "max-steps" : "stop")])
				}

				// The closing step is sent with `tools: []` and `toolChoice: "none"`, so a call here
				// means the provider ignored both. Ending rather than dispatching keeps `MAX_STEPS`
				// a real bound: without this the closing step would recurse into another closing
				// step, and a provider that always emits a call would loop forever.
				if (state.closing) return Stream.fromIterable([turnEnd(input, "max-steps")])

				// The real interrupt. A gated call ends the turn immediately — the client renders an
				// approval card from this event and applies it through `POST /api/chat/apply`.
				// Read-only calls issued in the same turn are dropped rather than half-run, so the
				// transcript never shows a partial turn.
				const gated = calls.find(
					(call) => evaluatePermission(state.agent.permission, call.name) === "ask",
				)
				if (gated) {
					const proposal = tagged(input, {
						type: "tool-call" as const,
						messageId: input.messageId,
						callId: gated.id,
						name: gated.name,
						input: gated.input,
						proposed: true,
					})
					return Stream.fromIterable([proposal, turnEnd(input, "stop")])
				}

				const announced = calls.map((call) =>
					tagged(input, {
						type: "tool-call" as const,
						messageId: input.messageId,
						callId: call.id,
						name: call.name,
						input: call.input,
					}),
				)

				// Announce first, settle second, as two stream segments. Emitting both together
				// after `Effect.forEach` resolved meant a tool call only ever reached the log
				// *already finished*, so the UI could never render one running — most of the point
				// of streaming a turn that spends its time in tools.
				const settled = Stream.unwrap(
					Effect.gen(function* () {
						const dispatched = yield* Effect.forEach(
							calls,
							(call) =>
								ToolRuntime.dispatch(tools, call).pipe(
									Effect.map((result) => [call, result] as const),
								),
							{ concurrency: TOOL_CONCURRENCY },
						)

						const results = dispatched.map(([call, outcome]) =>
							tagged(input, {
								type: "tool-result" as const,
								messageId: input.messageId,
								callId: call.id,
								output: outcome.result.value,
								...(outcome.result.type === "error" ? { isError: true } : {}),
							}),
						)

						// Aborted while the tools were in flight: record what they returned so the
						// transcript is not left with dangling calls, then stop.
						if (!isCurrent(input)) return Stream.fromIterable(results)

						const transcript = [
							...request.messages,
							response.message,
							...dispatched.map(([call, outcome]) =>
								Message.tool(
									ToolResultPart.make({
										id: call.id,
										name: call.name,
										result: outcome.result,
									}),
								),
							),
						]

						/**
						 * Prune before the next step if the *provider's own* count says we are near
						 * the wall. Acting on the reported figure rather than an estimate is what
						 * makes this trustworthy — the estimate exists only to decide whether a
						 * prune is worth doing.
						 */
						const withBudget = (next: LLMRequest): LLMRequest =>
							isNearContextLimit(response.usage?.inputTokens ?? 0, {
								context: contextLimitOf(input.model),
								output: outputLimitOf(input.model),
							})
								? pruneToolResults(next)
								: next

						// Out of steps. Rather than cutting the turn off after a wall of tool rows
						// with no words — which is what the user was left with — spend one more
						// non-tool step letting the model answer from what it already found.
						//
						// A trailing *user* instruction, not opencode's assistant prefill: prefill is
						// an Anthropic-shaped affordance, and Maple's default route is OpenRouter.
						// `tools: []` and `toolChoice: "none"` together mean the closing step cannot
						// loop even if the model ignores the instruction, so `MAX_STEPS` keeps
						// meaning "at most this many tool-calling steps".
						// Either this turn's own step cap, or the budget shared with every sub-agent it
						// spawned. Both land in the same place: one closing step to say what was found.
						if (
							state.step + 1 >= (state.agent.steps ?? MAX_STEPS) ||
							!hasStepBudget(state.taskBudget)
						) {
							const closing = LLM.updateRequest(request, {
								messages: [...transcript, Message.user(MAX_STEPS_NOTICE)],
								tools: [],
								toolChoice: "none",
							})
							return Stream.concat(
								Stream.fromIterable(results),
								runStep(input, tools, withBudget(closing), {
									...state,
									step: state.step + 1,
									attempt: 0,
									closing: true,
								}),
							)
						}

						const next = withBudget(LLM.updateRequest(request, { messages: transcript }))
						// A fresh attempt count per step: `attempt` counts retries of *this* step's
						// model call, and the shared `budget` is what bounds the turn overall.
						return Stream.concat(
							Stream.fromIterable(results),
							runStep(input, tools, next, {
								...state,
								step: state.step + 1,
								attempt: 0,
							}),
						)
					}),
				)

				return Stream.concat(Stream.fromIterable(announced), settled)
			}),
		)

		return Stream.concat(live, settleAndRecurse)
	})

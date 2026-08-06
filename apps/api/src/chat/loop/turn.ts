/**
 * The chat turn loop: one submission, driven to completion.
 *
 * This module is the control flow and nothing else. Every policy it applies lives next door and is
 * read here as a decision, not re-derived:
 *
 *   - `./budgets.ts`   — every ceiling: steps, attempts, backoff time, delegation fan-out, depth.
 *   - `./retry.ts`     — which failures are worth another attempt, and how long to wait.
 *   - `./context.ts`   — keeping the request inside the model's window.
 *   - `./delegate.ts`  — handing a sub-question to a sub-agent, which re-enters this loop.
 *   - `./types.ts`     — the input, the events, and one step's state.
 *   - `../tools.ts`    — what the model may call.
 *   - `../agents.ts`   — which agent this turn runs as, and what it is allowed to do.
 *
 * ## The shape of a step
 *
 * Stream the model → fold the events into an `LLMResponse` → settle the tool calls → build the next
 * request → recurse. Recursion rather than a `while` because each step's output is a `Stream` that
 * must be concatenated lazily: the next request cannot be built until the current step's tool
 * results exist.
 *
 * ## Approvals are a real interrupt
 *
 * Flue's event stream had no human-in-the-loop primitive, so `apps/chat-flue/src/lib/approval.ts`
 * swapped every mutating tool for one whose `execute` returned a `{ status: "proposed" }` marker
 * without mutating — a propose-then-apply stub the web client re-ran through `POST /api/chat/apply`.
 * Here the loop simply *stops* on a gated call: it emits a `tool-call` with `proposed: true` and
 * ends the turn. Nothing fabricates a tool result, so the model is never told a mutation happened
 * when it did not. `POST /api/chat/apply` is still how the approved mutation runs — the user's own
 * action, authenticated as the user, which is where it belongs.
 */
import { evaluatePermission } from "@maple/domain/permission"
import {
	LLM,
	LLMEvent,
	LLMResponse,
	Message,
	ToolResultPart,
	toDefinitions,
	ToolRuntime,
	type LLMRequest,
	type Tools,
} from "@maple/llm"
import { Duration, Effect, Stream } from "effect"
import { contextLimitOf, outputLimitOf, toLlmCallError } from "@/platform/Llm"
import { agentForSession, buildSystemPrompt, spawnableFor } from "../agents"
import { buildChatTools } from "../tools"
import {
	hasStepBudget,
	makeStepRetryBudget,
	makeTaskBudget,
	MAX_STEP_ATTEMPTS,
	MAX_STEPS,
	STEP_RETRY_BUDGET_MS,
	TOOL_CONCURRENCY,
} from "./budgets"
import { isNearContextLimit, pruneToolResults } from "./context"
import { buildTaskTool } from "./delegate"
import { isRetryableStepFailure, stepRetryDelayMs } from "./retry"
import {
	addUsage,
	isCurrent,
	tagged,
	turnEnd,
	type ChatTurnEvent,
	type ChatTurnInput,
	type StepState,
} from "./types"

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

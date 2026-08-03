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
	chatModeFromSessionId,
	investigationIdFromChatSessionId,
	type ChatEvent,
} from "@maple/domain/chat-session"
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
import { Cause, Effect, Option, Schema, Stream } from "effect"
import { toLlmCallError } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import { callMcpTool } from "@/mcp/dispatcher"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import { mapleToolDefinitions, toInputSchema } from "@/mcp/tools/registry"
import { buildSystemPrompt } from "./modes"

const decodeInvestigationIdOption = Schema.decodeUnknownOption(InvestigationId)

/** Hard cap on assistant turns per submission. */
const MAX_STEPS = 10

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

/**
 * Re-pin the service requirements of an MCP tool handler. See the identical helper in
 * `workflows/triage-agent.ts` — `MapleToolDefinition.handler` erases its requirements to `any`
 * at the registry boundary, and `Tool.make` insists on `never`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withRuntimeServices = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
	effect as Effect.Effect<A, E>

const toolResultText = (result: { content: ReadonlyArray<{ text: string }> }): string =>
	result.content.map((block) => block.text).join("\n")

/**
 * A one-line reason for a failed tool, safe to hand the model.
 *
 * `String(cause)` renders the whole Effect cause: stack frames, and — inside a `DatabaseError` —
 * connection details. That went into the model's context and, through the tool-result event, into
 * a durable transcript the browser reads back.
 */
const summarizeToolFailure = (cause: Cause.Cause<unknown>): string => {
	const failure = cause.reasons.find(Cause.isFailReason)
	const error: unknown = failure?.error
	if (error instanceof Error) return error.message
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message
		if (typeof message === "string") return message
	}
	return "the tool failed"
}

/**
 * Description suffix on gated tools. The model still calls them normally; it just needs to know
 * the call is a proposal so it stops rather than narrating a completed change.
 */
const APPROVAL_NOTE =
	"\n\nThis is an approval-gated action. Calling it proposes the change for the user to approve; " +
	"it does NOT take effect until they do. Call it once with the intended arguments and stop."

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

/** All Maple tools, with mutating ones flagged. Read-only tools execute; gated ones never do. */
const buildChatTools = (tenant: TenantContext): Tools =>
	Object.fromEntries(
		mapleToolDefinitions.map((definition) => {
			const gated = MUTATING_TOOL_NAMES.has(definition.name)
			return [
				definition.name,
				Tool.make({
					description: gated ? `${definition.description}${APPROVAL_NOTE}` : definition.description,
					jsonSchema: toInputSchema(definition.schema),
					// A gated tool still executes as far as `Tool.make` is concerned, but the loop
					// never dispatches it — it breaks on the proposal first. Keeping a real handler
					// here (rather than omitting it) means the tool schema the model sees is
					// identical to the read-only case, and `POST /api/chat/apply` remains the only
					// path that actually mutates.
					execute: (params): Effect.Effect<unknown, ToolFailure> =>
						gated
							? Effect.fail(
									new ToolFailure({
										message: `${definition.name} requires user approval and was not executed.`,
									}),
								)
							: withRuntimeServices(
									callMcpTool(definition.name, params).pipe(
										Effect.provideService(CurrentMcpTenant, tenant),
										Effect.flatMap((result) =>
											result.isError
												? Effect.fail(
														new ToolFailure({ message: toolResultText(result) }),
													)
												: Effect.succeed(toolResultText(result)),
										),
										Effect.catchCause((cause) =>
											Effect.fail(
												new ToolFailure({
													message: `Tool failed: ${summarizeToolFailure(cause)}`,
												}),
											),
										),
									),
								),
				}),
			]
		}),
	)

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
			const tools = { ...buildChatTools(input.tenant), ...input.extraTools }
			const system = buildSystemPrompt({ mode: chatModeFromSessionId(input.sessionId) })
			const request = LLM.request({
				id: input.messageId,
				model: input.model,
				system,
				messages: [...input.messages],
				tools: toDefinitions(tools),
			})
			const start: ChatTurnEvent = { type: "turn-start", messageId: input.messageId }
			return Stream.concat(Stream.fromIterable([start]), runStep(input, tools, request, 0))
		}),
	)

const turnEnd = (
	input: ChatTurnInput,
	reason: Extract<ChatEvent, { type: "turn-end" }>["reason"],
	error?: string,
): ChatTurnEvent => ({
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
	step: number,
): Stream.Stream<ChatTurnEvent> =>
	Stream.suspend(() => {
		const collected: Array<LLMEvent> = []
		// Set by the catch below. `Stream.concat`'s second half runs unconditionally, so without an
		// explicit flag a failed stream that still assembled a partial response would emit a
		// *second* terminal event after the error one — and, if that partial response carried tool
		// calls, would dispatch them and recurse after the turn had already been declared over.
		// Those extra events land invisibly (the SSE route stops at the first `turn-end`) and
		// surface on the next reload.
		let failed = false

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
			Stream.map(
				(events): ChatTurnEvent => ({
					type: "text-delta",
					messageId: input.messageId,
					text: events.map((event) => ("text" in event ? event.text : "")).join(""),
				}),
			),
			// A model failure ends the turn as a recorded event rather than killing the stream —
			// the session log is durable, so a client reconnecting after the failure must still be
			// able to read why the turn stopped.
			Stream.catch((error) => {
				failed = true
				return Stream.fromIterable([
					turnEnd(input, "error", toLlmCallError("chat.turn", error).message),
				])
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

				if (calls.length === 0) return Stream.fromIterable([turnEnd(input, "stop")])

				// The real interrupt. A gated call ends the turn immediately — the client renders an
				// approval card from this event and applies it through `POST /api/chat/apply`.
				// Read-only calls issued in the same turn are dropped rather than half-run, so the
				// transcript never shows a partial turn.
				const gated = calls.find((call) => MUTATING_TOOL_NAMES.has(call.name))
				if (gated) {
					const proposal: ChatTurnEvent = {
						type: "tool-call",
						messageId: input.messageId,
						callId: gated.id,
						name: gated.name,
						input: gated.input,
						proposed: true,
					}
					return Stream.fromIterable([proposal, turnEnd(input, "stop")])
				}

				const announced = calls.map(
					(call): ChatTurnEvent => ({
						type: "tool-call",
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

						const results = dispatched.map(
							([call, outcome]): ChatTurnEvent => ({
								type: "tool-result",
								messageId: input.messageId,
								callId: call.id,
								output: outcome.result.value,
								...(outcome.result.type === "error" ? { isError: true } : {}),
							}),
						)

						// Aborted while the tools were in flight: record what they returned so the
						// transcript is not left with dangling calls, then stop.
						if (!isCurrent(input)) return Stream.fromIterable(results)

						if (step + 1 >= MAX_STEPS) {
							return Stream.fromIterable([...results, turnEnd(input, "max-steps")])
						}

						const next = LLM.updateRequest(request, {
							messages: [
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
							],
						})
						return Stream.concat(
							Stream.fromIterable(results),
							runStep(input, tools, next, step + 1),
						)
					}),
				)

				return Stream.concat(Stream.fromIterable(announced), settled)
			}),
		)

		return Stream.concat(live, settleAndRecurse)
	})

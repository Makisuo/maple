/**
 * Running one registered agent to a structured answer, headlessly.
 *
 * The loop is `chat/loop`'s — the same `runChatTurn` the attended conversation
 * uses, with the same retry, context pruning, step budgets and permission
 * gating. Nothing here re-implements a turn; this is only the seam that lets a
 * Cloudflare Workflow drive one and collect a typed result.
 *
 * Two things a workflow needs that a chat session gets for free:
 *
 * - **A structured answer.** The turn emits events, not objects, so the schema
 *   arrives the way `submit_diagnosis` already does: the turn's `completion`
 *   tool, whose `parameters` *is* the schema. The model filling it in is the
 *   model answering.
 * - **A deadline.** `softStop`, checked between steps. This used to ride on
 *   `isCurrent`, which looked like the same thing and is not: `isCurrent` is the
 *   *abort* hook, so a pass that ran out of clock returned an empty stream, never
 *   reached a closing step, and therefore never called its submit tool. A lane
 *   that had investigated for its entire budget was recorded exactly like one that
 *   never looked. `softStop` means "finish by answering", and the loop responds by
 *   spending one last step on the forced submit call.
 *
 * Both of those depend on `completion.closes`: the tool-less closing step that
 * serves attended chat has nothing to say for an agent whose answer *is* a tool
 * call.
 */
import { Cause, Schema, Stream, Effect, Option } from "effect"
import { Tool, type Model } from "@maple/llm"
import { Message } from "@maple/llm"
import { runChatTurn, makeTurnUsage, type TurnCompletion, type TurnUsage } from "@/chat/loop"
import type { AgentDefinition } from "@/chat/agents"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { summarizeCause } from "@/platform/describe-cause"

export interface AgentPassInput<S extends Schema.Top> {
	/** Correlation id; becomes the turn's `messageId`. */
	readonly id: string
	/**
	 * Gen-ai session this pass's spans group under (`maple_ai.session.id`), so every
	 * pass of one investigation lands in one agent session. Omitted, each pass
	 * fragments into a session of its own under its correlation id.
	 */
	readonly sessionId?: string
	/** Workflow this pass runs inside (`gen_ai.workflow.name`), e.g. `"investigation"`. */
	readonly workflowName?: string
	readonly agent: AgentDefinition
	readonly tenant: TenantContext
	readonly model: Model
	/** The single user turn. A sub-agent sees nothing else — its prompt must stand alone. */
	readonly prompt: string
	/** Name of the tool the agent calls to answer, e.g. `submit_candidate`. */
	readonly submitToolName: string
	readonly submitToolDescription: string
	/** The answer's schema. Doubles as the tool's parameters, so the model fills it in directly. */
	readonly schema: S
	/**
	 * Wall clock after which the turn stops at its next step boundary. Omit for no
	 * deadline. Never derive this inside a Cloudflare Workflow body — a `Date.now()`
	 * there differs on every replay and invalidates cached steps.
	 */
	readonly deadlineAtMs?: number
	readonly usage?: TurnUsage
}

export interface AgentPassOutput<A> {
	/** `None` when the agent never called its submit tool — a real outcome, not a crash. */
	readonly answer: Option.Option<A>
	readonly usage: TurnUsage
	/** Tool calls the agent made, excluding the submit call itself. */
	readonly toolCalls: number
	readonly deadlineHit: boolean
}

/**
 * Run the agent until it answers, exhausts its steps, or passes its deadline.
 *
 * Never fails on the agent's behalf: an agent that produces nothing returns
 * `None`, because "this lens found nothing" is a result the boards render and not
 * an error the workflow should propagate.
 */
export const runAgentPass = <S extends Schema.Top>(
	input: AgentPassInput<S>,
): Effect.Effect<AgentPassOutput<S["Type"]>, never, McpToolExecutor> =>
	Effect.gen(function* () {
		type A = S["Type"]
		const toolExecutor = yield* McpToolExecutor
		const usage = input.usage ?? makeTurnUsage()
		let answer: Option.Option<A> = Option.none()
		let toolCalls = 0
		let deadlineHit = false

		// The name and the tool are one value, so a pass can never offer its submit tool without the
		// loop knowing that calling it is how this turn ends. See `TurnCompletion`.
		const completion: TurnCompletion = {
			name: input.submitToolName,
			tool: Tool.make({
				description: input.submitToolDescription,
				parameters: input.schema as never,
				success: Schema.String,
				execute: (value: A) =>
					Effect.sync(() => {
						answer = Option.some(value)
						return "Recorded."
					}),
			}),
			// The turn's answer *is* this tool call, so the closing step has to keep offering it.
			closes: true,
		}

		yield* runChatTurn({
			sessionId: input.id,
			...(input.sessionId === undefined ? undefined : { genAiSessionId: input.sessionId }),
			...(input.workflowName === undefined ? undefined : { genAiWorkflowName: input.workflowName }),
			tenant: input.tenant,
			toolExecutor,
			// Separates workflow tool calls from interactive chat ones in telemetry;
			// both otherwise reach the dispatcher through this same loop.
			surface: "workflow",
			model: input.model,
			messages: [Message.user(input.prompt)],
			messageId: input.id,
			agent: input.agent,
			completion,
			usage,
			softStop: () => {
				if (input.deadlineAtMs === undefined) return false
				if (Date.now() < input.deadlineAtMs) return false
				deadlineHit = true
				return true
			},
		}).pipe(
			Stream.runForEach((event) =>
				Effect.sync(() => {
					if (event.type === "tool-call" && event.name !== input.submitToolName) toolCalls += 1
				}),
			),
			// A pass that dies mid-turn still reports whatever it managed to submit.
			// Workflow cancellation remains an interruption rather than a false successful pass.
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning("Agent pass failed; returning the partial result").pipe(
							Effect.annotateLogs({
								agent: input.agent.name,
								messageId: input.id,
								submitted: Option.isSome(answer),
								toolCallCount: toolCalls,
								cause: summarizeCause(cause),
							}),
							Effect.tap(() =>
								Effect.annotateCurrentSpan("maple.agent.recovered_failure", true),
							),
						),
			),
		)

		return { answer, usage, toolCalls, deadlineHit }
	})

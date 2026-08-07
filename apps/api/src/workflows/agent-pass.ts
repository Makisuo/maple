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
 *   arrives the way `submit_diagnosis` already does: a tool supplied through
 *   `extraTools` whose `parameters` *is* the schema. The model filling it in is
 *   the model answering.
 * - **A deadline.** `softStop`, checked between steps. This used to ride on
 *   `isCurrent`, which looked like the same thing and is not: `isCurrent` is the
 *   *abort* hook, so a pass that ran out of clock returned an empty stream, never
 *   reached a closing step, and therefore never called its submit tool. A lane
 *   that had investigated for its entire budget was recorded exactly like one that
 *   never looked. `softStop` means "finish by answering", and the loop responds by
 *   spending one last step on the forced submit call.
 *
 * Both of those depend on `closingSubmit`: the tool-less closing step that serves
 * attended chat has nothing to say for an agent whose answer *is* a tool call.
 */
import { Schema, Stream, Effect, Option } from "effect"
import { Tool, type Model, type Tools } from "@maple/llm"
import { Message } from "@maple/llm"
import { runChatTurn, makeTurnUsage, type TurnUsage } from "@/chat/loop"
import type { AgentDefinition } from "@/chat/agents"
import type { TenantContext } from "@/services/auth/tenant-context"

export interface AgentPassInput<S extends Schema.Top> {
	/** Correlation id; becomes the turn's `messageId`. */
	readonly id: string
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
): Effect.Effect<AgentPassOutput<S["Type"]>> =>
	Effect.gen(function* () {
		type A = S["Type"]
		const usage = input.usage ?? makeTurnUsage()
		let answer: Option.Option<A> = Option.none()
		let toolCalls = 0
		let deadlineHit = false

		const submit: Tools = {
			[input.submitToolName]: Tool.make({
				description: input.submitToolDescription,
				parameters: input.schema as never,
				success: Schema.String,
				execute: (value: A) =>
					Effect.sync(() => {
						answer = Option.some(value)
						return "Recorded."
					}),
			}),
		}

		yield* runChatTurn({
			sessionId: input.id,
			tenant: input.tenant,
			model: input.model,
			messages: [Message.user(input.prompt)],
			messageId: input.id,
			agent: input.agent,
			extraTools: submit,
			usage,
			// The turn's answer is this tool call, so the closing step has to keep offering it.
			closingSubmit: { toolName: input.submitToolName },
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
			Effect.catchCause(() => Effect.void),
		)

		return { answer, usage, toolCalls, deadlineHit }
	})

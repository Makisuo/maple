/**
 * `task` — delegating a self-contained question to a sub-agent.
 *
 * ## Why this runs in process, and not in a Durable Object of its own
 *
 * opencode's equivalent creates a real child *session* and re-enters the same loop against it. That
 * is nearly free there, because a session is an in-memory record in a long-lived process. On
 * Cloudflare it inverts: a child `ChatSession` DO would need a new addressing scheme that survives
 * all four session-id parsers (`orgIdFromChatSessionId`, `tabIdFromChatSessionId`,
 * `chatModeFromSessionId`, `investigationIdFromChatSessionId`), a distributed abort fan-out that
 * survives isolate eviction, and either cross-DO event mirroring or a second SSE stream per task —
 * all to solve a CPU-headroom problem the budgets below already bound.
 *
 * So the sub-agent runs *inside* the parent turn: `runChatTurn` calls itself, with a different
 * agent record and its own step budget. Three things fall out for free that the DO design would
 * have had to build:
 *
 *   - **Abort.** The child gets the parent's `isCurrent` closure verbatim, so clearing the turn
 *     claim stops both at their next step boundary.
 *   - **One log, one stream.** Child events are tagged with a {@link ChatTaskRef} and land in the
 *     parent's SQLite log, where `history()` folds them into a nested transcript.
 *   - **Replay.** `toLlmMessages` filters on top-level text, and child text lives nested inside a
 *     tool call, so the sub-agent's chatter never re-enters the next turn's context.
 *
 * The caps this respects — depth, fan-out, per-turn count — live in `./budgets.ts` alongside every
 * other ceiling, because they only make sense multiplied against the step caps.
 *
 * ## The context firewall
 *
 * The parent gets back the child's **final assistant text only**, never its tool payloads. That is
 * the entire point: delegation is how the model searches broadly without burying the conversation
 * in warehouse rows. A `task` that returned the child's transcript would be strictly worse than
 * just calling the tools inline.
 */
import { Schema, Stream, Effect } from "effect"
import { Tool, ToolFailure, type Tools } from "@maple/llm"
import { Message } from "@maple/llm"
import { AGENTS, type AgentDefinition } from "../agents"
import { hasStepBudget, SUBAGENT_MAX_DEPTH, TASK_BUDGET_PER_TURN, type TaskBudget } from "./budgets"
import type { ChatTurnEvent, ChatTurnInput } from "./types"

const renderResult = (ref: { id: string; agent: string }, text: string): string =>
	`<task id="${ref.id}" agent="${ref.agent}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`

const describeSpawnable = (spawnable: ReadonlyArray<AgentDefinition>): string =>
	[
		"Hand a self-contained research question to a sub-agent. It runs its own tool loop and " +
			"returns a written answer; its raw tool output never enters this conversation, so this is " +
			"how you search broadly without burying the thread in payloads.",
		"",
		"The sub-agent sees NOTHING of this conversation — no history, no context, no attachments. " +
			"Its `prompt` must stand alone and name everything it needs. You cannot ask it a " +
			"follow-up, so ask for everything you need in one go.",
		"",
		"Launch several concurrently when the questions are independent.",
		"",
		"Available sub-agents:",
		...spawnable.map((agent) => `- ${agent.name}: ${agent.description}`),
	].join("\n")

/**
 * Build the `task` tool for `agent`, or nothing when it has no sub-agents to spawn.
 *
 * `runTurn` is injected rather than imported so this module does not import `./turn.ts` while
 * `./turn.ts` imports it — the recursion stays visible at the one call site that wires it.
 */
export const buildTaskTool = (
	input: ChatTurnInput,
	spawnable: ReadonlyArray<AgentDefinition>,
	budget: TaskBudget,
	runTurn: (child: ChatTurnInput) => Stream.Stream<ChatTurnEvent>,
): Tools => {
	if (spawnable.length === 0) return {}
	if ((input.depth ?? 0) >= SUBAGENT_MAX_DEPTH) return {}

	const names = spawnable.map((agent) => agent.name)

	return {
		task: Tool.make({
			description: describeSpawnable(spawnable),
			parameters: Schema.Struct({
				description: Schema.String.annotate({
					description: 'A 3-5 word label for the UI, e.g. "trace checkout latency".',
				}),
				prompt: Schema.String.annotate({
					description:
						"The complete instruction for the sub-agent. It sees nothing of this " +
						"conversation, so this must stand alone.",
				}),
				subagent_type: Schema.Literals(names).annotate({
					description: "Which sub-agent to run.",
				}),
			}),
			success: Schema.String,
			execute: (params, context) =>
				budget.semaphore.withPermits(1)(runTask(input, params, context?.id, budget, runTurn)),
		}),
	}
}

const runTask = (
	input: ChatTurnInput,
	params: { description: string; prompt: string; subagent_type: string },
	callId: string | undefined,
	budget: TaskBudget,
	runTurn: (child: ChatTurnInput) => Stream.Stream<ChatTurnEvent>,
): Effect.Effect<string, ToolFailure> =>
	Effect.gen(function* () {
		// Over budget is a `ToolFailure`, never a defect: the model is told to do the work inline
		// rather than having the whole turn die because it delegated once too often.
		if (budget.tasksStarted >= TASK_BUDGET_PER_TURN) {
			return yield* Effect.fail(
				new ToolFailure({
					message:
						`No sub-agent slots left this turn (limit ${TASK_BUDGET_PER_TURN}). ` +
						"Do this part of the work yourself with the tools you have.",
				}),
			)
		}
		if (!hasStepBudget(budget)) {
			return yield* Effect.fail(
				new ToolFailure({ message: "This turn is out of steps. Answer from what you have." }),
			)
		}

		const child = AGENTS[params.subagent_type]
		if (child === undefined || child.mode !== "subagent") {
			return yield* Effect.fail(
				new ToolFailure({ message: `Unknown sub-agent: ${params.subagent_type}` }),
			)
		}

		// The call id binds the child's events to the card the parent already announced. There is
		// always one in practice; the fallback keeps the tool usable outside a dispatch loop.
		const taskId = callId ?? crypto.randomUUID()
		budget.tasksStarted += 1

		const ref = {
			id: taskId,
			agent: child.name,
			parentMessageId: input.messageId,
		} as const

		/**
		 * The child's answer, as the parent will see it.
		 *
		 * Reset on every tool call because text a sub-agent emits *before* calling a tool is
		 * narration ("let me check the traces"), not findings. Only the run of text after its last
		 * tool call is the report.
		 */
		let answer = ""

		yield* runTurn({
			sessionId: input.sessionId,
			tenant: input.tenant,
			toolExecutor: input.toolExecutor,
			model: input.model,
			agent: child,
			messages: [Message.user(params.prompt)],
			messageId: crypto.randomUUID(),
			task: ref,
			depth: (input.depth ?? 0) + 1,
			taskBudget: budget,
			// Usage rolls up: a delegated search is still this turn's spend, and the org is billed
			// for it either way.
			...(input.usage ? { usage: input.usage } : undefined),
			...(input.isCurrent ? { isCurrent: input.isCurrent } : undefined),
			...(input.emit ? { emit: input.emit } : undefined),
		}).pipe(
			Stream.runForEach((event) =>
				Effect.sync(() => {
					input.emit?.(event)
					if (event.type === "text-delta") answer += event.text
					if (event.type === "tool-call") answer = ""
				}),
			),
			Effect.catchCause(() =>
				Effect.fail(new ToolFailure({ message: `The ${child.name} sub-agent failed.` })),
			),
		)

		const text = answer.trim()
		if (text === "") {
			return yield* Effect.fail(
				new ToolFailure({ message: `The ${child.name} sub-agent returned no result.` }),
			)
		}

		// Wrapped rather than bare so the model reliably reads it as a report from elsewhere instead
		// of mistaking it for its own prose.
		return renderResult(ref, text)
	})

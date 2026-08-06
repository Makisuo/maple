/**
 * Delegating to a sub-agent.
 *
 * The properties worth pinning are the ones that would be silent if broken: the context firewall
 * (the parent must never see the child's tool payloads), the event tagging (a child's events must
 * land in the card, not the conversation), and the budgets (a `ToolFailure`, never a defect).
 */
import { LLMClient, type LLMEvent, type LLMRequest, type Model } from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { Effect, Layer, Stream } from "effect"
import { assert, describe, it } from "vitest"
import { runChatTurn, type ChatTurnEvent } from "./index"
import { AGENTS } from "../agents"
import type { TenantContext } from "@/services/auth/tenant-context"

const TENANT: TenantContext = {
	orgId: "org_test" as TenantContext["orgId"],
	userId: "user_test" as TenantContext["userId"],
	roles: [],
	authMode: "self_hosted",
}

const MODEL: Model = CloudflareWorkersAI.configure({ accountId: "t", apiKey: "t" }).model("@cf/test/model")

const textDelta = (text: string): LLMEvent => ({ type: "text-delta", id: "t1", text }) as LLMEvent
const finish = (): LLMEvent => ({ type: "finish", reason: "stop" }) as LLMEvent
const call = (id: string, name: string, input: unknown = {}): LLMEvent =>
	({ type: "tool-call", id, name, input, providerExecuted: false }) as LLMEvent

const taskCall = (id: string, prompt = "why is checkout slow?"): LLMEvent =>
	call(id, "task", { description: "trace checkout", prompt, subagent_type: "explore" })

/**
 * Script the model by *which tools the request offers*, not by call order.
 *
 * The parent and the sub-agent interleave — the child's turn runs inside the parent's tool
 * dispatch — so a positional script would depend on scheduling. Keying on the presence of the
 * `task` tool identifies the caller unambiguously: only an agent that can spawn is offered it.
 */
const stubModel = (
	parent: ReadonlyArray<ReadonlyArray<LLMEvent>>,
	child: ReadonlyArray<ReadonlyArray<LLMEvent>>,
) => {
	let parentStep = 0
	let childStep = 0
	const service = {
		prepare: () => Effect.die(new Error("unused")),
		generate: () => Effect.die(new Error("unused")),
		stream: (request: LLMRequest) => {
			const isParent = request.tools.some((tool) => tool.name === "task")
			const scripted = isParent ? parent[parentStep++] : child[childStep++]
			return Stream.fromIterable(scripted ?? [finish()])
		},
	}
	return {
		layer: Layer.succeed(LLMClient.Service, service as never),
		childCalls: () => childStep,
	}
}

const run = (
	parent: ReadonlyArray<ReadonlyArray<LLMEvent>>,
	child: ReadonlyArray<ReadonlyArray<LLMEvent>>,
	overrides: { readonly isCurrent?: () => boolean } = {},
) => {
	const stub = stubModel(parent, child)
	const emitted: Array<ChatTurnEvent> = []
	return runChatTurn({
		sessionId: "org_test:tab",
		tenant: TENANT,
		model: MODEL,
		messages: [],
		messageId: "m1",
		emit: (event) => emitted.push(event),
		...(overrides.isCurrent ? { isCurrent: overrides.isCurrent } : {}),
	}).pipe(
		Stream.runCollect,
		Effect.map((events) => ({
			events: Array.from(events) as ChatTurnEvent[],
			emitted,
			childCalls: stub.childCalls(),
		})),
		Effect.provide(stub.layer),
	)
}

const resultsOf = (events: ReadonlyArray<ChatTurnEvent>) =>
	events.filter((event) => event.type === "tool-result")

describe("the task tool", () => {
	it("returns the sub-agent's final text, wrapped, and none of its tool payloads", async () => {
		const result = await Effect.runPromise(
			run(
				[
					[taskCall("t1"), finish()],
					[textDelta("Answered."), finish()],
				],
				[
					[call("x1", "search_traces"), finish()],
					[textDelta("p99 is 4.2s in checkout-api."), finish()],
				],
			),
		)

		const output = String(
			resultsOf(result.events)[0]?.type === "tool-result" ? resultsOf(result.events)[0]!.output : "",
		)
		assert.include(output, "<task_result>")
		assert.include(output, "p99 is 4.2s in checkout-api.")
		// The firewall. If the child's raw output reached the parent, delegation would be strictly
		// worse than calling the tools inline — it would cost an extra model call for nothing.
		assert.notInclude(output, "search_traces")
	})

	it("drops narration that preceded a tool call, keeping only the report", async () => {
		const result = await Effect.runPromise(
			run(
				[
					[taskCall("t1"), finish()],
					[textDelta("ok"), finish()],
				],
				[
					[textDelta("Let me check the traces."), call("x1", "search_traces"), finish()],
					[textDelta("The answer."), finish()],
				],
			),
		)

		const output = String(
			resultsOf(result.events)[0]?.type === "tool-result" ? resultsOf(result.events)[0]!.output : "",
		)
		assert.include(output, "The answer.")
		assert.notInclude(output, "Let me check")
	})

	it("tags every sub-agent event so it lands in the card, not the conversation", async () => {
		const result = await Effect.runPromise(
			run(
				[
					[taskCall("t1"), finish()],
					[textDelta("done"), finish()],
				],
				[[textDelta("child text"), finish()]],
			),
		)

		assert.isNotEmpty(result.emitted)
		for (const event of result.emitted) {
			// `compaction` is turn-runner bookkeeping and never reaches this sink; every other
			// member carries the ref.
			assert.notEqual(event.type, "compaction")
			assert.equal(
				event.type === "compaction" ? undefined : event.task?.id,
				"t1",
				`untagged ${event.type} would surface as a stray top-level message`,
			)
		}
		// And nothing from the child leaked into the parent's own stream.
		const parentText = result.events
			.filter((event) => event.type === "text-delta")
			.map((event) => (event.type === "text-delta" ? event.text : ""))
			.join("")
		assert.equal(parentText, "done")
	})

	it("refuses to delegate past the per-turn budget, as a tool failure not a defect", async () => {
		// Five task calls against a budget of four. The fifth must come back as a tool result the
		// model can route around, not kill the turn.
		const result = await Effect.runPromise(
			run(
				[
					[
						taskCall("t1"),
						taskCall("t2"),
						taskCall("t3"),
						taskCall("t4"),
						taskCall("t5"),
						finish(),
					],
					[textDelta("done"), finish()],
				],
				Array.from({ length: 6 }, () => [textDelta("child answer"), finish()]),
			),
		)

		const results = resultsOf(result.events)
		assert.lengthOf(results, 5)
		const failures = results.filter((event) => event.type === "tool-result" && event.isError === true)
		assert.lengthOf(failures, 1)
		assert.include(String(failures[0]?.type === "tool-result" ? failures[0].output : ""), "slots left")
		// The turn still completed normally.
		assert.lengthOf(
			result.events.filter((event) => event.type === "turn-end"),
			1,
		)
	}, 30_000)

	it("is not offered to an agent with no sub-agents", async () => {
		let offered: ReadonlyArray<string> = []
		const service = {
			prepare: () => Effect.die(new Error("unused")),
			generate: () => Effect.die(new Error("unused")),
			stream: (request: LLMRequest) => {
				offered = request.tools.map((tool) => tool.name)
				return Stream.fromIterable([textDelta("hi"), finish()])
			},
		}

		await Effect.runPromise(
			runChatTurn({
				sessionId: "org_test:tab",
				tenant: TENANT,
				model: MODEL,
				messages: [],
				messageId: "m1",
				agent: AGENTS["dashboard-builder"]!,
			}).pipe(Stream.runCollect, Effect.provide(Layer.succeed(LLMClient.Service, service as never))),
		)

		// Delegation is opt-in per agent: `dashboard-builder` has no `spawns`.
		assert.notInclude(offered, "task")
	})

	it("is not offered to a sub-agent, capping nesting structurally", async () => {
		let offered: ReadonlyArray<string> = []
		const service = {
			prepare: () => Effect.die(new Error("unused")),
			generate: () => Effect.die(new Error("unused")),
			stream: (request: LLMRequest) => {
				offered = request.tools.map((tool) => tool.name)
				return Stream.fromIterable([textDelta("hi"), finish()])
			},
		}

		await Effect.runPromise(
			runChatTurn({
				sessionId: "org_test:tab",
				tenant: TENANT,
				model: MODEL,
				messages: [],
				messageId: "c1",
				agent: AGENTS.explore!,
				depth: 1,
			}).pipe(Stream.runCollect, Effect.provide(Layer.succeed(LLMClient.Service, service as never))),
		)

		assert.notInclude(offered, "task")
		// And it really is read-only: no mutating tool is even visible.
		assert.notInclude(offered, "create_alert_rule")
	})

	it("stops the sub-agent when the parent turn is superseded", async () => {
		const result = await Effect.runPromise(
			run([[taskCall("t1"), finish()]], [[textDelta("child"), finish()]], {
				isCurrent: () => false,
			}),
		)

		// The child inherits the parent's `isCurrent` closure, so an abort reaches both without any
		// separate cancellation path.
		assert.equal(result.childCalls, 0)
		assert.isEmpty(result.events.filter((event) => event.type === "turn-end"))
	})
})

describe("the task tool's description", () => {
	it("names exactly the sub-agents the caller may spawn", async () => {
		let description: string | undefined
		const service = {
			prepare: () => Effect.die(new Error("unused")),
			generate: () => Effect.die(new Error("unused")),
			stream: (request: LLMRequest) => {
				description = request.tools.find((tool) => tool.name === "task")?.description
				return Stream.fromIterable([textDelta("hi"), finish()])
			},
		}

		await Effect.runPromise(
			runChatTurn({
				sessionId: "org_test:tab",
				tenant: TENANT,
				model: MODEL,
				messages: [],
				messageId: "m1",
			}).pipe(Stream.runCollect, Effect.provide(Layer.succeed(LLMClient.Service, service as never))),
		)

		// Generated from the registry, so the tool description and the system prompt cannot disagree
		// about what is delegable.
		assert.include(description ?? "", "explore")
		assert.include(description ?? "", AGENTS.explore!.description)
		// The one thing the model most needs to know, and the one it will otherwise get wrong.
		assert.include(description ?? "", "sees NOTHING of this conversation")
	})
})

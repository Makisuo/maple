/**
 * A headless pass must always be able to report what it found.
 *
 * This is the regression file for the defect that made investigations look lazy:
 * the turn loop's closing step was written for attended chat, where the answer is
 * prose, and sent `tools: []`. A pass whose answer *is* a tool call therefore
 * could not answer once it hit its step cap or its deadline — `runAgentPass`
 * returned `None`, the workflow recorded a `no_finding` lane, and an agent that
 * had investigated for its entire budget was indistinguishable from one that
 * never looked.
 *
 * The three cases below are the whole contract: out of steps still submits, out
 * of clock still submits, and genuine silence is still reported as silence.
 */
import { describe, it } from "@effect/vitest"
import { assert } from "vitest"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, type LLMRequest, type Model } from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { PermissionRule } from "@maple/domain/permission"
import { OrgId, UserId } from "@maple/domain"
import type { AgentDefinition } from "@/chat/agents"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { runAgentPass } from "./agent-pass"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const MODEL: Model = CloudflareWorkersAI.configure({
	accountId: "test",
	apiKey: "test",
}).model("@cf/test/model")

const finish = (): LLMEvent => ({ type: "finish", reason: "stop" }) as LLMEvent
const textDelta = (text: string): LLMEvent => ({ type: "text-delta", id: "t1", text }) as LLMEvent
const toolCall = (id: string, name: string, input: unknown = {}): LLMEvent =>
	({ type: "tool-call", id, name, input, providerExecuted: false }) as LLMEvent

/** A lane agent: three steps, read-only, and no ability to spawn anything. */
const AGENT: AgentDefinition = {
	name: "hypothesis-test",
	description: "test lane",
	mode: "subagent",
	prompt: "Test the hypothesis.",
	permission: [
		new PermissionRule({ tool: "*", action: "deny" }),
		new PermissionRule({ tool: "query_data", action: "allow" }),
	],
	steps: 3,
}

const SCHEMA = Schema.Struct({ claim: Schema.String })

const ToolExecutorStubLayer = Layer.succeed(McpToolExecutor, {
	execute: (_tenant, name) =>
		Effect.succeed({
			content: [{ type: "text" as const, text: `${name} completed` }],
		}),
})

const stub = (steps: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
	let step = 0
	const service = {
		prepare: () => Effect.die(new Error("prepare is not used")),
		generate: () => Effect.die(new Error("generate is not used")),
		stream: (_request: LLMRequest) => {
			const scripted = steps[step] ?? [finish()]
			step += 1
			return Stream.fromIterable(scripted)
		},
	}
	return Layer.succeed(LLMClient.Service, service as never)
}

const pass = (
	steps: ReadonlyArray<ReadonlyArray<LLMEvent>>,
	options: { readonly deadlineAtMs?: number } = {},
) =>
	runAgentPass({
		id: "inv_test_pass",
		agent: AGENT,
		tenant: TENANT,
		model: MODEL,
		prompt: "Test it.",
		submitToolName: "submit_candidate",
		submitToolDescription: "Record the candidate.",
		schema: SCHEMA,
		...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
	}).pipe(Effect.provide(stub(steps)), Effect.provide(ToolExecutorStubLayer))

/** Every step calls a tool, so the agent never voluntarily stops. */
const grinding = (count: number): ReadonlyArray<ReadonlyArray<LLMEvent>> =>
	Array.from({ length: count }, (_, i) => [toolCall("c1", "query_data", { page: i }), finish()])

describe("runAgentPass", () => {
	it.live("returns the answer when the agent submits on its own", () =>
		Effect.gen(function* () {
			const result = yield* pass([
				[toolCall("c1", "query_data", { page: 0 }), finish()],
				[toolCall("s1", "submit_candidate", { claim: "pool exhaustion" }), finish()],
			])
			assert.deepEqual(Option.getOrUndefined(result.answer), { claim: "pool exhaustion" })
			assert.equal(result.deadlineHit, false)
			// The submit call itself is not evidence gathering, so it is not counted.
			assert.equal(result.toolCalls, 1)
		}),
	)

	/**
	 * The core regression. The agent grinds through its whole step budget and only
	 * gets to answer on the forced closing step — which used to be handed no tools.
	 */
	it.live("still submits after exhausting its step budget", () =>
		Effect.gen(function* () {
			const result = yield* pass([
				...grinding(3),
				[toolCall("s1", "submit_candidate", { claim: "out of steps" }), finish()],
			])
			assert.deepEqual(Option.getOrUndefined(result.answer), { claim: "out of steps" })
		}),
	)

	/**
	 * The other half of the same defect. The deadline used to ride on `isCurrent`,
	 * the abort hook, so the loop returned an empty stream rather than closing.
	 */
	it.live("still submits, and reports deadlineHit, when the clock runs out", () =>
		Effect.gen(function* () {
			const result = yield* pass(
				[
					[toolCall("c1", "query_data", { page: 0 }), finish()],
					[toolCall("s1", "submit_candidate", { claim: "out of clock" }), finish()],
				],
				// Already past. The first check fires after the opening step's tools settle.
				{ deadlineAtMs: 0 },
			)
			assert.deepEqual(Option.getOrUndefined(result.answer), { claim: "out of clock" })
			assert.equal(result.deadlineHit, true)
		}),
	)

	/**
	 * Genuine silence is still silence. A pass that answers in prose and never
	 * calls its submit tool has produced no candidate, and the workflow is right to
	 * record a no-finding lane for it.
	 */
	it.live("returns None when the agent never submits", () =>
		Effect.gen(function* () {
			const result = yield* pass([[textDelta("I could not determine a cause."), finish()]])
			assert.isTrue(Option.isNone(result.answer))
		}),
	)
})

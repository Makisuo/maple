/**
 * `runChatTurn` — the event stream one submission produces.
 *
 * The model is a stub layer over `LLMClient`, so these assert the *turn loop*: what it emits, in
 * what order, and — the part that shipped wrong — what it does NOT emit once the turn is over.
 * Every failure mode here was invisible to `tsc` and to the branch's suite.
 */
import { assert, describe, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMClient, LLMEvent, type LLMRequest, type Model } from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { runChatTurn, type ChatTurnEvent } from "./agent"
import type { TenantContext } from "@/services/auth/tenant-context"

const TENANT: TenantContext = {
	orgId: "org_test" as TenantContext["orgId"],
	userId: "user_test" as TenantContext["userId"],
	roles: [],
	authMode: "self_hosted",
}

const MODEL: Model = CloudflareWorkersAI.configure({
	accountId: "test",
	apiKey: "test",
}).model("@cf/test/model")

/** A text delta, as the provider-neutral event the turn folds. */
const textDelta = (text: string): LLMEvent => ({ type: "text-delta", id: "t1", text }) as LLMEvent

const finish = (): LLMEvent => ({ type: "finish", reason: "stop" }) as LLMEvent

const toolCall = (id: string, name: string): LLMEvent =>
	({ type: "tool-call", id, name, input: {}, providerExecuted: false }) as LLMEvent

/**
 * Stub the model with a scripted event stream per step.
 *
 * `stream` is the only method the turn uses; `prepare`/`generate` are present because the service
 * interface has them and a partial stub would be a lie about what is being exercised.
 */
type Step =
	/** A clean step: these events, then the stream completes. */
	| ReadonlyArray<LLMEvent>
	/** The stream fails after emitting `events` — the realistic partial-stream case. */
	| { readonly events: ReadonlyArray<LLMEvent>; readonly fail: true }

const stubModel = (steps: ReadonlyArray<Step>) => {
	let step = 0
	const service = {
		prepare: () => Effect.die(new Error("prepare is not used by runChatTurn")),
		generate: () => Effect.die(new Error("generate is not used by runChatTurn")),
		stream: (_request: LLMRequest) => {
			const scripted = steps[step] ?? [finish()]
			step += 1
			// The vendored error shape the turn maps through `toLlmCallError`.
			const failure = {
				_tag: "LLMError",
				module: "test",
				method: "stream",
				reason: { _tag: "ProviderInternal" },
				message: "upstream exploded",
				retryable: true,
			} as never
			if (Array.isArray(scripted)) return Stream.fromIterable(scripted as ReadonlyArray<LLMEvent>)
			const partial = scripted as { events: ReadonlyArray<LLMEvent> }
			return Stream.concat(Stream.fromIterable(partial.events), Stream.fail(failure))
		},
	}
	return Layer.succeed(LLMClient.Service, service as never)
}

const collect = (
	steps: ReadonlyArray<Step>,
	overrides: { readonly sessionId?: string; readonly isCurrent?: () => boolean } = {},
) =>
	runChatTurn({
		sessionId: overrides.sessionId ?? "org_test:tab",
		tenant: TENANT,
		model: MODEL,
		messages: [],
		messageId: "m1",
		...(overrides.isCurrent ? { isCurrent: overrides.isCurrent } : {}),
	}).pipe(
		Stream.runCollect,
		Effect.map((events) => Array.from(events) as ChatTurnEvent[]),
		Effect.provide(stubModel(steps)),
	)

const types = (events: ReadonlyArray<ChatTurnEvent>) => events.map((event) => event.type)

const terminal = (events: ReadonlyArray<ChatTurnEvent>) =>
	events.filter((event) => event.type === "turn-end")

describe("runChatTurn", () => {
	it("emits turn-start, the text, and exactly one turn-end", async () => {
		const events = await Effect.runPromise(collect([[textDelta("Hello"), finish()]]))

		assert.deepEqual(types(events), ["turn-start", "text-delta", "turn-end"])
		assert.lengthOf(terminal(events), 1)
	})

	it("emits exactly ONE turn-end when the model stream fails", async () => {
		const events = await Effect.runPromise(collect([{ events: [textDelta("part")], fail: true }]))

		// The regression: `Stream.concat`'s second half ran unconditionally, so a failed stream that
		// still assembled a partial response emitted a second terminal event after the error one.
		// Both landed in the durable log; the SSE route stops at the first, so it only surfaced on
		// the next reload.
		assert.lengthOf(terminal(events), 1)
		const end = terminal(events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
	})

	it("dispatches NO tools when the stream fails after announcing one", async () => {
		// A partial stream that carries a tool call and then dies: `LLMResponse.fromEvents` will
		// happily assemble it, which is exactly how the second half used to run past the error.
		const events = await Effect.runPromise(
			collect([{ events: [toolCall("c1", "find_errors"), textDelta("partial")], fail: true }]),
		)

		assert.isEmpty(
			events.filter((event) => event.type === "tool-result"),
			"a failed turn must not run tools past its terminal event",
		)
	})

	it("stops on an approval-gated tool with a proposal and no result", async () => {
		const events = await Effect.runPromise(
			collect([[toolCall("c1", "create_alert_rule"), finish()]]),
		)

		const proposals = events.filter((event) => event.type === "tool-call")
		assert.lengthOf(proposals, 1)
		assert.equal(
			proposals[0]?.type === "tool-call" ? proposals[0].proposed : undefined,
			true,
			"a gated call is a proposal, not an execution",
		)
		// Nothing fabricates an outcome: the model is never told the mutation happened.
		assert.isEmpty(events.filter((event) => event.type === "tool-result"))
		assert.lengthOf(terminal(events), 1)
	})

	it("stops without a second terminal event when the turn is superseded", async () => {
		const events = await Effect.runPromise(
			collect([[textDelta("hi"), finish()]], { isCurrent: () => false }),
		)

		// An abort already recorded the terminal event on the session; emitting another here would
		// double-close the turn in the durable log.
		assert.isEmpty(terminal(events))
	})
})

/**
 * `runChatTurn` — the event stream one submission produces.
 *
 * The model is a stub layer over `LLMClient`, so these assert the *turn loop*: what it emits, in
 * what order, and — the part that shipped wrong — what it does NOT emit once the turn is over.
 * Every failure mode here was invisible to `tsc` and to the branch's suite.
 */
import { assert, describe, it } from "vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import {
	LLMClient,
	LLMEvent,
	Tool,
	type FinishReason,
	type LLMRequest,
	type Model,
	type Tools,
} from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { makeTurnObservability, runChatTurn, type ChatTurnEvent } from "./index"
import { MAX_STEP_ATTEMPTS } from "./budgets"
import { DEFAULT_RULESET } from "../permissions"
import type { AgentDefinition } from "../agents"
import { PermissionRule } from "@maple/domain/permission"
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

const finish = (reason: FinishReason = "stop"): LLMEvent => ({ type: "finish", reason }) as LLMEvent

const reasoningDelta = (text: string): LLMEvent => ({ type: "reasoning-delta", id: "r1", text }) as LLMEvent

const providerError = (
	message: string,
	options: { readonly retryable?: boolean; readonly classification?: "context-overflow" } = {},
): LLMEvent => ({ type: "provider-error", message, ...options }) as LLMEvent

/**
 * `input` matters to more than the tool: `stop.ts` fingerprints it, so a fixture that wants many
 * steps without tripping the repeated-batch detector has to vary it, and one that wants to trip the
 * detector has to hold it still.
 */
const toolCall = (id: string, name: string, input: unknown = {}): LLMEvent =>
	({ type: "tool-call", id, name, input, providerExecuted: false }) as LLMEvent

/**
 * Stub the model with a scripted event stream per step.
 *
 * `stream` is the only method the turn uses; `prepare`/`generate` are present because the service
 * interface has them and a partial stub would be a lie about what is being exercised.
 */
type Failure = {
	readonly events: ReadonlyArray<LLMEvent>
	readonly fail: true
	/**
	 * Vendored reason tag. Defaults to a retryable `ProviderInternal`; `"Authentication"` (or any
	 * other terminal reason) is how a test asserts the non-retrying path. Note that `Transport` and
	 * `InvalidProviderOutput` carry `retryable: false` on the wire and are still retried — see
	 * `./retry.ts`.
	 */
	readonly reason?: string
	readonly retryable?: boolean
}

type Step =
	/** A clean step: these events, then the stream completes. */
	| ReadonlyArray<LLMEvent>
	/** The stream fails after emitting `events` — the realistic partial-stream case. */
	| Failure

/** Every request the turn issued, in order. Lets a test assert on tools, toolChoice and messages. */
type RequestLog = Array<LLMRequest>

const stubModel = (steps: ReadonlyArray<Step>, log: RequestLog = []) => {
	let step = 0
	const service = {
		prepare: () => Effect.die(new Error("prepare is not used by runChatTurn")),
		generate: () => Effect.die(new Error("generate is not used by runChatTurn")),
		stream: (request: LLMRequest) => {
			log.push(request)
			const scripted = steps[step] ?? [finish()]
			step += 1
			if (Array.isArray(scripted)) return Stream.fromIterable(scripted as ReadonlyArray<LLMEvent>)
			const partial = scripted as Failure
			// The vendored error shape the turn maps through `toLlmCallError`.
			const failure = {
				_tag: "LLMError",
				module: "test",
				method: "stream",
				reason: { _tag: partial.reason ?? "ProviderInternal" },
				message: "upstream exploded",
				retryable: partial.retryable ?? partial.reason === undefined,
			} as never
			return Stream.concat(Stream.fromIterable(partial.events), Stream.fail(failure))
		},
	}
	return { layer: Layer.succeed(LLMClient.Service, service as never), log, calls: () => step }
}

interface CollectOverrides {
	readonly sessionId?: string
	readonly isCurrent?: () => boolean
	readonly softStop?: () => boolean
	readonly agent?: AgentDefinition
	readonly extraTools?: Tools
	readonly closingSubmit?: { readonly toolName: string }
}

const collect = (steps: ReadonlyArray<Step>, overrides: CollectOverrides = {}) => {
	const stub = stubModel(steps)
	const observability = makeTurnObservability()
	return runChatTurn({
		sessionId: overrides.sessionId ?? "org_test:tab",
		tenant: TENANT,
		model: MODEL,
		messages: [],
		messageId: "m1",
		observability,
		...(overrides.isCurrent ? { isCurrent: overrides.isCurrent } : {}),
		...(overrides.softStop ? { softStop: overrides.softStop } : {}),
		...(overrides.agent ? { agent: overrides.agent } : {}),
		...(overrides.extraTools ? { extraTools: overrides.extraTools } : {}),
		...(overrides.closingSubmit ? { closingSubmit: overrides.closingSubmit } : {}),
	}).pipe(
		Stream.runCollect,
		Effect.map((events) => Array.from(events) as ChatTurnEvent[]),
		Effect.provide(stub.layer),
		Effect.map((events) => ({ events, requests: stub.log, calls: stub.calls(), observability })),
	)
}

/** The common case: only the events matter. */
const collectEvents = (steps: ReadonlyArray<Step>, overrides: CollectOverrides = {}) =>
	collect(steps, overrides).pipe(Effect.map((result) => result.events))

const types = (events: ReadonlyArray<ChatTurnEvent>) => events.map((event) => event.type)

const terminal = (events: ReadonlyArray<ChatTurnEvent>) => events.filter((event) => event.type === "turn-end")

describe("runChatTurn", () => {
	it("emits turn-start, the text, and exactly one turn-end", async () => {
		const events = await Effect.runPromise(collectEvents([[textDelta("Hello"), finish()]]))

		assert.deepEqual(types(events), ["turn-start", "text-delta", "turn-end"])
		assert.lengthOf(terminal(events), 1)
	})

	it("coalesces adjacent text deltas into one event without losing any text", async () => {
		const chunks = ["Check", "ing ", "the ", "traces", "."]
		const events = await Effect.runPromise(collectEvents([[...chunks.map(textDelta), finish()]]))

		// One durable row, one SSE frame and one React commit per token is more fidelity than a
		// screen can show, and the transcript render cost is paid per commit.
		const deltas = events.filter((event) => event.type === "text-delta")
		assert.lengthOf(deltas, 1)
		assert.equal(
			deltas.map((event) => (event.type === "text-delta" ? event.text : "")).join(""),
			chunks.join(""),
		)
	})

	it("keeps text ahead of the tool calls it precedes", async () => {
		const events = await Effect.runPromise(
			collectEvents([
				[textDelta("Looking"), textDelta(" it up"), toolCall("c1", "create_alert_rule"), finish()],
			]),
		)

		// Batching must never reorder: the deltas live in one stream segment and the tool events in
		// the concatenated one after it, so a slow batch cannot overtake the call it introduced.
		assert.deepEqual(types(events), ["turn-start", "text-delta", "tool-call", "turn-end"])
		const delta = events.find((event) => event.type === "text-delta")
		assert.equal(delta?.type === "text-delta" ? delta.text : undefined, "Looking it up")
	})

	it("emits exactly ONE turn-end when the model stream fails terminally", async () => {
		const events = await Effect.runPromise(
			collectEvents([{ events: [textDelta("part")], fail: true, reason: "Authentication" }]),
		)

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
			collectEvents([
				{
					events: [toolCall("c1", "find_errors"), textDelta("partial")],
					fail: true,
					reason: "Authentication",
				},
			]),
		)

		assert.isEmpty(
			events.filter((event) => event.type === "tool-result"),
			"a failed turn must not run tools past its terminal event",
		)
	})

	it("stops on an approval-gated tool with a proposal and no result", async () => {
		const events = await Effect.runPromise(
			collectEvents([[toolCall("c1", "create_alert_rule"), finish()]]),
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
			collectEvents([[textDelta("hi"), finish()]], { isCurrent: () => false }),
		)

		// An abort already recorded the terminal event on the session; emitting another here would
		// double-close the turn in the durable log.
		assert.isEmpty(terminal(events))
	})
})

describe("runChatTurn completion outcomes", () => {
	it.each(["stop", "length"] as const)("recovers one blank %s completion", async (reason) => {
		const result = await Effect.runPromise(
			collect([[finish(reason)], [textDelta("Recovered answer."), finish()]]),
		)

		assert.equal(result.calls, 2)
		assert.equal(fold(result.events), "Recovered answer.")
		assert.lengthOf(retries(result.events), 1)
		const marker = retries(result.events)[0]
		assert.equal(marker?.type === "turn-retry" ? marker.reason : undefined, "EmptyOutput")
		assert.equal(marker?.type === "turn-retry" ? marker.delayMs : undefined, 0)
		assert.equal(result.observability.emptyOutput, true)
		assert.equal(result.observability.recoveryCount, 1)
		assert.equal(result.observability.outcome, "stop")
	})

	it("retracts whitespace before recovering", async () => {
		const result = await Effect.runPromise(
			collect([
				[textDelta("   "), finish()],
				[textDelta("Visible"), finish()],
			]),
		)

		const marker = retries(result.events)[0]
		assert.equal(marker?.type === "turn-retry" ? marker.retractChars : undefined, 3)
		assert.equal(fold(result.events), "Visible")
	})

	it("preserves reasoning in the private recovery request", async () => {
		const result = await Effect.runPromise(
			collect([
				[reasoningDelta("analysis only"), finish()],
				[textDelta("Visible"), finish()],
			]),
		)

		const recovery = result.requests[1]
		const reasoning = recovery?.messages
			.flatMap((message) => message.content)
			.filter((part) => part.type === "reasoning")
			.map((part) => part.text)
			.join("")
		assert.equal(reasoning, "analysis only")
		const instruction = recovery?.messages
			.at(-1)
			?.content.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
		assert.include(instruction ?? "", "without any visible answer")
		assert.isEmpty(result.events.filter((event) => event.type === "user-message"))
	})

	it("fails visibly after the one blank recovery is exhausted", async () => {
		const result = await Effect.runPromise(collect([[finish()], [finish()], [textDelta("never")]]))

		assert.equal(result.calls, 2)
		assert.lengthOf(retries(result.events), 1)
		assert.lengthOf(terminal(result.events), 1)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
		assert.equal(end?.type === "turn-end" ? end.error : undefined, "Maple didn't produce a response.")
	})

	it.each(["content-filter", "error", "unknown", "tool-calls"] as const)(
		"does not auto-retry a %s finish without deliverable output",
		async (reason) => {
			const result = await Effect.runPromise(collect([[finish(reason)], [textDelta("never")]]))
			assert.equal(result.calls, 1)
			assert.isEmpty(retries(result.events))
			const end = terminal(result.events)[0]
			assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
			assert.equal(
				end?.type === "turn-end" ? end.error : undefined,
				reason === "content-filter"
					? "Maple couldn't answer that request."
					: "Maple couldn't complete this response.",
			)
		},
	)

	it("retries a response-level provider error only when marked retryable", async () => {
		const retried = await Effect.runPromise(
			collect([[providerError("overloaded", { retryable: true })], [textDelta("ok"), finish()]]),
		)
		assert.equal(retried.calls, 2)
		assert.equal(fold(retried.events), "ok")
		assert.lengthOf(retries(retried.events), 1)

		const terminalFailure = await Effect.runPromise(
			collect([[providerError("invalid request")], [textDelta("never"), finish()]]),
		)
		assert.equal(terminalFailure.calls, 1)
		const end = terminal(terminalFailure.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
		assert.equal(
			end?.type === "turn-end" ? end.error : undefined,
			"Maple couldn't complete this response.",
		)
		assert.notInclude(end?.type === "turn-end" ? (end.error ?? "") : "", "invalid request")
	}, 10_000)

	it("fails a blank closing step instead of escaping the step bound", async () => {
		const result = await Effect.runPromise(
			collect([[toolCall("c1", "find_errors"), finish()], [finish()]], {
				agent: agentWith({ steps: 1 }),
			}),
		)

		assert.equal(result.calls, 2)
		assert.isEmpty(retries(result.events))
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
	})
})

describe("runChatTurn max steps", () => {
	it("spends a final tool-less step answering instead of stopping dead", async () => {
		// Ten steps that each call a read-only tool, then a text-only step. Each call carries
		// different arguments: this is a model working through a wide search, not one stuck on the
		// same question, and `stop.ts` must not confuse the two.
		const result = await Effect.runPromise(
			collect([
				...Array.from(
					{ length: 10 },
					(_, i): Step => [toolCall("c1", "find_errors", { page: i }), finish()],
				),
				[textDelta("Here is what I found."), finish()],
			]),
		)

		// The turn used to end here on a wall of tool rows with no words at all.
		const last = result.events[result.events.length - 2]
		assert.equal(last?.type, "text-delta")
		assert.equal(last?.type === "text-delta" ? last.text : undefined, "Here is what I found.")

		// The closing step cannot loop even if the model ignores the instruction.
		const closing = result.requests[result.requests.length - 1]
		assert.isEmpty(closing?.tools ?? [{}])
		assert.equal(closing?.toolChoice?.type, "none")

		// The signal the client badges on survives — it just arrives with an answer attached now.
		assert.lengthOf(terminal(result.events), 1)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "max-steps")
	}, 30_000)
})

describe("runChatTurn repeated tool calls", () => {
	/** The same call, forever — a model that has stopped reading the results it is being handed. */
	const stuck = (): Step => [toolCall("c1", "query_data", { sql: "select 1" }), finish()]

	it("stops well short of the step budget and still answers", async () => {
		const result = await Effect.runPromise(
			collect([
				...Array.from({ length: 3 }, stuck),
				[textDelta("I keep getting the same empty result."), finish()],
			]),
		)

		// Three identical batches trip it, so the closing step is the fourth request. `MAX_STEPS` is
		// 10 — compare the max-steps test above, where ten *varied* steps take eleven requests to
		// reach the same closing step. Seven of those were going to return what the first already had.
		assert.lengthOf(result.requests, 4)

		const last = result.events[result.events.length - 2]
		assert.equal(last?.type, "text-delta")
		assert.equal(
			last?.type === "text-delta" ? last.text : undefined,
			"I keep getting the same empty result.",
		)
	}, 30_000)

	it("settles the batch that tripped it rather than dropping it", async () => {
		const result = await Effect.runPromise(
			collect([...Array.from({ length: 3 }, stuck), [textDelta("Done."), finish()]]),
		)

		// Stopping *before* dispatching would leave the model's last call unanswered in the
		// transcript — a tool call with no result, which is exactly what the approval path is
		// careful never to produce.
		assert.lengthOf(
			result.events.filter((event) => event.type === "tool-result"),
			3,
		)
	}, 30_000)

	it("tells the model why it is being stopped", async () => {
		const result = await Effect.runPromise(
			collect([...Array.from({ length: 3 }, stuck), [textDelta("Done."), finish()]]),
		)

		const closing = result.requests[result.requests.length - 1]
		const notice = closing?.messages[closing.messages.length - 1]
		const text = notice?.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		// Named, not just forbidden: a model told only "stop" tends to report the plan it was
		// looping on as though it had carried it out.
		assert.include(text ?? "", "same tool calls several times")
		assert.isEmpty(closing?.tools ?? [{}])
		assert.equal(closing?.toolChoice?.type, "none")
	}, 30_000)

	it("does not fire when the model varies its arguments", async () => {
		const result = await Effect.runPromise(
			collect([
				...Array.from(
					{ length: 4 },
					(_, i): Step => [toolCall("c1", "query_data", { sql: `select ${i}` }), finish()],
				),
				[textDelta("Found it."), finish()],
			]),
		)

		// Four working steps plus the answer — no closing step was forced.
		assert.lengthOf(result.requests, 5)
	}, 30_000)
})

const retries = (events: ReadonlyArray<ChatTurnEvent>) =>
	events.filter((event) => event.type === "turn-retry")

const textOf = (events: ReadonlyArray<ChatTurnEvent>) =>
	events
		.filter((event) => event.type === "text-delta")
		.map((event) => (event.type === "text-delta" ? event.text : ""))
		.join("")

/** What a reader ends up with — the same concatenate-and-retract fold `ChatSession.history()` does. */
const fold = (events: ReadonlyArray<ChatTurnEvent>): string =>
	events.reduce((text, event) => {
		if (event.type === "text-delta") return text + event.text
		if (event.type === "turn-retry") return text.slice(0, Math.max(0, text.length - event.retractChars))
		return text
	}, "")

describe("runChatTurn retry", () => {
	it("retracts exactly what a sub-batch attempt had flushed, whatever that was", async () => {
		const result = await Effect.runPromise(
			collect([{ events: [textDelta("Hello wo")], fail: true }, [textDelta("Hello world."), finish()]]),
		)

		// Below `DELTA_BATCH_SIZE`, so whether this attempt emitted anything is a race between the
		// provider's failure and the 16ms window: `Stream.groupedWithin` drops a pending buffer on an
		// upstream failure, but a window that fires first ships it. Both are correct — the invariant
		// is that the marker takes back exactly what reached a consumer and no more, so the reader's
		// fold lands on the retry's text alone. Asserting a literal count here would be asserting
		// which fiber won.
		const retracted = retries(result.events)
		assert.lengthOf(retracted, 1)
		const at = result.events.findIndex((event) => event.type === "turn-retry")
		const marker = result.events[at]
		const flushedBefore = textOf(result.events.slice(0, at))
		assert.equal(marker?.type === "turn-retry" ? marker.retractChars : undefined, flushedBefore.length)
		assert.equal(result.calls, 2)
		assert.equal(fold(result.events), "Hello world.")
		assert.lengthOf(terminal(result.events), 1)
	})

	it("retracts exactly the text the failed attempt did flush", async () => {
		// A full batch (`DELTA_BATCH_SIZE`) flushes on the size cap regardless of timing, so this is
		// the deterministic stand-in for a real provider stream, where the 16ms window fires
		// constantly and most text has already shipped by the time the body dies.
		const flushed = Array.from({ length: 24 }, (_, i) => textDelta(String(i % 10)))
		const result = await Effect.runPromise(
			collect([
				{ events: [...flushed, textDelta("buffered")], fail: true },
				[textDelta("the real answer"), finish()],
			]),
		)

		// The test that catches duplicated text: without the retraction the durable fold reads the
		// abandoned prefix followed by the retry's text — permanently, because deltas concatenate
		// and the log is durable.
		const retracted = retries(result.events)
		assert.lengthOf(retracted, 1)
		const marker = retracted[0]
		assert.equal(marker?.type === "turn-retry" ? marker.retractChars : undefined, 24)
		assert.equal(marker?.type === "turn-retry" ? marker.attempt : undefined, 2)

		// Fold the whole event list the way `ChatSession.history()` does, and check the reader lands
		// on the retry's text alone — the abandoned prefix is gone, not doubled.
		assert.equal(fold(result.events), "the real answer")
	})

	it("retries a Transport failure even though it reports retryable: false", async () => {
		// The whole point of `./retry.ts`. `TransportReason` and `InvalidProviderOutputReason`
		// hardcode `retryable = false`, and they are exactly how a body that dies mid-stream
		// surfaces — a classifier that trusted the flag would pass a naive test and do nothing.
		for (const reason of ["Transport", "InvalidProviderOutput"]) {
			const result = await Effect.runPromise(
				collect([{ events: [], fail: true, reason, retryable: false }, [textDelta("ok"), finish()]]),
			)
			assert.equal(result.calls, 2, `${reason} should have been retried`)
			assert.equal(textOf(result.events), "ok")
		}
	})

	it("does not retry a failure that would fail identically", async () => {
		const result = await Effect.runPromise(
			collect([{ events: [], fail: true, reason: "Authentication" }, [textDelta("never"), finish()]]),
		)

		assert.equal(result.calls, 1)
		assert.isEmpty(retries(result.events))
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
	})

	it("gives up after the attempt budget and ends the turn once", async () => {
		const failing: Step = { events: [], fail: true }
		const result = await Effect.runPromise(
			collect([failing, failing, failing, failing, failing, failing]),
		)

		assert.equal(result.calls, MAX_STEP_ATTEMPTS)
		assert.lengthOf(retries(result.events), MAX_STEP_ATTEMPTS - 1)
		assert.lengthOf(terminal(result.events), 1)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
	}, 30_000)

	it("stops during backoff without emitting a terminal event", async () => {
		// `isCurrent` is re-checked after the sleep, so an abort landing mid-backoff wins. The DO
		// already wrote the terminal event when it cleared the claim.
		let current = true
		const result = await Effect.runPromise(
			collect([{ events: [textDelta("partial")], fail: true }, [textDelta("never"), finish()]], {
				isCurrent: () => {
					const value = current
					// Still current when the stream fails (so the retry is scheduled), superseded by
					// the time the backoff elapses.
					current = false
					return value
				},
			}),
		)

		assert.equal(result.calls, 1)
		assert.isEmpty(terminal(result.events))
	})
})

const agentWith = (overrides: Partial<AgentDefinition>): AgentDefinition => ({
	name: "test",
	description: "test",
	mode: "primary",
	prompt: "be brief",
	permission: DEFAULT_RULESET,
	...overrides,
})

const toolNames = (request: LLMRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name)

describe("runChatTurn permissions", () => {
	it("never offers the model a denied tool", () => {
		// Stronger and cheaper than refusing the call afterwards: a tool the model cannot see is a
		// tool it cannot be talked into trying.
		const ruleset = [
			new PermissionRule({ tool: "*", action: "allow" }),
			new PermissionRule({ tool: "create_*", action: "deny" }),
		]
		return Effect.runPromise(
			collect([[textDelta("ok"), finish()]], { agent: agentWith({ permission: ruleset }) }).pipe(
				Effect.map((result) => {
					const offered = toolNames(result.requests[0])
					assert.notInclude(offered, "create_alert_rule")
					assert.include(offered, "find_errors")
				}),
			),
		)
	})

	it("still offers an approval-gated tool, and still stops on it", async () => {
		// `ask` is visible-but-interrupting. Hiding it would make the model unable to propose the
		// mutation at all, which is not what approval means.
		const result = await Effect.runPromise(collect([[toolCall("c1", "create_alert_rule"), finish()]]))

		assert.include(toolNames(result.requests[0]), "create_alert_rule")
		const proposals = result.events.filter((event) => event.type === "tool-call")
		assert.lengthOf(proposals, 1)
		assert.equal(proposals[0]?.type === "tool-call" ? proposals[0].proposed : undefined, true)
	})

	it("executes a mutation when the ruleset allows it outright", async () => {
		// The capability rulesets unlock: an agent that is trusted with a tool no longer has to
		// round-trip through an approval card for it.
		const ruleset = [new PermissionRule({ tool: "*", action: "allow" })]
		const result = await Effect.runPromise(
			collect(
				[
					[toolCall("c1", "create_alert_rule"), finish()],
					[textDelta("done"), finish()],
				],
				{
					agent: agentWith({ permission: ruleset }),
				},
			),
		)

		const announced = result.events.filter((event) => event.type === "tool-call")
		assert.equal(announced[0]?.type === "tool-call" ? announced[0].proposed : undefined, undefined)
		assert.isNotEmpty(result.events.filter((event) => event.type === "tool-result"))
	})

	it("honours an agent's own step budget", async () => {
		const looping: Step = [toolCall("c1", "find_errors"), finish()]
		const result = await Effect.runPromise(
			collect([...Array.from({ length: 3 }, () => looping), [textDelta("summary"), finish()]], {
				agent: agentWith({ steps: 3 }),
			}),
		)

		// Three tool-calling steps, then the tool-less closing one.
		assert.equal(result.calls, 4)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "max-steps")
	}, 30_000)
})

describe("runChatTurn max steps, defensively", () => {
	it("ends rather than looping when a provider calls tools on the closing step", async () => {
		// The closing step is sent with `tools: []` and `toolChoice: "none"`. A provider that emits a
		// call anyway must not get another closing step, or `MAX_STEPS` stops being a bound at all.
		const looping: Step = [toolCall("c1", "find_errors"), finish()]
		const result = await Effect.runPromise(
			collect(
				Array.from({ length: 20 }, () => looping),
				{ agent: agentWith({ steps: 2 }) },
			),
		)

		// Two tool-calling steps, one closing step, then stop — not twenty.
		assert.equal(result.calls, 3)
		assert.lengthOf(terminal(result.events), 1)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "error")
	}, 30_000)
})

/**
 * The headless closing step.
 *
 * An attended turn answers in prose, so the step that closes it is sent with no
 * tools at all. An investigation answers *through* a tool, and that same closing
 * step silenced it: a pass that spent its whole budget gathering evidence could
 * not report any of it, and was recorded identically to one that never looked.
 */
describe("runChatTurn closing submit", () => {
	const SUBMIT = "submit_candidate"

	const submitTool = (record: Array<unknown>): Tools => ({
		[SUBMIT]: Tool.make({
			description: "Record the candidate.",
			parameters: Schema.Struct({ claim: Schema.String }),
			success: Schema.String,
			execute: (value) =>
				Effect.sync(() => {
					record.push(value)
					return "Recorded."
				}),
		}),
	})

	/** Ten tool-calling steps, then the model finally calls submit. */
	const exhaustingSteps = (): ReadonlyArray<Step> => [
		...Array.from({ length: 10 }, (_, i): Step => [toolCall("c1", "find_errors", { page: i }), finish()]),
		[toolCall("s1", SUBMIT, { claim: "pool exhaustion" }), finish()],
	]

	it("offers the submit tool, forced, when the turn runs out of steps", async () => {
		const submitted: Array<unknown> = []
		const result = await Effect.runPromise(
			collect(exhaustingSteps(), {
				extraTools: submitTool(submitted),
				closingSubmit: { toolName: SUBMIT },
			}),
		)

		const closing = result.requests[result.requests.length - 1]
		assert.lengthOf(closing?.tools ?? [], 1)
		assert.equal(closing?.tools?.[0]?.name, SUBMIT)
		assert.equal(closing?.toolChoice?.type, "tool")
		assert.equal(closing?.toolChoice?.name, SUBMIT)
	}, 30_000)

	it("dispatches the forced call, then ends without another step", async () => {
		const submitted: Array<unknown> = []
		const result = await Effect.runPromise(
			collect(exhaustingSteps(), {
				extraTools: submitTool(submitted),
				closingSubmit: { toolName: SUBMIT },
			}),
		)

		// The regression: the answer actually reaches the tool.
		assert.deepEqual(submitted, [{ claim: "pool exhaustion" }])
		// And the bound still holds — the closing step never recurses.
		assert.lengthOf(terminal(result.events), 1)
		const end = terminal(result.events)[0]
		assert.equal(end?.type === "turn-end" ? end.reason : undefined, "max-steps")
		assert.equal(result.calls, 11)
	}, 30_000)

	/**
	 * The deadline path. It used to ride on `isCurrent`, which is the *abort* hook,
	 * so a pass past its wall clock returned an empty stream and submitted nothing —
	 * indistinguishable from a pass that found nothing.
	 */
	it("closes with the submit tool when a soft stop fires mid-run", async () => {
		const submitted: Array<unknown> = []
		const result = await Effect.runPromise(
			collect(
				[
					[toolCall("c1", "find_errors", { page: 0 }), finish()],
					[toolCall("s1", SUBMIT, { claim: "out of clock" }), finish()],
				],
				{
					extraTools: submitTool(submitted),
					closingSubmit: { toolName: SUBMIT },
					// Checked after the first real tool step, which is when the forced submit closes it.
					softStop: () => true,
				},
			),
		)

		assert.deepEqual(submitted, [{ claim: "out of clock" }])
		assert.equal(
			terminal(result.events)[0]?.type === "turn-end"
				? (terminal(result.events)[0] as { reason: string }).reason
				: undefined,
			"max-steps",
		)
	}, 30_000)

	/**
	 * A hard abort is still a hard abort: the session already wrote a terminal
	 * event, so this turn must write nothing more — no closing step, no submit.
	 */
	it("still writes nothing when isCurrent goes false", async () => {
		const submitted: Array<unknown> = []
		const events = await Effect.runPromise(
			collectEvents([[textDelta("hi"), finish()]], {
				extraTools: submitTool(submitted),
				closingSubmit: { toolName: SUBMIT },
				isCurrent: () => false,
			}),
		)
		assert.isEmpty(terminal(events))
		assert.isEmpty(submitted)
	})
})

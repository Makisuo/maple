/**
 * What a chat turn charges, and under which idempotency key.
 *
 * The key is the whole subject. Metering used to hang off `submit_diagnosis` keyed on the bare
 * investigation id, so an investigation was billed once no matter how many turns it went on to
 * cost — and a turn that failed before reaching the tool was billed nothing at all. Most of the
 * assertions here are about a charge that used to be silently deduplicated away.
 *
 * The rest are about the routing: `meterTurn` is the single meter on this path, so it has to
 * charge an investigation turn as `triage` and an attended chat turn as `chat`, and never both.
 */
import { Effect } from "effect"
import { afterEach, assert, beforeEach, describe, it } from "vitest"
import { meterTurn } from "./turn-runner"

const ORG = "org_test"
const INVESTIGATION = "0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40"

const tenant = { orgId: ORG }

const env = { AUTUMN_SECRET_KEY: "sk_test" }

const turn = (sessionId: string, messageId: string) => ({ sessionId, messageId, env })

interface Tracked {
	readonly featureId: string
	readonly value: number
	readonly key: string
}

/** The track body the tracker builds; read back field by field rather than asserted into shape. */
const trackedFrom = (body: unknown): Tracked => {
	const fields = body as Record<string, unknown>
	return {
		featureId: String(fields["feature_id"]),
		value: Number(fields["value"]),
		key: String(fields["idempotency_key"]),
	}
}

let tracked: Array<Tracked>
let realFetch: typeof globalThis.fetch

beforeEach(() => {
	tracked = []
	realFetch = globalThis.fetch
	globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		tracked.push(trackedFrom(JSON.parse(typeof init?.body === "string" ? init.body : "{}")))
		return new Response("{}", { status: 200 })
	}
})

afterEach(() => {
	globalThis.fetch = realFetch
})

const meter = (sessionId: string, messageId: string, input: number, output: number) =>
	Effect.runPromise(meterTurn(turn(sessionId, messageId), tenant, { input, output }))

const keysFor = (featureId: string) => tracked.filter((t) => t.featureId === featureId).map((t) => t.key)

describe("meterTurn", () => {
	it("charges input and output under a key that carries the turn", async () => {
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1200, 340)

		assert.deepEqual(
			tracked.map((t) => ({ featureId: t.featureId, value: t.value })),
			[
				{ featureId: "ai_input_tokens", value: 1200 },
				{ featureId: "ai_output_tokens", value: 340 },
			],
		)
		assert.deepEqual(keysFor("ai_input_tokens"), [`${INVESTIGATION}:turn-msg-1:triage:input`])
		assert.deepEqual(keysFor("ai_output_tokens"), [`${INVESTIGATION}:turn-msg-1:triage:output`])
	})

	it("bills every turn of an investigation, not just the first", async () => {
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1000, 100)
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-2", 2000, 200)
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-3", 3000, 300)

		// The regression this guards: one shared key collapsed all three follow-ups into one charge.
		assert.deepEqual(keysFor("ai_input_tokens"), [
			`${INVESTIGATION}:turn-msg-1:triage:input`,
			`${INVESTIGATION}:turn-msg-2:triage:input`,
			`${INVESTIGATION}:turn-msg-3:triage:input`,
		])
		assert.strictEqual(
			tracked.filter((t) => t.featureId === "ai_input_tokens").reduce((sum, t) => sum + t.value, 0),
			6000,
		)
	})

	it("reuses one key across retries of the same turn", async () => {
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1000, 100)
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1000, 100)

		assert.deepEqual(keysFor("ai_input_tokens"), [
			`${INVESTIGATION}:turn-msg-1:triage:input`,
			`${INVESTIGATION}:turn-msg-1:triage:input`,
		])
	})

	it("keeps its keys disjoint from the fan-out's attempt keys", async () => {
		// The fan-out meters the same investigation as `<id>:<attempt>`. A turn id that happens to
		// be "1" must not land on the key attempt 1 already used, or one of the two goes unbilled.
		await meter(`${ORG}:inv-${INVESTIGATION}`, "1", 500, 50)

		assert.deepEqual(keysFor("ai_input_tokens"), [`${INVESTIGATION}:turn-1:triage:input`])
		assert.notInclude(keysFor("ai_input_tokens"), `${INVESTIGATION}:1:triage:input`)
	})

	it("charges a turn that spent only input", async () => {
		// A turn that died mid-step still burned its prompt. It used to bill nothing at all.
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 900, 0)

		assert.deepEqual(
			tracked.map((t) => t.featureId),
			["ai_input_tokens"],
		)
	})

	it("charges nothing for a turn that spent nothing", async () => {
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 0, 0)

		assert.deepEqual(tracked, [])
	})

	it("charges a plain chat session as `chat`, keyed on the session and the turn", async () => {
		await meter(`${ORG}:default`, "msg-1", 1000, 100)

		assert.deepEqual(keysFor("ai_input_tokens"), [`${ORG}:default:msg-1:chat:input`])
		assert.deepEqual(keysFor("ai_output_tokens"), [`${ORG}:default:msg-1:chat:output`])
	})

	it("bills an investigation turn once, not once per source", async () => {
		// The merge hazard this guards: two meters on the same tail, one keyed `triage` and one
		// `chat`. The source segment makes those keys disjoint, so nothing would deduplicate them
		// and every investigation turn would bill twice.
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1000, 100)

		assert.deepEqual(keysFor("ai_input_tokens"), [`${INVESTIGATION}:turn-msg-1:triage:input`])
		assert.deepEqual(keysFor("ai_output_tokens"), [`${INVESTIGATION}:turn-msg-1:triage:output`])
	})

	it("gives up on a tracker that never answers, rather than holding the turn slot", async () => {
		// `endTurn` waits on this finalizer, and a wedged slot is only reclaimed after 15 minutes.
		globalThis.fetch = () => new Promise<Response>(() => {})

		const started = Date.now()
		await meter(`${ORG}:inv-${INVESTIGATION}`, "msg-1", 1000, 100)

		assert.isBelow(Date.now() - started, 30_000, "metering did not give up")
		assert.deepEqual(tracked, [])
	})

	it("charges an `inv-` tab whose id is not an investigation id as plain chat", async () => {
		// Same guard `submit_diagnosis` applies: the set of sessions that bill as *triage* is
		// exactly the set that gets the tool. It is still a turn, so it still bills — as chat.
		await meter(`${ORG}:inv-not-a-uuid`, "msg-1", 1000, 100)

		assert.deepEqual(keysFor("ai_input_tokens"), [`${ORG}:inv-not-a-uuid:msg-1:chat:input`])
	})

	it("bounds the tracker request itself, not just the finalizer", async () => {
		// Belt and braces: `METERING_TIMEOUT` abandons the wait, `TRACK_TIMEOUT_MS` aborts the
		// request. Without the abort the fetch outlives the turn on an isolate that is winding down.
		const signals: Array<AbortSignal | null | undefined> = []
		const passthrough = globalThis.fetch
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init?.signal)
			return passthrough(input, init)
		}

		await meter(`${ORG}:default`, "msg-1", 1000, 100)

		assert.isNotEmpty(signals)
		for (const signal of signals) assert.instanceOf(signal, AbortSignal)
	})
})

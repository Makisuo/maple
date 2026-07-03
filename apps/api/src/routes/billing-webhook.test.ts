import { createHmac } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { extractCustomerId, verifySvixSignature } from "./billing-webhook.http"

const KEY_BYTES = Buffer.alloc(24, 9)
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`
const SVIX_ID = "msg_123"
const SVIX_TS = "1700000000"
const ON_TIME_MS = Number(SVIX_TS) * 1000 // same instant the message was stamped

const sign = (body: string) =>
	`v1,${createHmac("sha256", KEY_BYTES).update(`${SVIX_ID}.${SVIX_TS}.${body}`).digest("base64")}`

const verify = (input: {
	secret?: string
	body: string
	signatureHeader: string
	nowMs?: number
}) =>
	Effect.runPromise(
		verifySvixSignature({
			secret: input.secret ?? SECRET,
			svixId: SVIX_ID,
			svixTimestamp: SVIX_TS,
			body: input.body,
			signatureHeader: input.signatureHeader,
			nowMs: input.nowMs ?? ON_TIME_MS,
		}),
	)

describe("verifySvixSignature", () => {
	it("accepts a correctly signed payload", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		expect(await verify({ body, signatureHeader: sign(body) })).toBe(true)
	})

	it("accepts when one of several signature tokens matches", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		expect(await verify({ body, signatureHeader: `v1,deadbeef ${sign(body)}` })).toBe(true)
	})

	it("rejects a tampered body", async () => {
		const signature = sign(JSON.stringify({ type: "billing.updated" }))
		expect(await verify({ body: JSON.stringify({ type: "evil" }), signatureHeader: signature })).toBe(
			false,
		)
	})

	it("rejects a signature made with the wrong secret", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		const wrong = `v1,${createHmac("sha256", Buffer.alloc(24, 1)).update(`${SVIX_ID}.${SVIX_TS}.${body}`).digest("base64")}`
		expect(await verify({ body, signatureHeader: wrong })).toBe(false)
	})

	it("rejects a replayed (stale) but validly-signed payload", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		// Same valid signature, but "now" is 10 minutes after the stamped time.
		expect(
			await verify({ body, signatureHeader: sign(body), nowMs: ON_TIME_MS + 10 * 60 * 1000 }),
		).toBe(false)
	})

	it("rejects a timestamp too far in the future (clock skew / replay)", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		expect(
			await verify({ body, signatureHeader: sign(body), nowMs: ON_TIME_MS - 10 * 60 * 1000 }),
		).toBe(false)
	})

	it("accepts a timestamp within the tolerance window", async () => {
		const body = JSON.stringify({ type: "billing.updated" })
		expect(
			await verify({ body, signatureHeader: sign(body), nowMs: ON_TIME_MS + 4 * 60 * 1000 }),
		).toBe(true)
	})
})

describe("extractCustomerId", () => {
	it("reads data.customer_id", () => {
		expect(extractCustomerId({ type: "billing.updated", data: { customer_id: "org_a" } })).toBe(
			"org_a",
		)
	})

	it("reads nested data.customer.id", () => {
		expect(extractCustomerId({ data: { customer: { id: "org_b" } } })).toBe("org_b")
	})

	it("reads a top-level customerId", () => {
		expect(extractCustomerId({ customerId: "org_c" })).toBe("org_c")
	})

	it("returns null when no customer id is present", () => {
		expect(extractCustomerId({ data: {} })).toBeNull()
		expect(extractCustomerId(null)).toBeNull()
	})
})

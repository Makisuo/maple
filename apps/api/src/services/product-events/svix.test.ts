import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { readSvixHeaders, signSvix, verifySvixSignature } from "./svix"

// The vector the svix client libraries ship in their own test suites.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const MSG_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek"
const TIMESTAMP = "1614265330"
const BODY = '{"test": 2432232314}'
const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
const NOW_MS = 1614265330 * 1000

const headers = (overrides: Partial<Record<"svix-id" | "svix-timestamp" | "svix-signature", string>> = {}) =>
	readSvixHeaders({
		"svix-id": MSG_ID,
		"svix-timestamp": TIMESTAMP,
		"svix-signature": SIGNATURE,
		...overrides,
	})

const verify = (options: Partial<Parameters<typeof verifySvixSignature>[0]> = {}) =>
	verifySvixSignature({ secret: SECRET, headers: headers(), body: BODY, nowMs: NOW_MS, ...options })

describe("svix", () => {
	it.effect("signs the known vector", () =>
		Effect.gen(function* () {
			const signature = yield* signSvix(SECRET, MSG_ID, TIMESTAMP, BODY)
			assert.strictEqual(`v1,${signature}`, SIGNATURE)
		}),
	)

	it.effect("accepts a valid delivery", () =>
		Effect.gen(function* () {
			yield* verify()
		}),
	)

	it.effect("accepts when the matching signature is one of several (secret rotation)", () =>
		Effect.gen(function* () {
			yield* verify({ headers: headers({ "svix-signature": `v1,AAAA= ${SIGNATURE} v2,ignored` }) })
		}),
	)

	it.effect("rejects a tampered body", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(verify({ body: '{"test": 1}' }))
			assert.strictEqual(error.reason, "signature_mismatch")
		}),
	)

	it.effect("rejects a stale timestamp (> 5 min) even with a valid signature", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(verify({ nowMs: NOW_MS + 6 * 60 * 1000 }))
			assert.strictEqual(error.reason, "stale_timestamp")
		}),
	)

	it.effect("rejects missing headers and a wrong secret", () =>
		Effect.gen(function* () {
			const missing = yield* Effect.flip(verify({ headers: headers({ "svix-signature": "" }) }))
			assert.strictEqual(missing.reason, "missing_headers")
			const wrongSecret = yield* Effect.flip(verify({ secret: "whsec_AAAAAAAAAAAAAAAAAAAAAA==" }))
			assert.strictEqual(wrongSecret.reason, "signature_mismatch")
		}),
	)
})

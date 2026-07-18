import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { annotateAuthSpan } from "./auth-span"

// Proves the helper writes the auth-method attributes onto the *current* span
// (the mechanism the auth middlewares rely on to tag the HTTP server span that
// also carries `http.route`). Co-location with `http.route` on the same span is
// confirmed post-deploy via the live warehouse query in the plan.
describe("annotateAuthSpan", () => {
	it.effect("tags the current span as api_key with the key id", () =>
		Effect.gen(function* () {
			yield* annotateAuthSpan("api_key", {
				orgId: "org_test",
				userId: "user_test",
				keyId: "key_test",
			})
			const span = yield* Effect.currentSpan
			assert.strictEqual(span.attributes.get("maple.auth.method"), "api_key")
			assert.strictEqual(span.attributes.get("maple.org_id"), "org_test")
			assert.strictEqual(span.attributes.get("tenant.userId"), "user_test")
			assert.strictEqual(span.attributes.get("maple.api_key.id"), "key_test")
		}).pipe(Effect.withSpan("test-root")))

	it.effect("tags the current span as session and omits the key id", () =>
		Effect.gen(function* () {
			yield* annotateAuthSpan("session", { orgId: "org_test", userId: "user_test" })
			const span = yield* Effect.currentSpan
			assert.strictEqual(span.attributes.get("maple.auth.method"), "session")
			assert.strictEqual(span.attributes.get("maple.org_id"), "org_test")
			assert.strictEqual(span.attributes.get("tenant.userId"), "user_test")
			assert.strictEqual(span.attributes.get("maple.api_key.id"), undefined)
		}).pipe(Effect.withSpan("test-root")))
})

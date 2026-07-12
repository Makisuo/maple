import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UpsertDigestSubscriptionRequest } from "./http/digest.ts"
import { UpdateOnboardingStateRequest } from "./http/onboarding.ts"
import { UpdateScrapeTargetRequest } from "./http/scrape-targets.ts"
import { CreateApiKeyRequest } from "./http/api-keys.ts"

/**
 * Verifies `Schema.optionalKey` semantics on JSON-decoded HTTP request models:
 * an optional key may be omitted entirely, but a required key must still be
 * enforced. Decoding is synchronous (no decoding services), so plain Vitest is
 * sufficient here — no `@effect/vitest` harness needed.
 */
type DecodeResult<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly error: string }

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): DecodeResult<A> => {
	try {
		return { ok: true, value: Schema.decodeUnknownSync(schema)(value) }
	} catch (error) {
		return { ok: false, error: String(error).split("\n")[0] }
	}
}

const expectOk = <A>(result: DecodeResult<A>): void => {
	if (!result.ok) throw new Error(`expected decode to succeed, got: ${result.error}`)
}

const expectFail = <A>(result: DecodeResult<A>): void => {
	expect(result.ok).toBe(false)
}

describe("optionalKey HTTP request schemas", () => {
	describe("optional keys may be omitted", () => {
		it("onboarding: all-optional class decodes {}", () => {
			expectOk(decode(UpdateOnboardingStateRequest, {}))
		})
		it("onboarding: decodes a partial subset", () => {
			expectOk(decode(UpdateOnboardingStateRequest, { markOnboardingComplete: true }))
		})
		it("scrape-target update: decodes {}", () => {
			expectOk(decode(UpdateScrapeTargetRequest, {}))
		})
		it("digest: decodes with only the required email", () => {
			expectOk(decode(UpsertDigestSubscriptionRequest, { email: "a@b.com" }))
		})
		it("api-key: decodes with only the required name", () => {
			expectOk(decode(CreateApiKeyRequest, { name: "ci" }))
		})
	})

	describe("required keys are still enforced", () => {
		it("digest: rejects a payload missing the required email", () => {
			expectFail(decode(UpsertDigestSubscriptionRequest, {}))
		})
		it("api-key: rejects a payload missing the required name", () => {
			expectFail(decode(CreateApiKeyRequest, {}))
		})
	})
})

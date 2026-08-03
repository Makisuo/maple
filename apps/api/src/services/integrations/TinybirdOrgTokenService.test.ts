import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { TestClock } from "effect/testing"
import { TinybirdOrgTokenService } from "./TinybirdOrgTokenService"
import { Env } from "@/lib/Env"

const SIGNING_KEY = "explicit-test-signing-key"
const asOrgId = Schema.decodeUnknownSync(OrgId)

const testConfig = (extra: Record<string, string> = {}, includeSigning = true) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "api-token-is-not-the-signing-key",
			...(includeSigning
				? {
						TINYBIRD_SIGNING_KEY: SIGNING_KEY,
						TINYBIRD_WORKSPACE_ID: "ws-uuid-abc",
					}
				: {}),
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			...extra,
		}),
	)

const layer = TinybirdOrgTokenService.layer.pipe(Layer.provide(Env.layer), Layer.provide(testConfig()))

const decodePayload = (jwt: string) =>
	JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as {
		workspace_id: string
		exp: number
		scopes: ReadonlyArray<{ resource: string; filter: string }>
	}

describe("TinybirdOrgTokenService", () => {
	it.effect("mints a workspace-scoped token whose scopes are all filtered to the org", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const token = yield* svc.getOrgReadToken(asOrgId("org_a"))
			const payload = decodePayload(token)
			assert.strictEqual(payload.workspace_id, "ws-uuid-abc")
			assert.isAbove(payload.scopes.length, 0)
			assert.isTrue(payload.scopes.every((s) => s.filter === "OrgId = 'org_a'"))
		}).pipe(Effect.provide(layer)),
	)

	it.effect("returns the cached token on a second call within its lifetime", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken(asOrgId("org_a"))
			// Advance well within the (ttl - skew = 540s) window.
			yield* TestClock.setTime(120_000)
			const second = yield* svc.getOrgReadToken(asOrgId("org_a"))
			assert.strictEqual(second, first)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("re-mints after the cached token nears expiry", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken(asOrgId("org_a"))
			// Past the 540s re-mint deadline → new token (later exp).
			yield* TestClock.setTime(600_000)
			const second = yield* svc.getOrgReadToken(asOrgId("org_a"))
			assert.notStrictEqual(second, first)
			assert.isAbove(decodePayload(second).exp, decodePayload(first).exp)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("issues distinct tokens per org", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const a = yield* svc.getOrgReadToken(asOrgId("org_a"))
			const b = yield* svc.getOrgReadToken(asOrgId("org_b"))
			assert.notStrictEqual(a, b)
			assert.isTrue(decodePayload(b).scopes.every((s) => s.filter === "OrgId = 'org_b'"))
		}).pipe(Effect.provide(layer)),
	)

	it.effect("returns a typed error when signing configuration is missing", () => {
		const missingLayer = TinybirdOrgTokenService.layer.pipe(
			Layer.provide(Env.layer),
			Layer.provide(testConfig({}, false)),
		)
		return Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const error = yield* Effect.flip(svc.getOrgReadToken(asOrgId("org_a")))
			assert.strictEqual(error.reason, "MissingSigningKey")
			assert.notInclude(error.message, "api-token-is-not-the-signing-key")
		}).pipe(Effect.provide(missingLayer))
	})

	it.effect("returns a typed error for an empty workspace id", () => {
		const malformedLayer = TinybirdOrgTokenService.layer.pipe(
			Layer.provide(Env.layer),
			Layer.provide(testConfig({ TINYBIRD_WORKSPACE_ID: "" })),
		)
		return Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const error = yield* Effect.flip(svc.getOrgReadToken(asOrgId("org_a")))
			assert.strictEqual(error.reason, "MissingWorkspaceId")
		}).pipe(Effect.provide(malformedLayer))
	})
})

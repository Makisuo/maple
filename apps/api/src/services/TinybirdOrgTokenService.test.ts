import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { TinybirdOrgTokenService } from "./TinybirdOrgTokenService"
import { Env } from "@/lib/Env"

// A Tinybird-style admin token whose base64 payload carries the workspace id (`u`).
const ADMIN_TOKEN = `p.${Buffer.from(JSON.stringify({ u: "ws-uuid-abc", id: "tok", host: "eu_shared" })).toString("base64")}.sig`

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: ADMIN_TOKEN,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
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
			const token = yield* svc.getOrgReadToken("org_a")
			const payload = decodePayload(token)
			assert.strictEqual(payload.workspace_id, "ws-uuid-abc")
			assert.isAbove(payload.scopes.length, 0)
			assert.isTrue(payload.scopes.every((s) => s.filter === "OrgId = 'org_a'"))
		}).pipe(Effect.provide(layer)),
	)

	it.effect("returns the cached token on a second call within its lifetime", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken("org_a")
			// Advance well within the (ttl - skew = 540s) window.
			yield* TestClock.setTime(120_000)
			const second = yield* svc.getOrgReadToken("org_a")
			assert.strictEqual(second, first)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("re-mints after the cached token nears expiry", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken("org_a")
			// Past the 540s re-mint deadline → new token (later exp).
			yield* TestClock.setTime(600_000)
			const second = yield* svc.getOrgReadToken("org_a")
			assert.notStrictEqual(second, first)
			assert.isAbove(decodePayload(second).exp, decodePayload(first).exp)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("issues distinct tokens per org", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const a = yield* svc.getOrgReadToken("org_a")
			const b = yield* svc.getOrgReadToken("org_b")
			assert.notStrictEqual(a, b)
			assert.isTrue(decodePayload(b).scopes.every((s) => s.filter === "OrgId = 'org_b'"))
		}).pipe(Effect.provide(layer)),
	)
})

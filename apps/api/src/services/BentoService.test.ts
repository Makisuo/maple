import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { BentoService } from "./BentoService"

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

const BASE_CONFIG = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	BENTO_API_BASE_URL: "https://bento.test/api/v1",
}

const CREDENTIALS = {
	BENTO_SITE_UUID: "site-uuid",
	BENTO_PUBLISHABLE_KEY: "pk-test",
	BENTO_SECRET_KEY: "sk-test",
}

/** Records every outbound request so a suppressed call can be proven silent. */
const recordingFetch = () => {
	const calls: Array<{ url: string; headers: Headers; body: string }> = []
	const stub = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		// Read through Request so the assertion doesn't depend on how the client
		// encodes the body (string, Uint8Array or stream).
		calls.push({
			url,
			headers: new Headers(init?.headers),
			body: await new Request(url, { ...init, method: init?.method ?? "POST" }).text(),
		})
		return new Response(JSON.stringify({ results: 1, failed: 0 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	}) as typeof globalThis.fetch
	return { calls, stub }
}

const makeLayer = (config: Record<string, string>, stub: typeof globalThis.fetch) =>
	BentoService.layer.pipe(
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub)),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...BASE_CONFIG, ...config }))),
	)

describe("BentoService", () => {
	it.effect("is disabled outside production even when credentials are present", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			assert.strictEqual(bento.isConfigured, false)

			const result = yield* bento
				.trackEvent({ email: "user@example.com", type: "maple.onboarding.started" })
				.pipe(Effect.flip)

			assert.strictEqual(result._tag, "@maple/errors/BentoSuppressedError")
			// The gate must prevent the call, not merely report an error after it.
			assert.strictEqual(calls.length, 0)
		}).pipe(Effect.provide(makeLayer({ ...CREDENTIALS, MAPLE_ENVIRONMENT: "pr-42" }, stub)))
	})

	it.effect("is disabled in production when the secret is absent", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			assert.strictEqual(bento.isConfigured, false)

			const result = yield* bento
				.trackEvent({ email: "user@example.com", type: "maple.onboarding.started" })
				.pipe(Effect.flip)

			assert.strictEqual(result._tag, "@maple/errors/BentoSuppressedError")
			assert.strictEqual(calls.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					{
						MAPLE_ENVIRONMENT: "production",
						BENTO_SITE_UUID: "site-uuid",
						BENTO_PUBLISHABLE_KEY: "pk-test",
					},
					stub,
				),
			),
		)
	})

	it.effect("the non-prod escape hatch is separate from the alerting one", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			// MAPLE_ALERTING_ALLOW_NONPROD must not open the Bento gate — running the
			// crons on a stage to debug them is routine and must stay contact-safe.
			assert.strictEqual(bento.isConfigured, false)
			assert.strictEqual(calls.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					{ ...CREDENTIALS, MAPLE_ENVIRONMENT: "staging", MAPLE_ALERTING_ALLOW_NONPROD: "1" },
					stub,
				),
			),
		)
	})

	it.effect("sends events with basic auth, the site_uuid query param and a User-Agent", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			assert.strictEqual(bento.isConfigured, true)

			const result = yield* bento.trackEvent({
				email: "user@example.com",
				type: "maple.onboarding.started",
				fields: { maple_cohort: "live" },
				details: { dedupe_key: "org_123:maple.onboarding.started" },
			})

			assert.deepStrictEqual(result, { results: 1, failed: 0 })
			assert.strictEqual(calls.length, 1)

			const call = calls[0]!
			assert.strictEqual(call.url, "https://bento.test/api/v1/batch/events?site_uuid=site-uuid")
			assert.strictEqual(
				call.headers.get("authorization"),
				`Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
			)
			// Cloudflare blocks Bento requests with no User-Agent.
			assert.strictEqual(call.headers.get("user-agent"), "maple-api")

			const body = JSON.parse(call.body)
			assert.deepStrictEqual(body.events, [
				{
					type: "maple.onboarding.started",
					email: "user@example.com",
					fields: { maple_cohort: "live" },
					details: { dedupe_key: "org_123:maple.onboarding.started" },
				},
			])
		}).pipe(Effect.provide(makeLayer({ ...CREDENTIALS, MAPLE_ENVIRONMENT: "production" }, stub)))
	})

	it.effect("dry run logs the payload without sending it", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			const result = yield* bento.trackEvent({
				email: "user@example.com",
				type: "maple.onboarding.started",
			})

			assert.deepStrictEqual(result, { results: 0, failed: 0 })
			assert.strictEqual(calls.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					{ ...CREDENTIALS, MAPLE_ENVIRONMENT: "production", MAPLE_BENTO_DRY_RUN: "true" },
					stub,
				),
			),
		)
	})

	it.effect("upsertSubscribers hits the non-triggering batch endpoint", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			yield* bento.upsertSubscribers([
				{
					email: "user@example.com",
					fields: { maple_org_id: "org_123", maple_cohort: "legacy" },
					createdAt: "2026-07-01T00:00:00.000Z",
				},
			])

			assert.strictEqual(calls.length, 1)
			const call = calls[0]!
			// /batch/subscribers is documented as NOT triggering Flows — a backfill
			// over every org must never reach /batch/events.
			assert.strictEqual(call.url, "https://bento.test/api/v1/batch/subscribers?site_uuid=site-uuid")

			const body = JSON.parse(call.body)
			assert.deepStrictEqual(body.subscribers, [
				{
					email: "user@example.com",
					created_at: "2026-07-01T00:00:00.000Z",
					maple_org_id: "org_123",
					maple_cohort: "legacy",
				},
			])
		}).pipe(Effect.provide(makeLayer({ ...CREDENTIALS, MAPLE_ENVIRONMENT: "production" }, stub)))
	})

	it.effect("an empty subscriber batch makes no request", () => {
		const { calls, stub } = recordingFetch()
		return Effect.gen(function* () {
			const bento = yield* BentoService
			const result = yield* bento.upsertSubscribers([])

			assert.deepStrictEqual(result, { results: 0, failed: 0 })
			assert.strictEqual(calls.length, 0)
		}).pipe(Effect.provide(makeLayer({ ...CREDENTIALS, MAPLE_ENVIRONMENT: "production" }, stub)))
	})

	it.effect("maps a non-2xx response to BentoError with the status", () => {
		const stub = (async () =>
			new Response("{}", {
				status: 429,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch
		return Effect.gen(function* () {
			const bento = yield* BentoService
			const error = yield* bento
				.trackEvent({ email: "user@example.com", type: "maple.onboarding.started" })
				.pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/errors/BentoError")
			assert.strictEqual(error.status, 429)
		}).pipe(Effect.provide(makeLayer({ ...CREDENTIALS, MAPLE_ENVIRONMENT: "production" }, stub)))
	})
})

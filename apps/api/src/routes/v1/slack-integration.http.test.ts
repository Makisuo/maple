import { createCipheriv, randomBytes } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { layerFromEnvRecord } from "@maple/effect-cloudflare/worker-environment"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { OAuthStateRepository } from "@/services/auth/OAuthStateRepository"
import { SlackIntegrationService } from "@/services/integrations/SlackIntegrationService"
import { slackSecretAad } from "@/services/integrations/slack-bot-token"
import { SlackInternalRouter } from "./slack-integration.http"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 7)

/** AES-256-GCM encrypt matching Crypto.ts's format (12-byte iv, base64 fields, AAD). */
const encryptField = (plaintext: string, key: Buffer, aad: Buffer) => {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key, iv)
	cipher.setAAD(aad)
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	return {
		ciphertext: ciphertext.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
	}
}

/** Insert an encrypted slack_workspaces row directly (bypasses OAuth). */
const insertWorkspace = async (
	testDb: TestDb,
	opts: {
		id: string
		orgId: string
		teamId: string
		teamName: string
		botToken: string
		apiKey: string
		revoked?: boolean
	},
) => {
	// Secrets are AAD-bound to (orgId, teamId, column) — fixtures must match.
	const bot = encryptField(
		opts.botToken,
		ENCRYPTION_KEY,
		slackSecretAad(opts.orgId, opts.teamId, "bot_token"),
	)
	const key = encryptField(
		opts.apiKey,
		ENCRYPTION_KEY,
		slackSecretAad(opts.orgId, opts.teamId, "api_key_secret"),
	)
	await executeSql(
		testDb,
		`INSERT INTO slack_workspaces (
			id, org_id, team_id, team_name, bot_user_id, scope,
			bot_token_ciphertext, bot_token_iv, bot_token_tag,
			api_key_id, api_key_secret_ciphertext, api_key_secret_iv, api_key_secret_tag,
			installed_by_user_id, created_at, updated_at, revoked_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now(), ${opts.revoked ? "now()" : "NULL"})`,
		[
			opts.id,
			opts.orgId,
			opts.teamId,
			opts.teamName,
			"U0BOT",
			"chat:write",
			bot.ciphertext,
			bot.iv,
			bot.tag,
			"11111111-2222-4333-8444-555555555555",
			key.ciphertext,
			key.iv,
			key.tag,
			"user_installer",
		],
	)
}

const makeConfig = (tokens: { slack?: string; shared?: string } = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "https://web.localhost",
			...(tokens.slack !== undefined ? { SLACK_INTERNAL_SERVICE_TOKEN: tokens.slack } : undefined),
			...(tokens.shared !== undefined ? { INTERNAL_SERVICE_TOKEN: tokens.shared } : undefined),
		}),
	)

const makeRouterLayer = (
	testDb: TestDb,
	tokens: { slack?: string; shared?: string } = {},
	workerEnv?: Record<string, unknown>,
) => {
	const layer = SlackInternalRouter.pipe(
		Layer.provide(SlackIntegrationService.layer),
		Layer.provide(Layer.mergeAll(ApiKeysService.layer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(tokens)),
	)
	// The usage route reads WorkerEnvironment via serviceOption — absent means
	// "no Autumn config, skip tracking", which is what every non-usage test wants.
	return workerEnv === undefined ? layer : layer.pipe(Layer.provide(layerFromEnvRecord(workerEnv)))
}

const TEAM_PATH = "/internal/slack/workspaces"

const get = (handler: (request: Request) => Promise<Response>, teamId: string, bearer?: string) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${TEAM_PATH}/${teamId}`, {
				headers: bearer !== undefined ? { authorization: bearer } : {},
			}),
		),
	)

/** POST to the revoke sub-route for one team. */
const postRevoke = (
	handler: (request: Request) => Promise<Response>,
	teamId: string,
	body: unknown,
	bearer?: string,
) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${TEAM_PATH}/${teamId}/revoke`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(bearer !== undefined ? { authorization: bearer } : undefined),
				},
				body: JSON.stringify(body),
			}),
		),
	)

/** Run `body` against a web handler for the internal router, disposing after. */
const withHandler = (
	testDb: TestDb,
	tokens: { slack?: string; shared?: string },
	body: (handler: (request: Request) => Promise<Response>) => Effect.Effect<void>,
	workerEnv?: Record<string, unknown>,
) => {
	const { handler, dispose } = HttpRouter.toWebHandler(makeRouterLayer(testDb, tokens, workerEnv), {
		disableLogger: true,
	})
	return body((request) => handler(request)).pipe(Effect.ensuring(Effect.promise(dispose)))
}

describe("SlackInternalRouter", () => {
	it.effect("resolves a team with the dedicated token and returns the fixed contract", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_1",
					orgId: "org_a",
					teamId: "T0123",
					teamName: "Acme",
					botToken: "xoxb-secret-token",
					apiKey: "maple_ak_secret",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token", shared: "shared-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const ok = yield* get(handler, "T0123", "Bearer maple_svc_slack-secret-token")
					assert.strictEqual(ok.status, 200)
					const body = yield* Effect.promise(() => ok.json())
					// FIXED response contract — the Railway bot is built against exactly
					// these keys (SlackBotResolutionResponseSchema).
					assert.deepStrictEqual(body, {
						orgId: "org_a",
						teamId: "T0123",
						teamName: "Acme",
						botToken: "xoxb-secret-token",
						mapleApiKey: "maple_ak_secret",
					})

					// When the dedicated token is set, the shared token is NOT accepted.
					const shared = yield* get(handler, "T0123", "Bearer maple_svc_shared-secret-token")
					assert.strictEqual(shared.status, 401)
				}),
			)
			// Building testDb.layer (provided below) applies the migrations before
			// the raw-SQL insert above runs.
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("does NOT fall back to INTERNAL_SERVICE_TOKEN when the Slack-specific token is unset", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_2",
					orgId: "org_b",
					teamId: "T0999",
					teamName: "Beta",
					botToken: "xoxb-b",
					apiKey: "maple_ak_b",
				}),
			)
			yield* withHandler(
				testDb,
				{ shared: "shared-only-token" },
				Effect.fnUntraced(function* (handler) {
					// The shared token is handed to MCP-internal callers; holding it
					// must not be enough to harvest an org's bot token + Maple key.
					const shared = yield* get(handler, "T0999", "Bearer maple_svc_shared-only-token")
					assert.strictEqual(shared.status, 401)
					const text = yield* Effect.promise(() => shared.text())
					assert.include(text, "not configured")
				}),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("rejects bad or missing credentials with 401", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				// Wrong token of the SAME length (timingSafeEqual path).
				const wrong = yield* get(
					handler,
					"T0123",
					`Bearer maple_svc_${"x".repeat("slack-secret-token".length)}`,
				)
				assert.strictEqual(wrong.status, 401)

				// Length mismatch must 401 cleanly, not throw out of timingSafeEqual.
				const short = yield* get(handler, "T0123", "Bearer maple_svc_nope")
				assert.strictEqual(short.status, 401)

				// Missing the maple_svc_ prefix.
				const unprefixed = yield* get(handler, "T0123", "Bearer slack-secret-token")
				assert.strictEqual(unprefixed.status, 401)

				// Wrong scheme / missing header.
				const basic = yield* get(handler, "T0123", "Basic maple_svc_slack-secret-token")
				assert.strictEqual(basic.status, 401)
				const missing = yield* get(handler, "T0123")
				assert.strictEqual(missing.status, 401)
			}),
		)
	})

	it.effect("rejects a multi-byte bearer with 401 instead of throwing out of timingSafeEqual", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				// Same number of UTF-16 code units as the expected token (18) but 19
				// UTF-8 bytes — comparing lengths in code units would let this reach
				// timingSafeEqual, which throws on unequal buffer lengths (→ 500).
				const multiByte = "slack-secret-tokeñ"
				assert.strictEqual(multiByte.length, "slack-secret-token".length)
				assert.notStrictEqual(Buffer.byteLength(multiByte, "utf8"), multiByte.length)

				const response = yield* get(handler, "T0123", `Bearer maple_svc_${multiByte}`)
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect(
		"authenticates before validating the teamId, and answers a malformed escape identically either way",
		() => {
			const testDb = createTestDb(trackedDbs)
			return withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					// `%20` is a well-formed escape that decodes to a lone space, so it
					// reaches the handler and fails the trimmed/non-empty check — but only
					// for an authenticated caller. Anonymous gets 401, not the 400: auth
					// runs before any path-param decoding.
					const anonymousBlank = yield* get(handler, "%20")
					assert.strictEqual(anonymousBlank.status, 401)
					const authenticatedBlank = yield* get(
						handler,
						"%20",
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(authenticatedBlank.status, 400)

					// `%ZZ` is a malformed escape (`decodeURIComponent` throws `URIError`).
					// The router rejects it during path matching, so the handler — and its
					// Option.liftThrowable guard — is never reached; both callers get the
					// same 404 and neither can tell the two apart.
					const anonymousMalformed = yield* get(handler, "%ZZ")
					assert.strictEqual(anonymousMalformed.status, 404)
					const authenticatedMalformed = yield* get(
						handler,
						"%ZZ",
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(authenticatedMalformed.status, 404)
				}),
			)
		},
	)

	it.effect("rejects every request with 401 when no internal token is configured", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{},
			Effect.fnUntraced(function* (handler) {
				const response = yield* get(handler, "T0123", "Bearer maple_svc_anything")
				assert.strictEqual(response.status, 401)
				const text = yield* Effect.promise(() => response.text())
				assert.include(text, "not configured")
			}),
		)
	})

	it.effect("returns 404 for unknown or revoked teams and 400 for an invalid teamId", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_3",
					orgId: "org_c",
					teamId: "T-revoked",
					teamName: "Gone",
					botToken: "xoxb-c",
					apiKey: "maple_ak_c",
					revoked: true,
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const bearer = "Bearer maple_svc_slack-secret-token"

					const unknown = yield* get(handler, "T-unknown", bearer)
					assert.strictEqual(unknown.status, 404)

					const revoked = yield* get(handler, "T-revoked", bearer)
					assert.strictEqual(revoked.status, 404)

					// "%20" decodes to a lone space — fails the trimmed/non-empty check.
					const invalid = yield* get(handler, "%20", bearer)
					assert.strictEqual(invalid.status, 400)
				}),
			)
		}).pipe(Effect.provide(testDb.layer))
	})
})

// POST /internal/slack/workspaces/:teamId/revoke — the Railway-hosted bot
// calls this after detecting app_uninstalled/tokens_revoked in its own
// webhook handler (Slack allows only one Events API Request URL per app, and
// it's already pointed at the bot, not this API).

describe("SlackInternalRouter (revoke)", () => {
	it.effect("revokes an active workspace and echoes revoked:true", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_rv1",
					orgId: "org_rv1",
					teamId: "T-RV1",
					teamName: "RvOrg1",
					botToken: "xoxb-rv1",
					apiKey: "maple_ak_rv1",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const response = yield* postRevoke(
						handler,
						"T-RV1",
						{ reason: "app_uninstalled" },
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(response.status, 200)
					const body = yield* Effect.promise(() => response.json())
					assert.deepStrictEqual(body, { revoked: true })
				}),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-RV1'",
				),
			)
			assert.isNotNull(row?.revoked_at)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("accepts tokens_revoked as a reason too", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_rv2",
					orgId: "org_rv2",
					teamId: "T-RV2",
					teamName: "RvOrg2",
					botToken: "xoxb-rv2",
					apiKey: "maple_ak_rv2",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const response = yield* postRevoke(
						handler,
						"T-RV2",
						{ reason: "tokens_revoked" },
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(response.status, 200)
				}),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-RV2'",
				),
			)
			assert.isNotNull(row?.revoked_at)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("echoes revoked:false for an unknown or already-revoked team (idempotent)", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const response = yield* postRevoke(
					handler,
					"T-UNKNOWN",
					{ reason: "app_uninstalled" },
					"Bearer maple_svc_slack-secret-token",
				)
				assert.strictEqual(response.status, 200)
				const body = yield* Effect.promise(() => response.json())
				assert.deepStrictEqual(body, { revoked: false })
			}),
		)
	})

	it.effect("rejects an unauthenticated request with 401 before touching the body", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const response = yield* postRevoke(handler, "T-X", { reason: "app_uninstalled" })
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("rejects a missing or invalid reason with 400", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const bearer = "Bearer maple_svc_slack-secret-token"

				const missing = yield* postRevoke(handler, "T-X", {}, bearer)
				assert.strictEqual(missing.status, 400)

				const wrongReason = yield* postRevoke(handler, "T-X", { reason: "app_mention" }, bearer)
				assert.strictEqual(wrongReason.status, 400)

				const notJson = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${TEAM_PATH}/T-X/revoke`, {
							method: "POST",
							headers: { authorization: bearer, "content-type": "application/json" },
							body: "not json",
						}),
					),
				)
				assert.strictEqual(notJson.status, 400)
			}),
		)
	})
})

// POST /internal/slack/workspaces/:teamId/usage — the bot reports each turn's
// token totals here so Slack agent traffic counts into the org's Autumn AI
// usage, alongside triage runs.

describe("SlackInternalRouter (usage)", () => {
	const AUTUMN_ENV = {
		AUTUMN_SECRET_KEY: "autumn-sk",
		AUTUMN_API_URL: "https://autumn.test",
	}

	const postUsage = (
		handler: (request: Request) => Promise<Response>,
		teamId: string,
		body: unknown,
		bearer?: string,
	) =>
		Effect.promise(() =>
			handler(
				new Request(`http://api.localhost${TEAM_PATH}/${teamId}/usage`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(bearer !== undefined ? { authorization: bearer } : undefined),
					},
					body: JSON.stringify(body),
				}),
			),
		)

	/**
	 * `trackTokenUsage` posts to Autumn through the bare global `fetch`
	 * (promise-land, not Effect's HttpClient), so stubbing the global is the
	 * seam. Nothing else in these tests fetches: requests hit the handler
	 * directly and orgIdForTeam only touches PGlite.
	 */
	const stubAutumnFetch = () => {
		const realFetch = globalThis.fetch
		const calls: Array<{
			url: string
			authorization: string | undefined
			body: Record<string, unknown>
		}> = []
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input instanceof Request ? input.url : input),
				authorization: new Headers(init?.headers).get("authorization") ?? undefined,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			})
			return new Response("{}", { status: 200 })
		}) as typeof fetch
		return { calls, restore: () => void (globalThis.fetch = realFetch) }
	}

	it.effect("meters one input and one output Autumn event for the bound org", () => {
		const testDb = createTestDb(trackedDbs)
		const autumn = stubAutumnFetch()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_u1",
					orgId: "org_u1",
					teamId: "T-U1",
					teamName: "UsageOrg",
					botToken: "xoxb-u1",
					apiKey: "maple_ak_u1",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const response = yield* postUsage(
						handler,
						"T-U1",
						{ inputTokens: 120, outputTokens: 45, idempotencyKey: "sess-1:turn-1" },
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(response.status, 200)
					const body = yield* Effect.promise(() => response.json())
					assert.deepStrictEqual(body, { forwarded: true })

					assert.strictEqual(autumn.calls.length, 2)
					for (const call of autumn.calls) {
						assert.strictEqual(call.url, "https://autumn.test/v1/balances.track")
						assert.strictEqual(call.authorization, "Bearer autumn-sk")
						assert.strictEqual(call.body.customer_id, "org_u1")
					}
					const byFeature = new Map(autumn.calls.map((call) => [call.body.feature_id, call.body]))
					assert.deepStrictEqual(byFeature.get("ai_input_tokens"), {
						customer_id: "org_u1",
						feature_id: "ai_input_tokens",
						value: 120,
						idempotency_key: "sess-1:turn-1:slack:input",
					})
					assert.deepStrictEqual(byFeature.get("ai_output_tokens"), {
						customer_id: "org_u1",
						feature_id: "ai_output_tokens",
						value: 45,
						idempotency_key: "sess-1:turn-1:slack:output",
					})
				}),
				AUTUMN_ENV,
			)
		}).pipe(
			Effect.provide(testDb.layer),
			Effect.ensuring(Effect.sync(() => autumn.restore())),
		)
	})

	it.effect("returns 404 for an unknown team without touching Autumn", () => {
		const testDb = createTestDb(trackedDbs)
		const autumn = stubAutumnFetch()
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const response = yield* postUsage(
					handler,
					"T-UNKNOWN",
					{ inputTokens: 10, outputTokens: 5, idempotencyKey: "sess:turn" },
					"Bearer maple_svc_slack-secret-token",
				)
				assert.strictEqual(response.status, 404)
				assert.strictEqual(autumn.calls.length, 0)
			}),
			AUTUMN_ENV,
		).pipe(Effect.ensuring(Effect.sync(() => autumn.restore())))
	})

	it.effect("rejects an unauthenticated report with 401", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const response = yield* postUsage(handler, "T-U1", {
					inputTokens: 10,
					outputTokens: 5,
					idempotencyKey: "sess:turn",
				})
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("rejects malformed usage bodies with 400", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ slack: "slack-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const bearer = "Bearer maple_svc_slack-secret-token"

				const negative = yield* postUsage(
					handler,
					"T-X",
					{ inputTokens: -1, outputTokens: 5, idempotencyKey: "k" },
					bearer,
				)
				assert.strictEqual(negative.status, 400)

				const fractional = yield* postUsage(
					handler,
					"T-X",
					{ inputTokens: 1.5, outputTokens: 5, idempotencyKey: "k" },
					bearer,
				)
				assert.strictEqual(fractional.status, 400)

				const missingKey = yield* postUsage(
					handler,
					"T-X",
					{ inputTokens: 1, outputTokens: 5 },
					bearer,
				)
				assert.strictEqual(missingKey.status, 400)

				const emptyKey = yield* postUsage(
					handler,
					"T-X",
					{ inputTokens: 1, outputTokens: 5, idempotencyKey: "" },
					bearer,
				)
				assert.strictEqual(emptyKey.status, 400)
			}),
		)
	})

	it.effect("answers forwarded:false without a worker env (nothing to bill against)", () => {
		const testDb = createTestDb(trackedDbs)
		const autumn = stubAutumnFetch()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_u2",
					orgId: "org_u2",
					teamId: "T-U2",
					teamName: "NoEnvOrg",
					botToken: "xoxb-u2",
					apiKey: "maple_ak_u2",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const response = yield* postUsage(
						handler,
						"T-U2",
						{ inputTokens: 10, outputTokens: 5, idempotencyKey: "sess:turn" },
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(response.status, 200)
					const body = yield* Effect.promise(() => response.json())
					assert.deepStrictEqual(body, { forwarded: false })
					assert.strictEqual(autumn.calls.length, 0)
				}),
			)
		}).pipe(
			Effect.provide(testDb.layer),
			Effect.ensuring(Effect.sync(() => autumn.restore())),
		)
	})

	it.effect("accepts an all-zero report but does not post to Autumn", () => {
		const testDb = createTestDb(trackedDbs)
		const autumn = stubAutumnFetch()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_u3",
					orgId: "org_u3",
					teamId: "T-U3",
					teamName: "ZeroOrg",
					botToken: "xoxb-u3",
					apiKey: "maple_ak_u3",
				}),
			)
			yield* withHandler(
				testDb,
				{ slack: "slack-secret-token" },
				Effect.fnUntraced(function* (handler) {
					const response = yield* postUsage(
						handler,
						"T-U3",
						{ inputTokens: 0, outputTokens: 0, idempotencyKey: "sess:turn" },
						"Bearer maple_svc_slack-secret-token",
					)
					assert.strictEqual(response.status, 200)
					const body = yield* Effect.promise(() => response.json())
					assert.deepStrictEqual(body, { forwarded: false })
					assert.strictEqual(autumn.calls.length, 0)
				}),
				AUTUMN_ENV,
			)
		}).pipe(
			Effect.provide(testDb.layer),
			Effect.ensuring(Effect.sync(() => autumn.restore())),
		)
	})
})

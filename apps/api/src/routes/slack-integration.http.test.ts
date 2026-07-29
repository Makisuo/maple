import { createCipheriv, randomBytes } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "../services/ApiKeysService"
import { OAuthStateRepository } from "../services/OAuthStateRepository"
import { SlackIntegrationService } from "../services/SlackIntegrationService"
import { slackSecretAad } from "../services/slack-bot-token"
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

/** Router-layer knobs: which internal bearers are configured, and Autumn wiring for usage tracking. */
interface HarnessConfig {
	slack?: string
	shared?: string
	autumnSecret?: string
	autumnApiUrl?: string
	defaultOrgId?: string
}

const makeConfig = (tokens: HarnessConfig = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: tokens.defaultOrgId ?? "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "https://web.localhost",
			...(tokens.slack !== undefined ? { SLACK_INTERNAL_SERVICE_TOKEN: tokens.slack } : {}),
			...(tokens.shared !== undefined ? { INTERNAL_SERVICE_TOKEN: tokens.shared } : {}),
			...(tokens.autumnSecret !== undefined ? { AUTUMN_SECRET_KEY: tokens.autumnSecret } : {}),
			...(tokens.autumnApiUrl !== undefined ? { AUTUMN_API_URL: tokens.autumnApiUrl } : {}),
		}),
	)

const makeRouterLayer = (testDb: TestDb, tokens: HarnessConfig = {}) =>
	SlackInternalRouter.pipe(
		Layer.provide(SlackIntegrationService.layer),
		Layer.provide(Layer.mergeAll(ApiKeysService.layer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(tokens)),
	)

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
					...(bearer !== undefined ? { authorization: bearer } : {}),
				},
				body: JSON.stringify(body),
			}),
		),
	)

/** Run `body` against a web handler for the internal router, disposing after. */
const withHandler = (
	testDb: TestDb,
	tokens: HarnessConfig,
	body: (handler: (request: Request) => Promise<Response>) => Effect.Effect<void>,
) => {
	const { handler, dispose } = HttpRouter.toWebHandler(makeRouterLayer(testDb, tokens), {
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

// ---------------------------------------------------------------------------
// POST /internal/slack/workspaces/:teamId/revoke — the Railway-hosted bot
// calls this after detecting app_uninstalled/tokens_revoked in its own
// webhook handler (Slack allows only one Events API Request URL per app, and
// it's already pointed at the bot, not this API).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Usage reporting. The Railway-hosted bot runs its own model (Cloudflare
// Workers AI), so its AI spend reaches billing only by being reported here and
// attributed to the org bound to the Slack team.
// ---------------------------------------------------------------------------

const AUTUMN_URL = "https://autumn.test"

interface AutumnCall {
	readonly customerId: string
	readonly featureId: string
	readonly value: number
	readonly idempotencyKey: string
}

/**
 * Stubs `globalThis.fetch` for the duration of `body`. `trackTokenUsage` issues
 * a bare `fetch` (it is shared with Workers-runtime call sites and takes no
 * injected client), so the global is the only seam.
 */
const withAutumnStub = <A, E, R>(
	body: (calls: AutumnCall[]) => Effect.Effect<A, E, R>,
	respond: () => Response = () => new Response("{}", { status: 200 }),
) =>
	Effect.suspend(() => {
		const realFetch = globalThis.fetch
		const calls: AutumnCall[] = []
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input)
			if (!url.startsWith(AUTUMN_URL)) return realFetch(input as RequestInfo, init)
			const parsed = JSON.parse(String(init?.body)) as {
				customer_id: string
				feature_id: string
				value: number
				idempotency_key: string
			}
			calls.push({
				customerId: parsed.customer_id,
				featureId: parsed.feature_id,
				value: parsed.value,
				idempotencyKey: parsed.idempotency_key,
			})
			return respond()
		}) as typeof fetch
		return body(calls).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					globalThis.fetch = realFetch
				}),
			),
		)
	})

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
					...(bearer !== undefined ? { authorization: bearer } : {}),
				},
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
		),
	)

const USAGE_TOKENS: HarnessConfig = {
	slack: "slack-secret-token",
	autumnSecret: "autumn-secret",
	autumnApiUrl: AUTUMN_URL,
}

const USAGE_BEARER = "Bearer maple_svc_slack-secret-token"

describe("SlackInternalRouter (usage)", () => {
	it.effect("tracks input and output tokens against the team's org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us1",
					orgId: "org_us1",
					teamId: "T-US1",
					teamName: "UsOrg1",
					botToken: "xoxb-us1",
					apiKey: "maple_ak_us1",
				}),
			)
			yield* withAutumnStub((calls) =>
				withHandler(
					testDb,
					USAGE_TOKENS,
					Effect.fnUntraced(function* (handler) {
						const response = yield* postUsage(
							handler,
							"T-US1",
							{
								idempotencyKey: "sess_1:turn_1:0",
								inputTokens: 120,
								outputTokens: 34,
								model: "@cf/zai-org/glm-5.2",
							},
							USAGE_BEARER,
						)
						assert.strictEqual(response.status, 202)
						assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
							tracked: true,
							outcome: "tracked",
						})
						// Billed to the org the team resolves to — never to the team id.
						// The key is team-namespaced and source-tagged so a bot step and a
						// triage run can never collide.
						assert.deepStrictEqual(
							[...calls].sort((a, b) => a.featureId.localeCompare(b.featureId)),
							[
								{
									customerId: "org_us1",
									featureId: "ai_input_tokens",
									value: 120,
									idempotencyKey: "slack:T-US1:sess_1:turn_1:0:slack-agent:input",
								},
								{
									customerId: "org_us1",
									featureId: "ai_output_tokens",
									value: 34,
									idempotencyKey: "slack:T-US1:sess_1:turn_1:0:slack-agent:output",
								},
							],
						)
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("skips a zero-token side rather than tracking a zero", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us2",
					orgId: "org_us2",
					teamId: "T-US2",
					teamName: "UsOrg2",
					botToken: "xoxb-us2",
					apiKey: "maple_ak_us2",
				}),
			)
			yield* withAutumnStub((calls) =>
				withHandler(
					testDb,
					USAGE_TOKENS,
					Effect.fnUntraced(function* (handler) {
						const response = yield* postUsage(
							handler,
							"T-US2",
							{ idempotencyKey: "k", inputTokens: 7, outputTokens: 0 },
							USAGE_BEARER,
						)
						assert.strictEqual(response.status, 202)
						assert.strictEqual(calls.length, 1)
						assert.strictEqual(calls[0]?.featureId, "ai_input_tokens")
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("answers 202 but reports NOT tracked when the billing provider fails", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us3",
					orgId: "org_us3",
					teamId: "T-US3",
					teamName: "UsOrg3",
					botToken: "xoxb-us3",
					apiKey: "maple_ak_us3",
				}),
			)
			yield* withAutumnStub(
				(calls) =>
					withHandler(
						testDb,
						USAGE_TOKENS,
						Effect.fnUntraced(function* (handler) {
							const response = yield* postUsage(
								handler,
								"T-US3",
								{ idempotencyKey: "k", inputTokens: 5, outputTokens: 5 },
								USAGE_BEARER,
							)
							// Still 202 — the Slack reply already went out and a retry would
							// only re-post something Autumn may have recorded. But the body
							// must not claim success, or a week-long Autumn outage is
							// indistinguishable from a week of billed traffic.
							assert.strictEqual(response.status, 202)
							assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
								tracked: false,
								outcome: "failed",
							})
							// It really did attempt both writes — this asserts the failure
							// path, not merely that nothing threw.
							assert.strictEqual(calls.length, 2)
						}),
					),
				() => new Response("nope", { status: 500 }),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reports NOT tracked when Autumn is unconfigured — optionalSecret can drop the key", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us3b",
					orgId: "org_us3b",
					teamId: "T-US3B",
					teamName: "UsOrg3b",
					botToken: "xoxb-us3b",
					apiKey: "maple_ak_us3b",
				}),
			)
			yield* withAutumnStub((calls) =>
				// No `autumnSecret`: exactly what a PR preview looks like when the key
				// is missing from the Infisical environment `optionalSecret()` reads.
				withHandler(
					testDb,
					{ slack: "slack-secret-token", autumnApiUrl: AUTUMN_URL },
					Effect.fnUntraced(function* (handler) {
						const response = yield* postUsage(
							handler,
							"T-US3B",
							{ idempotencyKey: "k", inputTokens: 5, outputTokens: 5 },
							USAGE_BEARER,
						)
						assert.strictEqual(response.status, 202)
						assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
							tracked: false,
							outcome: "no-credentials",
						})
						assert.strictEqual(calls.length, 0)
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("does not bill the self-hosted default org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us4",
					orgId: "org_default",
					teamId: "T-US4",
					teamName: "UsOrg4",
					botToken: "xoxb-us4",
					apiKey: "maple_ak_us4",
				}),
			)
			yield* withAutumnStub((calls) =>
				withHandler(
					testDb,
					{ ...USAGE_TOKENS, defaultOrgId: "org_default" },
					Effect.fnUntraced(function* (handler) {
						const response = yield* postUsage(
							handler,
							"T-US4",
							{ idempotencyKey: "k", inputTokens: 9, outputTokens: 9 },
							USAGE_BEARER,
						)
						assert.strictEqual(response.status, 202)
						assert.strictEqual(calls.length, 0)
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("rejects an unknown or revoked team with 404", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us5",
					orgId: "org_us5",
					teamId: "T-US5",
					teamName: "UsOrg5",
					botToken: "xoxb-us5",
					apiKey: "maple_ak_us5",
					revoked: true,
				}),
			)
			yield* withAutumnStub((calls) =>
				withHandler(
					testDb,
					USAGE_TOKENS,
					Effect.fnUntraced(function* (handler) {
						const body = { idempotencyKey: "k", inputTokens: 1, outputTokens: 1 }
						assert.strictEqual((yield* postUsage(handler, "T-US5", body, USAGE_BEARER)).status, 404)
						assert.strictEqual((yield* postUsage(handler, "T-NOPE", body, USAGE_BEARER)).status, 404)
						assert.strictEqual(calls.length, 0)
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("requires the dedicated slack bearer", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ ...USAGE_TOKENS, shared: "shared-secret-token" },
			Effect.fnUntraced(function* (handler) {
				const body = { idempotencyKey: "k", inputTokens: 1, outputTokens: 1 }
				assert.strictEqual((yield* postUsage(handler, "T-US1", body)).status, 401)
				assert.strictEqual(
					(yield* postUsage(handler, "T-US1", body, "Bearer maple_svc_wrong")).status,
					401,
				)
				// The shared internal token is NOT accepted here, same as resolve/revoke.
				assert.strictEqual(
					(yield* postUsage(handler, "T-US1", body, "Bearer maple_svc_shared-secret-token")).status,
					401,
				)
			}),
		)
	})

	it.effect("answers 401 when the slack internal token is unset", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			{ autumnSecret: "autumn-secret", autumnApiUrl: AUTUMN_URL },
			Effect.fnUntraced(function* (handler) {
				const response = yield* postUsage(
					handler,
					"T-US1",
					{ idempotencyKey: "k", inputTokens: 1, outputTokens: 1 },
					USAGE_BEARER,
				)
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("rejects a malformed body with 400", () => {
		const testDb = createTestDb(trackedDbs)
		return withHandler(
			testDb,
			USAGE_TOKENS,
			Effect.fnUntraced(function* (handler) {
				const cases: unknown[] = [
					{},
					{ idempotencyKey: "", inputTokens: 1, outputTokens: 1 },
					{ idempotencyKey: "k", inputTokens: -1, outputTokens: 1 },
					{ idempotencyKey: "k", inputTokens: 1.5, outputTokens: 1 },
					{ idempotencyKey: "k", inputTokens: "1", outputTokens: 1 },
					{ idempotencyKey: "k", inputTokens: 1 },
					"not json",
				]
				for (const body of cases) {
					const response = yield* postUsage(handler, "T-US1", body, USAGE_BEARER)
					assert.strictEqual(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
				}
			}),
		)
	})

	it.effect("rejects an absurd token count — this is a financial write on a shared bearer", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_us6",
					orgId: "org_us6",
					teamId: "T-US6",
					teamName: "UsOrg6",
					botToken: "xoxb-us6",
					apiKey: "maple_ak_us6",
				}),
			)
			yield* withAutumnStub((calls) =>
				withHandler(
					testDb,
					USAGE_TOKENS,
					Effect.fnUntraced(function* (handler) {
						// The bearer is one shared service token that works against every
						// org and there is no rate limiting, so a single POST of 1e15 would
						// otherwise land on a customer's meter and blow their invoice.
						const overCap = 8 * 262_144 + 1
						const cases: unknown[] = [
							{ idempotencyKey: "k", inputTokens: overCap, outputTokens: 1 },
							{ idempotencyKey: "k", inputTokens: 1, outputTokens: overCap },
							{ idempotencyKey: "k", inputTokens: 1e15, outputTokens: 1 },
							{ idempotencyKey: "k", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
						]
						for (const body of cases) {
							const response = yield* postUsage(handler, "T-US6", body, USAGE_BEARER)
							assert.strictEqual(
								response.status,
								400,
								`expected 400 for ${JSON.stringify(body)}`,
							)
						}
						// Nothing reached the billing provider.
						assert.strictEqual(calls.length, 0)

						// A plausible large step still goes through — the cap must not
						// reject real traffic after a context-window bump.
						const atCap = yield* postUsage(
							handler,
							"T-US6",
							{ idempotencyKey: "k2", inputTokens: 8 * 262_144, outputTokens: 0 },
							USAGE_BEARER,
						)
						assert.strictEqual(atCap.status, 202)
					}),
				),
			)
		}).pipe(Effect.provide(testDb.layer))
	})
})

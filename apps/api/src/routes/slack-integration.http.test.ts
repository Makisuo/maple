import { createCipheriv, createHmac, randomBytes } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "../services/ApiKeysService"
import { OAuthStateRepository } from "../services/OAuthStateRepository"
import { SlackIntegrationService } from "../services/SlackIntegrationService"
import { slackSecretAad } from "../services/slack-bot-token"
import { SlackEventsRouter, SlackInternalRouter } from "./slack-integration.http"

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

const makeConfig = (tokens: { slack?: string; shared?: string; signingSecret?: string } = {}) =>
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
			...(tokens.slack !== undefined ? { SLACK_INTERNAL_SERVICE_TOKEN: tokens.slack } : {}),
			...(tokens.shared !== undefined ? { INTERNAL_SERVICE_TOKEN: tokens.shared } : {}),
			...(tokens.signingSecret !== undefined ? { SLACK_SIGNING_SECRET: tokens.signingSecret } : {}),
		}),
	)

const makeRouterLayer = (testDb: TestDb, tokens: { slack?: string; shared?: string } = {}) =>
	SlackInternalRouter.pipe(
		Layer.provide(SlackIntegrationService.layer),
		Layer.provide(Layer.mergeAll(ApiKeysService.layer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(tokens)),
	)

const makeEventsRouterLayer = (testDb: TestDb, signingSecret?: string) =>
	SlackEventsRouter.pipe(
		Layer.provide(SlackIntegrationService.layer),
		Layer.provide(Layer.mergeAll(ApiKeysService.layer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig({ signingSecret })),
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

/** Run `body` against a web handler for the internal router, disposing after. */
const withHandler = (
	testDb: TestDb,
	tokens: { slack?: string; shared?: string },
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
// SlackEventsRouter
// ---------------------------------------------------------------------------

const EVENTS_PATH = "/api/integrations/slack/events"
const SIGNING_SECRET = "test-signing-secret"

const slackSignatureHeaders = (rawBody: string, secret: string, timestampSeconds: number) => ({
	"x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestampSeconds}:${rawBody}`, "utf8").digest("hex")}`,
	"x-slack-request-timestamp": String(timestampSeconds),
})

/** POST a raw body to the events endpoint, signing it unless `omitSignature`. */
const postEvent = (
	handler: (request: Request) => Promise<Response>,
	rawBody: string,
	opts: { signWith?: string; timestampSeconds?: number; omitSignature?: boolean } = {},
) =>
	Effect.promise(() => {
		const timestampSeconds = opts.timestampSeconds ?? Math.floor(Date.now() / 1000)
		const headers: Record<string, string> = { "content-type": "application/json" }
		if (!opts.omitSignature) {
			Object.assign(headers, slackSignatureHeaders(rawBody, opts.signWith ?? SIGNING_SECRET, timestampSeconds))
		}
		return handler(
			new Request(`http://api.localhost${EVENTS_PATH}`, { method: "POST", headers, body: rawBody }),
		)
	})

/** Run `body` against a web handler for the events router, disposing after. */
const withEventsHandler = (
	testDb: TestDb,
	signingSecret: string | undefined,
	body: (handler: (request: Request) => Promise<Response>) => Effect.Effect<void>,
) => {
	const { handler, dispose } = HttpRouter.toWebHandler(makeEventsRouterLayer(testDb, signingSecret), {
		disableLogger: true,
	})
	return body((request) => handler(request)).pipe(Effect.ensuring(Effect.promise(dispose)))
}

const eventCallbackBody = (eventType: string, teamId: string) =>
	JSON.stringify({
		token: "verification-token",
		team_id: teamId,
		api_app_id: "A123",
		event: { type: eventType },
		type: "event_callback",
		event_id: "Ev0123",
		event_time: 1700000000,
	})

describe("SlackEventsRouter", () => {
	it.effect("answers the url_verification handshake with the raw challenge", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const body = JSON.stringify({
					type: "url_verification",
					token: "verification-token",
					challenge: "abc123challenge",
				})
				const response = yield* postEvent(handler, body)
				assert.strictEqual(response.status, 200)
				const text = yield* Effect.promise(() => response.text())
				assert.strictEqual(text, "abc123challenge")
			}),
		)
	})

	it.effect("rejects a request signed with the wrong secret", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-X"), {
					signWith: "wrong-secret",
				})
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("rejects a request with no signature headers", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-X"), {
					omitSignature: true,
				})
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("rejects a replayed (stale) timestamp even with a correct signature", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const staleTimestamp = Math.floor(Date.now() / 1000) - 3600
				const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-X"), {
					timestampSeconds: staleTimestamp,
				})
				assert.strictEqual(response.status, 401)
			}),
		)
	})

	it.effect("answers 503 and never reaches signature checking when SLACK_SIGNING_SECRET is unset", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			undefined,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-X"))
				assert.strictEqual(response.status, 503)
			}),
		)
	})

	it.effect("returns 400 for an empty body", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, "", { omitSignature: true })
				assert.strictEqual(response.status, 400)
			}),
		)
	})

	it.effect("returns 400 for a correctly-signed but undecodable payload", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, "not json")
				assert.strictEqual(response.status, 400)
			}),
		)
	})

	it.effect("revokes the workspace on app_uninstalled and acks 200", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_evt_au",
					orgId: "org_evt_au",
					teamId: "T-AU",
					teamName: "AuOrg",
					botToken: "xoxb-au",
					apiKey: "maple_ak_au",
				}),
			)
			yield* withEventsHandler(
				testDb,
				SIGNING_SECRET,
				Effect.fnUntraced(function* (handler) {
					const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-AU"))
					assert.strictEqual(response.status, 200)
					const text = yield* Effect.promise(() => response.text())
					assert.strictEqual(text, "ok")
				}),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-AU'",
				),
			)
			assert.isNotNull(row?.revoked_at)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("revokes the workspace on tokens_revoked and acks 200", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_evt_tr",
					orgId: "org_evt_tr",
					teamId: "T-TR",
					teamName: "TrOrg",
					botToken: "xoxb-tr",
					apiKey: "maple_ak_tr",
				}),
			)
			yield* withEventsHandler(
				testDb,
				SIGNING_SECRET,
				Effect.fnUntraced(function* (handler) {
					const response = yield* postEvent(handler, eventCallbackBody("tokens_revoked", "T-TR"))
					assert.strictEqual(response.status, 200)
				}),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-TR'",
				),
			)
			assert.isNotNull(row?.revoked_at)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("acks 200 without revoking for an unrelated event type", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_evt_other",
					orgId: "org_evt_other",
					teamId: "T-OTHER",
					teamName: "OtherOrg",
					botToken: "xoxb-other",
					apiKey: "maple_ak_other",
				}),
			)
			yield* withEventsHandler(
				testDb,
				SIGNING_SECRET,
				Effect.fnUntraced(function* (handler) {
					const response = yield* postEvent(handler, eventCallbackBody("app_mention", "T-OTHER"))
					assert.strictEqual(response.status, 200)
				}),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-OTHER'",
				),
			)
			assert.isNull(row?.revoked_at)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("acks 200 for an app_uninstalled event with no matching workspace (idempotent)", () => {
		const testDb = createTestDb(trackedDbs)
		return withEventsHandler(
			testDb,
			SIGNING_SECRET,
			Effect.fnUntraced(function* (handler) {
				const response = yield* postEvent(handler, eventCallbackBody("app_uninstalled", "T-UNKNOWN"))
				assert.strictEqual(response.status, 200)
			}),
		)
	})
})

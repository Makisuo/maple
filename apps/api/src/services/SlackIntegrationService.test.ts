import { createCipheriv, randomBytes } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { SLACK_BOT_SCOPES, SlackIntegrationService } from "./SlackIntegrationService"
import {
	resolveSlackBotTokenForDispatch,
	slackSecretAad,
	SlackBotTokenResolver,
	type SlackSecretColumn,
} from "./slack-bot-token"
import { ApiKeysService } from "./ApiKeysService"
import { OAuthStateRepository } from "./OAuthStateRepository"
import { Database } from "../lib/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"

const ENCRYPTION_KEY = Buffer.alloc(32, 7)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY.toString("base64")

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

const makeConfig = (slackConfigured = true) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "https://web.localhost",
			...(slackConfigured ? { SLACK_CLIENT_ID: "123.abc", SLACK_CLIENT_SECRET: "shhh" } : {}),
		}),
	)

const makeLayer = (
	testDb: TestDb,
	slackConfigured = true,
	apiKeysLayer: typeof ApiKeysService.layer = ApiKeysService.layer,
) =>
	SlackIntegrationService.layer.pipe(
		Layer.provide(Layer.mergeAll(apiKeysLayer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(slackConfigured)),
	)

/** Mirror of the service's (unexported) `SLACK_STATE_TTL_MS` — 10 minutes. */
const SLACK_STATE_TTL_MS = 10 * 60_000

/**
 * Wrap the real ApiKeysService so `create` runs `inject` first. `apiKeys.create`
 * is the only seam between completeInstall's cross-org pre-check and its
 * transaction, so this lets a test interleave a "concurrent" write there and
 * exercise the transactional (setWhere) race path.
 */
const apiKeysWithInjectedCreate = (inject: () => Promise<void>) =>
	Layer.effect(
		ApiKeysService,
		Effect.gen(function* () {
			const real = yield* ApiKeysService
			const create: typeof real.create = (...args) =>
				Effect.promise(inject).pipe(Effect.flatMap(() => real.create(...args)))
			return { ...real, create } as typeof real
		}),
	).pipe(Layer.provide(ApiKeysService.layer)) as typeof ApiKeysService.layer

/** The pure dispatch helper needs only Database — build a minimal layer for it. */
const databaseLayer = (testDb: TestDb) => testDb.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A mocked `fetch` that answers Slack's `oauth.v2.access` with the current team. */
const slackOAuthFetch = (teamRef: { current: { id: string; name: string } }): typeof globalThis.fetch =>
	((input: RequestInfo | URL) => {
		const url = String(input)
		if (url.startsWith("https://slack.com/api/oauth.v2.access")) {
			return Promise.resolve(
				jsonResponse({
					ok: true,
					access_token: `xoxb-${teamRef.current.id}`,
					token_type: "bot",
					scope: "chat:write",
					bot_user_id: "U0BOT",
					team: teamRef.current,
				}),
			)
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`))
	}) as typeof globalThis.fetch

const OAUTH_URL = "https://slack.com/api/oauth.v2.access"
const CONVERSATIONS_URL = "https://slack.com/api/conversations.list"
const REVOKE_URL = "https://slack.com/api/auth.revoke"
const AUTH_TEST_URL = "https://slack.com/api/auth.test"

/** A fetch that must never be called — any request fails the test loudly. */
const neverFetch: typeof globalThis.fetch = ((input: RequestInfo | URL) =>
	Promise.reject(new Error(`unexpected fetch: ${String(input)}`))) as typeof globalThis.fetch

/**
 * `oauth.v2.access` + `auth.revoke` in one stub: the install flow and the
 * uninstall's best-effort upstream revoke both go through the same fetch.
 * Records every revoke call so the bearer token can be asserted.
 */
const slackInstallAndRevokeFetch = (
	teamRef: { current: { id: string; name: string } },
	revokeCalls: Array<string | null>,
	revokeResponse: () => Response | Promise<Response> = () => jsonResponse({ ok: true }),
): typeof globalThis.fetch =>
	((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.startsWith(OAUTH_URL)) {
			return Promise.resolve(
				jsonResponse({
					ok: true,
					access_token: `xoxb-${teamRef.current.id}`,
					token_type: "bot",
					scope: "chat:write",
					bot_user_id: "U0BOT",
					team: teamRef.current,
				}),
			)
		}
		if (url.startsWith(REVOKE_URL)) {
			revokeCalls.push(new Headers(init?.headers).get("authorization"))
			return Promise.resolve(revokeResponse())
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`))
	}) as typeof globalThis.fetch

/** A fetch stub scoped to one Slack endpoint; anything else rejects. */
const slackApiFetch = (
	prefix: string,
	respond: (url: string, call: number) => Response | Promise<Response>,
): typeof globalThis.fetch => {
	let call = 0
	return ((input: RequestInfo | URL) => {
		const url = String(input)
		if (!url.startsWith(prefix)) return Promise.reject(new Error(`unexpected fetch: ${url}`))
		return Promise.resolve(respond(url, call++))
	}) as typeof globalThis.fetch
}

/**
 * `auth.test` stub keyed by bearer token (the request carries no other
 * identifying field), so a multi-workspace reconciliation test can route each
 * probed row to its own canned response regardless of iteration order.
 */
const slackAuthTestFetch = (responsesByToken: Record<string, unknown>): typeof globalThis.fetch =>
	((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		if (!url.startsWith(AUTH_TEST_URL)) return Promise.reject(new Error(`unexpected fetch: ${url}`))
		const bearer = new Headers(init?.headers).get("authorization") ?? ""
		const token = bearer.replace(/^Bearer\s+/, "")
		const body = responsesByToken[token]
		if (body === undefined) return Promise.reject(new Error(`unexpected auth.test token: ${token}`))
		return Promise.resolve(jsonResponse(body))
	}) as typeof globalThis.fetch

const withFetch = (
	testDb: TestDb,
	fetchImpl: typeof globalThis.fetch,
	apiKeysLayer?: typeof ApiKeysService.layer,
) => Layer.mergeAll(makeLayer(testDb, true, apiKeysLayer), Layer.succeed(FetchHttpClient.Fetch, fetchImpl))

const stateFromInstallUrl = (url: string): string => {
	const state = new URL(url).searchParams.get("state")
	if (!state) throw new Error("install url missing state")
	return state
}

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const aadFor = (opts: { orgId: string; teamId: string }, column: SlackSecretColumn) =>
	slackSecretAad(opts.orgId, opts.teamId, column)

/** Insert an active, encrypted slack_workspaces row directly (bypasses OAuth). */
const insertWorkspace = async (
	testDb: TestDb,
	opts: { id: string; orgId: string; teamId: string; teamName: string; botToken: string; apiKey: string },
) => {
	// Secrets are AAD-bound to (orgId, teamId, column) — fixtures must match.
	const bot = encryptField(opts.botToken, ENCRYPTION_KEY, aadFor(opts, "bot_token"))
	const key = encryptField(opts.apiKey, ENCRYPTION_KEY, aadFor(opts, "api_key_secret"))
	await executeSql(
		testDb,
		`INSERT INTO slack_workspaces (
			id, org_id, team_id, team_name, bot_user_id, scope,
			bot_token_ciphertext, bot_token_iv, bot_token_tag,
			api_key_id, api_key_secret_ciphertext, api_key_secret_iv, api_key_secret_tag,
			installed_by_user_id, created_at, updated_at, revoked_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now(), NULL)`,
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

describe("SlackIntegrationService", () => {
	it.effect("startInstall persists a single-use state and returns a Slack authorize URL", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const result = yield* slack.startInstall(
				asOrgId("org_a"),
				asUserId("user_a"),
				"https://api.localhost/oauth/slack/callback",
			)
			assert.isTrue(result.url.startsWith("https://slack.com/oauth/v2/authorize?"))
			const parsed = new URL(result.url)
			assert.strictEqual(parsed.searchParams.get("client_id"), "123.abc")
			assert.include(parsed.searchParams.get("scope") ?? "", "chat:write")
			const state = parsed.searchParams.get("state")
			assert.isString(state)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ org_id: string; provider: string }>(
					testDb,
					"SELECT org_id, provider FROM oauth_auth_states WHERE state = $1",
					[state],
				),
			)
			assert.strictEqual(row?.org_id, "org_a")
			assert.strictEqual(row?.provider, "slack")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("startInstall fails when Slack is not configured", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(
				slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb"),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(Effect.provide(makeLayer(testDb, false)))
	})

	it.effect("completeInstall rejects an unknown state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.completeInstall("code_1", "nonexistent-state"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "not recognized")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("completeInstall rejects a state past SLACK_STATE_TTL_MS (and burns it)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			// Create the state through the real flow at the frozen TestClock time,
			// then advance the clock just past the TTL — the service reads
			// Clock.currentTimeMillis, so this verifies the actual expiry window.
			const start = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			const state = stateFromInstallUrl(start.url)
			yield* TestClock.adjust(SLACK_STATE_TTL_MS + 1)
			const error = yield* Effect.flip(slack.completeInstall("code_1", state))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "expired")
			const remaining = yield* Effect.promise(() =>
				queryFirstRow(testDb, "SELECT state FROM oauth_auth_states WHERE state = $1", [state]),
			)
			assert.isUndefined(remaining)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("getStatus reports not-installed for an org with no workspace", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const status = yield* slack.getStatus(asOrgId("org_none"))
			assert.strictEqual(status.installed, false)
			assert.isNull(status.teamId)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("getStatus + resolveForBot read back an installed workspace", () => {
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
			const slack = yield* SlackIntegrationService

			const status = yield* slack.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.installed, true)
			assert.strictEqual(status.teamId, "T0123")
			assert.strictEqual(status.teamName, "Acme")

			const resolution = yield* slack.resolveForBot("T0123")
			assert.strictEqual(resolution.orgId, "org_a")
			assert.strictEqual(resolution.botToken, "xoxb-secret-token")
			assert.strictEqual(resolution.mapleApiKey, "maple_ak_secret")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("resolveForBot fails for an unknown team", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.resolveForBot("T-unknown"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect(
		"uninstall revokes the workspace so it reads as not-installed, and kills the token at Slack",
		() => {
			const testDb = createTestDb(trackedDbs)
			const revokeCalls: Array<string | null> = []
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
				const slack = yield* SlackIntegrationService
				const result = yield* slack.uninstall(asOrgId("org_b"))
				assert.strictEqual(result.uninstalled, true)

				// Forgetting the token locally would leave a live `xoxb-` token on the
				// workspace — auth.revoke is called with the decrypted bot token.
				assert.deepStrictEqual(revokeCalls, ["Bearer xoxb-b"])

				const status = yield* slack.getStatus(asOrgId("org_b"))
				assert.strictEqual(status.installed, false)
				// resolveForBot skips revoked rows too
				const error = yield* Effect.flip(slack.resolveForBot("T0999"))
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")

				// Slack confirmed the revoke, so both secrets are dropped — a revoked row
				// must not keep decryptable credentials.
				const secrets = yield* Effect.promise(() =>
					queryFirstRow<{
						bot_token_ciphertext: string | null
						bot_token_iv: string | null
						bot_token_tag: string | null
						api_key_secret_ciphertext: string | null
					}>(
						testDb,
						"SELECT bot_token_ciphertext, bot_token_iv, bot_token_tag, api_key_secret_ciphertext FROM slack_workspaces WHERE team_id = 'T0999'",
					),
				)
				assert.isNull(secrets?.bot_token_ciphertext)
				assert.isNull(secrets?.bot_token_iv)
				assert.isNull(secrets?.bot_token_tag)
				assert.isNull(secrets?.api_key_secret_ciphertext)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackInstallAndRevokeFetch({ current: { id: "T0999", name: "Beta" } }, revokeCalls),
					),
				),
			)
		},
	)

	it.effect(
		"uninstall reports uninstalled:false (and touches no upstream) when nothing is installed",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const slack = yield* SlackIntegrationService
				// No active row → the whole revoke/auth.revoke path is skipped, so
				// `neverFetch` proves nothing was attempted upstream.
				const result = yield* slack.uninstall(asOrgId("org_nothing"))
				assert.strictEqual(result.uninstalled, false)
			}).pipe(Effect.provide(withFetch(testDb, neverFetch)))
		},
	)

	it.effect("uninstall still succeeds when Slack's auth.revoke fails", () => {
		const testDb = createTestDb(trackedDbs)
		const revokeCalls: Array<string | null> = []
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_rv",
					orgId: "org_rv",
					teamId: "T-RV",
					teamName: "Revoked",
					botToken: "xoxb-rv",
					apiKey: "maple_ak_rv",
				}),
			)
			const slack = yield* SlackIntegrationService
			// Slack answers HTTP 200 with `{ ok: false }` on logical failures — an
			// already-dead token is the common case, and it must not strand the
			// workspace as installed.
			const result = yield* slack.uninstall(asOrgId("org_rv"))
			assert.strictEqual(result.uninstalled, true)
			assert.deepStrictEqual(revokeCalls, ["Bearer xoxb-rv"])

			const status = yield* slack.getStatus(asOrgId("org_rv"))
			assert.strictEqual(status.installed, false)
			// A dashboard uninstall is user-initiated — it must NOT read as a
			// remote ("Slack's side") disconnect.
			assert.isNull(status.disconnectedReason)

			// Slack did NOT confirm the revoke, so the bot token is kept — it is the
			// only way to retry killing a token that may still be live upstream. The
			// Maple key secret goes regardless (revocation only needs `apiKeyId`).
			const secrets = yield* Effect.promise(() =>
				queryFirstRow<{
					bot_token_ciphertext: string | null
					api_key_secret_ciphertext: string | null
				}>(
					testDb,
					"SELECT bot_token_ciphertext, api_key_secret_ciphertext FROM slack_workspaces WHERE team_id = 'T-RV'",
				),
			)
			assert.isString(secrets?.bot_token_ciphertext)
			assert.isNull(secrets?.api_key_secret_ciphertext)
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackInstallAndRevokeFetch(
						{ current: { id: "T-RV", name: "Revoked" } },
						revokeCalls,
						() => jsonResponse({ ok: false, error: "invalid_auth" }),
					),
				),
			),
		)
	})

	it.effect("uninstall revokes the API key minted for the bot", () => {
		const testDb = createTestDb(trackedDbs)
		const teamRef = { current: { id: "T-KEY", name: "KeyOrg" } }
		const revokeCalls: Array<string | null> = []
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const start = yield* slack.startInstall(asOrgId("org_key"), asUserId("user_key"), "https://cb")
			yield* slack.completeInstall("code_k", stateFromInstallUrl(start.url))

			const workspace = yield* Effect.promise(() =>
				queryFirstRow<{ api_key_id: string }>(
					testDb,
					"SELECT api_key_id FROM slack_workspaces WHERE team_id = 'T-KEY'",
				),
			)
			assert.isString(workspace?.api_key_id)
			const beforeUninstall = yield* Effect.promise(() =>
				queryFirstRow<{ revoked: boolean }>(testDb, "SELECT revoked FROM api_keys WHERE id = $1", [
					workspace!.api_key_id,
				]),
			)
			assert.strictEqual(beforeUninstall?.revoked, false)

			const result = yield* slack.uninstall(asOrgId("org_key"))
			assert.strictEqual(result.uninstalled, true)

			// The bot's full-access key must not outlive the installation.
			const afterUninstall = yield* Effect.promise(() =>
				queryFirstRow<{ revoked: boolean }>(testDb, "SELECT revoked FROM api_keys WHERE id = $1", [
					workspace!.api_key_id,
				]),
			)
			assert.strictEqual(afterUninstall?.revoked, true)
			assert.deepStrictEqual(revokeCalls, ["Bearer xoxb-T-KEY"])
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb),
					testDb.layer,
					Layer.succeed(FetchHttpClient.Fetch, slackInstallAndRevokeFetch(teamRef, revokeCalls)),
				),
			),
		)
	})

	it.effect("resolveSlackBotTokenForDispatch decrypts the active workspace bot token", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_3",
					orgId: "org_c",
					teamId: "T0777",
					teamName: "Gamma",
					botToken: "xoxb-dispatch-token",
					apiKey: "maple_ak_c",
				}),
			)
			const database = yield* Database
			const token = yield* resolveSlackBotTokenForDispatch(database, ENCRYPTION_KEY, "org_c")
			assert.strictEqual(token, "xoxb-dispatch-token")
		}).pipe(Effect.provide(databaseLayer(testDb)))
	})

	it.effect("SlackBotTokenResolver resolves the same token through the service", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_res",
					orgId: "org_res",
					teamId: "T-RES",
					teamName: "Res",
					botToken: "xoxb-resolver",
					apiKey: "maple_ak_res",
				}),
			)
			const resolver = yield* SlackBotTokenResolver
			assert.strictEqual(yield* resolver.resolve("org_res"), "xoxb-resolver")
		}).pipe(
			Effect.provide(
				SlackBotTokenResolver.layer.pipe(
					Layer.provide(testDb.layer),
					Layer.provide(Env.layer),
					Layer.provide(makeConfig()),
				),
			),
		)
	})

	it.effect("a bot-token ciphertext relocated onto another org's row does not decrypt", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_src",
					orgId: "org_src",
					teamId: "T-SRC",
					teamName: "Src",
					botToken: "xoxb-source",
					apiKey: "maple_ak_src",
				}),
			)
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_dst",
					orgId: "org_dst",
					teamId: "T-DST",
					teamName: "Dst",
					botToken: "xoxb-dest",
					apiKey: "maple_ak_dst",
				}),
			)
			// An attacker with DB write access copies org_src's bot-token triple onto
			// org_dst's row. The AAD binds it to (org_id, team_id, column), so the GCM
			// tag check fails instead of handing org_dst a token it never installed.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE slack_workspaces dst SET
						bot_token_ciphertext = src.bot_token_ciphertext,
						bot_token_iv = src.bot_token_iv,
						bot_token_tag = src.bot_token_tag
					FROM slack_workspaces src
					WHERE dst.id = 'sw_dst' AND src.id = 'sw_src'`,
				),
			)
			const database = yield* Database
			const error = yield* Effect.flip(
				resolveSlackBotTokenForDispatch(database, ENCRYPTION_KEY, "org_dst"),
			)
			assert.include(error.message, "decrypt")
		}).pipe(Effect.provide(databaseLayer(testDb)))
	})

	it.effect("the bot token and the Maple API key ciphertexts are not interchangeable", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_swap",
					orgId: "org_swap",
					teamId: "T-SWAP",
					teamName: "Swap",
					botToken: "xoxb-swap",
					apiKey: "maple_ak_swap",
				}),
			)
			// Same row, columns swapped — the AAD names the column, so neither side
			// decrypts.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE slack_workspaces SET
						bot_token_ciphertext = api_key_secret_ciphertext,
						bot_token_iv = api_key_secret_iv,
						bot_token_tag = api_key_secret_tag
					WHERE id = 'sw_swap'`,
				),
			)
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.resolveForBot("T-SWAP"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsPersistenceError")
			assert.include(error.message, "decrypt")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("resolveSlackBotTokenForDispatch fails when no active install exists", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const database = yield* Database
			const error = yield* Effect.flip(
				resolveSlackBotTokenForDispatch(database, ENCRYPTION_KEY, "org_missing"),
			)
			assert.strictEqual(error.destinationType, "slack-bot")
			assert.include(error.message, "not connected")
		}).pipe(Effect.provide(databaseLayer(testDb)))
	})

	it.effect("a same-org install of a second workspace replaces (revokes) the first", () => {
		const testDb = createTestDb(trackedDbs)
		const teamRef = { current: { id: "T1", name: "TeamOne" } }
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService

			// First install → workspace T1 becomes active.
			const start1 = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			yield* slack.completeInstall("code_1", stateFromInstallUrl(start1.url))
			const firstKey = yield* Effect.promise(() =>
				queryFirstRow<{ api_key_id: string }>(
					testDb,
					"SELECT api_key_id FROM slack_workspaces WHERE team_id = 'T1'",
				),
			)
			assert.isString(firstKey?.api_key_id)

			// Second install of a DIFFERENT team on the SAME org → replaces T1.
			teamRef.current = { id: "T2", name: "TeamTwo" }
			const start2 = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			yield* slack.completeInstall("code_2", stateFromInstallUrl(start2.url))

			// Status + dispatch resolve the NEW workspace, and exactly one row is active.
			const status = yield* slack.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.teamId, "T2")

			const activeCount = yield* Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"SELECT count(*)::int AS n FROM slack_workspaces WHERE org_id = 'org_a' AND revoked_at IS NULL",
				),
			)
			assert.strictEqual(activeCount?.n, 1)

			const t1Row = yield* Effect.promise(() =>
				queryFirstRow<{ revoked_at: string | null }>(
					testDb,
					"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T1'",
				),
			)
			assert.isNotNull(t1Row?.revoked_at)

			const database = yield* Database
			const token = yield* resolveSlackBotTokenForDispatch(database, ENCRYPTION_KEY, "org_a")
			assert.strictEqual(token, "xoxb-T2")

			const t1Resolve = yield* Effect.flip(slack.resolveForBot("T1"))
			assert.strictEqual(t1Resolve._tag, "@maple/http/errors/IntegrationsNotConnectedError")

			// The first workspace's minted API key was revoked.
			const keyRow = yield* Effect.promise(() =>
				queryFirstRow<{ revoked: boolean }>(testDb, "SELECT revoked FROM api_keys WHERE id = $1", [
					firstKey!.api_key_id,
				]),
			)
			assert.strictEqual(keyRow?.revoked, true)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb),
					testDb.layer,
					Layer.succeed(FetchHttpClient.Fetch, slackOAuthFetch(teamRef)),
				),
			),
		)
	})

	it.effect("the partial unique index rejects a second active row for the same org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_a1",
					orgId: "org_z",
					teamId: "TX",
					teamName: "X",
					botToken: "b1",
					apiKey: "k1",
				}),
			)
			let rejected = false
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_a2",
					orgId: "org_z",
					teamId: "TY",
					teamName: "Y",
					botToken: "b2",
					apiKey: "k2",
				}).then(
					() => {},
					() => {
						rejected = true
					},
				),
			)
			assert.isTrue(rejected, "second active row for the same org should violate the unique index")
		}).pipe(Effect.provide(databaseLayer(testDb)))
	})

	// --- In-place re-auth (permissions refresh) -------------------------------

	it.effect(
		"completeInstall over an active same-org install keeps the API key and refreshes the scope (zero-downtime re-auth)",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const slack = yield* SlackIntegrationService

				const start1 = yield* slack.startInstall(asOrgId("org_re"), asUserId("user_re"), "https://cb")
				const first = yield* slack.completeInstall("code_1", stateFromInstallUrl(start1.url))
				assert.strictEqual(first.updated, false)
				const before = yield* slack.resolveForBot("T-RE")
				const firstRow = yield* Effect.promise(() =>
					queryFirstRow<{ id: string; api_key_id: string; scope: string }>(
						testDb,
						"SELECT id, api_key_id, scope FROM slack_workspaces WHERE team_id = 'T-RE'",
					),
				)
				assert.strictEqual(firstRow?.scope, "chat:write")

				// Re-auth WITHOUT uninstalling — the scope-upgrade flow.
				const start2 = yield* slack.startInstall(asOrgId("org_re"), asUserId("user_re"), "https://cb")
				const second = yield* slack.completeInstall("code_2", stateFromInstallUrl(start2.url))
				assert.strictEqual(second.updated, true)

				const secondRow = yield* Effect.promise(() =>
					queryFirstRow<{ id: string; api_key_id: string; scope: string; revoked_at: string | null }>(
						testDb,
						"SELECT id, api_key_id, scope, revoked_at FROM slack_workspaces WHERE team_id = 'T-RE'",
					),
				)
				// Same row, same API key — the Slack agent's cached credentials stay
				// valid through the re-auth (no downtime); only the grant is refreshed.
				assert.strictEqual(secondRow?.id, firstRow?.id)
				assert.strictEqual(secondRow?.api_key_id, firstRow?.api_key_id)
				assert.strictEqual(secondRow?.scope, "chat:write,reactions:write")
				assert.isNull(secondRow?.revoked_at)

				const keyRow = yield* Effect.promise(() =>
					queryFirstRow<{ revoked: boolean }>(testDb, "SELECT revoked FROM api_keys WHERE id = $1", [
						firstRow!.api_key_id,
					]),
				)
				assert.strictEqual(keyRow?.revoked, false)
				// And the resolvable plaintext key is byte-for-byte the one from before.
				const after = yield* slack.resolveForBot("T-RE")
				assert.strictEqual(after.mapleApiKey, before.mapleApiKey)
				assert.strictEqual(after.botToken, "xoxb-T-RE")

				const status = yield* slack.getStatus(asOrgId("org_re"))
				assert.strictEqual(status.installed, true)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackApiFetch(OAUTH_URL, (_url, call) =>
							jsonResponse({
								ok: true,
								access_token: "xoxb-T-RE",
								token_type: "bot",
								// The re-approval is what grants the newly required scope.
								scope: call === 0 ? "chat:write" : "chat:write,reactions:write",
								bot_user_id: "U0BOT",
								team: { id: "T-RE", name: "ReAuth" },
							}),
						),
					),
				),
			)
		},
	)

	it.effect("completeInstall after an uninstall mints a fresh API key (no reuse of a revoked key)", () => {
		const testDb = createTestDb(trackedDbs)
		const teamRef = { current: { id: "T-ROT", name: "Rotate" } }
		const revokeCalls: Array<string | null> = []
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService

			const start1 = yield* slack.startInstall(asOrgId("org_rot"), asUserId("user_rot"), "https://cb")
			yield* slack.completeInstall("code_1", stateFromInstallUrl(start1.url))
			const firstRow = yield* Effect.promise(() =>
				queryFirstRow<{ api_key_id: string }>(
					testDb,
					"SELECT api_key_id FROM slack_workspaces WHERE team_id = 'T-ROT'",
				),
			)
			yield* slack.uninstall(asOrgId("org_rot"))

			const start2 = yield* slack.startInstall(asOrgId("org_rot"), asUserId("user_rot"), "https://cb")
			const second = yield* slack.completeInstall("code_2", stateFromInstallUrl(start2.url))
			// A reinstall over a revoked row is a fresh connect, not an update.
			assert.strictEqual(second.updated, false)

			const secondRow = yield* Effect.promise(() =>
				queryFirstRow<{ api_key_id: string; revoked_at: string | null }>(
					testDb,
					"SELECT api_key_id, revoked_at FROM slack_workspaces WHERE team_id = 'T-ROT'",
				),
			)
			assert.isNull(secondRow?.revoked_at)
			assert.notStrictEqual(secondRow?.api_key_id, firstRow?.api_key_id)
		}).pipe(Effect.provide(withFetch(testDb, slackInstallAndRevokeFetch(teamRef, revokeCalls))))
	})

	// --- Scope drift (getStatus.missingScopes) ---------------------------------

	it.effect("getStatus reports required scopes the stored grant is missing", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// The fixture stores scope = 'chat:write' only.
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_drift",
					orgId: "org_drift",
					teamId: "T-DRIFT",
					teamName: "Drift",
					botToken: "xoxb-drift",
					apiKey: "maple_ak_drift",
				}),
			)
			const slack = yield* SlackIntegrationService
			const status = yield* slack.getStatus(asOrgId("org_drift"))
			assert.include(status.missingScopes, "reactions:write")
			assert.include(status.missingScopes, "app_mentions:read")
			assert.notInclude(status.missingScopes, "chat:write")

			// A grant covering everything (order/spacing-insensitive) reports no drift.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE slack_workspaces SET scope = $1 WHERE id = 'sw_drift'", [
					` ${SLACK_BOT_SCOPES.split(",").reverse().join(" , ")} ,extra:scope`,
				]),
			)
			const full = yield* slack.getStatus(asOrgId("org_drift"))
			assert.deepStrictEqual([...full.missingScopes], [])

			// A pre-column row (NULL scope) must not nag — there is no record of the grant.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE slack_workspaces SET scope = NULL WHERE id = 'sw_drift'"),
			)
			const unknown = yield* slack.getStatus(asOrgId("org_drift"))
			assert.deepStrictEqual([...unknown.missingScopes], [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	// --- Cross-org rebind rejection -----------------------------------------

	it.effect("completeInstall rejects binding a team actively installed on another org (pre-check)", () => {
		const testDb = createTestDb(trackedDbs)
		const teamRef = { current: { id: "T-shared", name: "Shared" } }
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService

			// org_a installs T-shared.
			const s1 = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			yield* slack.completeInstall("code_1", stateFromInstallUrl(s1.url))

			// org_b tries to install the SAME team → forbidden.
			const s2 = yield* slack.startInstall(asOrgId("org_b"), asUserId("user_b"), "https://cb")
			const error = yield* Effect.flip(slack.completeInstall("code_2", stateFromInstallUrl(s2.url)))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsForbiddenError")
			assert.include(error.message, "different Maple organization")

			// org_a's binding is untouched...
			const bound = yield* Effect.promise(() =>
				queryFirstRow<{ org_id: string; revoked_at: string | null }>(
					testDb,
					"SELECT org_id, revoked_at FROM slack_workspaces WHERE team_id = 'T-shared'",
				),
			)
			assert.strictEqual(bound?.org_id, "org_a")
			assert.isNull(bound?.revoked_at)

			// ...and org_b ends up with no active workspace at all.
			const orgBActive = yield* Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"SELECT count(*)::int AS n FROM slack_workspaces WHERE org_id = 'org_b' AND revoked_at IS NULL",
				),
			)
			assert.strictEqual(orgBActive?.n, 0)
			const status = yield* slack.getStatus(asOrgId("org_b"))
			assert.strictEqual(status.installed, false)
		}).pipe(Effect.provide(withFetch(testDb, slackOAuthFetch(teamRef))))
	})

	it.effect(
		"completeInstall rejects a cross-org rebind that lands after the pre-check (transactional race)",
		() => {
			const testDb = createTestDb(trackedDbs)
			const teamRef = { current: { id: "T-race", name: "Race" } }
			// Injected between the pre-check and the transaction (apiKeys.create is the
			// only seam in between): a "concurrent" install binds T-race to org_victim.
			let injected = false
			const inject = async () => {
				if (injected) return
				injected = true
				await insertWorkspace(testDb, {
					id: "sw_victim",
					orgId: "org_victim",
					teamId: "T-race",
					teamName: "Victim",
					botToken: "xoxb-victim",
					apiKey: "maple_ak_victim",
				})
			}
			return Effect.gen(function* () {
				// org_b already has an active workspace for a different team — the
				// aborted transaction must roll back the revoke-others step for it.
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_b_old",
						orgId: "org_b",
						teamId: "T-old",
						teamName: "Old",
						botToken: "xoxb-old",
						apiKey: "maple_ak_old",
					}),
				)
				const slack = yield* SlackIntegrationService
				const start = yield* slack.startInstall(asOrgId("org_b"), asUserId("user_b"), "https://cb")
				const error = yield* Effect.flip(
					slack.completeInstall("code_r", stateFromInstallUrl(start.url)),
				)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsForbiddenError")
				assert.isTrue(injected, "the conflicting row must have been injected mid-install")

				// The victim org's binding is unchanged.
				const victim = yield* Effect.promise(() =>
					queryFirstRow<{ org_id: string; revoked_at: string | null }>(
						testDb,
						"SELECT org_id, revoked_at FROM slack_workspaces WHERE team_id = 'T-race'",
					),
				)
				assert.strictEqual(victim?.org_id, "org_victim")
				assert.isNull(victim?.revoked_at)

				// org_b's prior workspace is still active — the in-transaction
				// revocation rolled back with the aborted upsert.
				const oldRow = yield* Effect.promise(() =>
					queryFirstRow<{ revoked_at: string | null }>(
						testDb,
						"SELECT revoked_at FROM slack_workspaces WHERE team_id = 'T-old'",
					),
				)
				assert.isNull(oldRow?.revoked_at)

				// The key was minted before the transaction that then aborted; leaving it
				// behind would hand org_b an active, unusable full-access key. (The only
				// api_keys row for org_b is that mint — the workspace fixtures above
				// reference key ids that were never created.)
				const mintedKeys = yield* Effect.promise(() =>
					queryFirstRow<{ n: number; revoked_n: number }>(
						testDb,
						"SELECT count(*)::int AS n, count(*) FILTER (WHERE revoked)::int AS revoked_n FROM api_keys WHERE org_id = 'org_b'",
					),
				)
				assert.strictEqual(mintedKeys?.n, 1)
				assert.strictEqual(mintedKeys?.revoked_n, 1)
			}).pipe(
				Effect.provide(
					withFetch(testDb, slackOAuthFetch(teamRef), apiKeysWithInjectedCreate(inject)),
				),
			)
		},
	)

	// --- exchangeCode failure paths (via completeInstall) ---------------------

	it.effect(
		"completeInstall surfaces Slack's ok:false as a validation error carrying Slack's error string",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const slack = yield* SlackIntegrationService
				const start = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
				const state = stateFromInstallUrl(start.url)
				// Boundary check: at exactly the TTL the state is still valid, so the
				// flow proceeds past expiry and into the (failing) code exchange.
				yield* TestClock.adjust(SLACK_STATE_TTL_MS)
				const error = yield* Effect.flip(slack.completeInstall("code_bad", state))
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.include(error.message, "invalid_code")
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackApiFetch(OAUTH_URL, () => jsonResponse({ ok: false, error: "invalid_code" })),
					),
				),
			)
		},
	)

	it.effect("completeInstall maps a non-JSON OAuth response to an upstream error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const start = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			const error = yield* Effect.flip(slack.completeInstall("code_1", stateFromInstallUrl(start.url)))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(
						OAUTH_URL,
						() =>
							new Response("<html>maintenance</html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
					),
				),
			),
		)
	})

	it.effect("completeInstall maps an undecodable OAuth payload to an upstream error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const start = yield* slack.startInstall(asOrgId("org_a"), asUserId("user_a"), "https://cb")
			const error = yield* Effect.flip(slack.completeInstall("code_1", stateFromInstallUrl(start.url)))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
		}).pipe(
			// `ok` must be a boolean — a JSON payload with the wrong shape fails decode.
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(OAUTH_URL, () => jsonResponse({ ok: "yes", team: 42 })),
				),
			),
		)
	})

	// --- listChannels ----------------------------------------------------------

	it.effect("listChannels fails not-connected when the org has no active workspace", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.listChannels(asOrgId("org_none")))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listChannels returns a single page with field defaulting", () => {
		const testDb = createTestDb(trackedDbs)
		const urls: string[] = []
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc1",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const channels = yield* slack.listChannels(asOrgId("org_lc"))
			assert.deepStrictEqual(channels, [
				{ id: "C1", name: "general", isPrivate: true, isMember: true },
				// Missing name/is_private/is_member default to id/false/false.
				{ id: "C2", name: "C2", isPrivate: false, isMember: false },
			])
			assert.strictEqual(urls.length, 1)
			const first = new URL(urls[0]!)
			assert.isNull(first.searchParams.get("cursor"))
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(CONVERSATIONS_URL, (url) => {
						urls.push(url)
						return jsonResponse({
							ok: true,
							channels: [
								{ id: "C1", name: "general", is_private: true, is_member: true },
								{ id: "C2" },
							],
						})
					}),
				),
			),
		)
	})

	it.effect("listChannels follows next_cursor across pages and stops on an empty cursor", () => {
		const testDb = createTestDb(trackedDbs)
		const urls: string[] = []
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc2",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const channels = yield* slack.listChannels(asOrgId("org_lc"))
			assert.deepStrictEqual(
				channels.map((c) => c.id),
				["C1", "C2"],
			)
			assert.strictEqual(urls.length, 2)
			assert.isNull(new URL(urls[0]!).searchParams.get("cursor"))
			assert.strictEqual(new URL(urls[1]!).searchParams.get("cursor"), "cursor-2")
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(CONVERSATIONS_URL, (url, call) => {
						urls.push(url)
						return call === 0
							? jsonResponse({
									ok: true,
									channels: [{ id: "C1", name: "one" }],
									response_metadata: { next_cursor: "cursor-2" },
								})
							: // Slack signals "done" with an empty next_cursor.
								jsonResponse({
									ok: true,
									channels: [{ id: "C2", name: "two" }],
									response_metadata: { next_cursor: "" },
								})
					}),
				),
			),
		)
	})

	it.effect("listChannels caps pagination at SLACK_MAX_CHANNEL_PAGES pages", () => {
		const testDb = createTestDb(trackedDbs)
		let calls = 0
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc3",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const channels = yield* slack.listChannels(asOrgId("org_lc"))
			// The mock ALWAYS hands back a next_cursor — the walk must stop at the
			// page cap (SLACK_MAX_CHANNEL_PAGES = 3) instead of looping forever.
			assert.strictEqual(calls, 3)
			assert.deepStrictEqual(
				channels.map((c) => c.id),
				["C-page-0", "C-page-1", "C-page-2"],
			)
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(CONVERSATIONS_URL, (_url, call) => {
						calls++
						return jsonResponse({
							ok: true,
							channels: [{ id: `C-page-${call}` }],
							response_metadata: { next_cursor: "more" },
						})
					}),
				),
			),
		)
	})

	it.effect("listChannels maps Slack ok:false to an upstream error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc4",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.listChannels(asOrgId("org_lc")))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.include(error.message, "invalid_auth")
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(CONVERSATIONS_URL, () =>
						jsonResponse({ ok: false, error: "invalid_auth" }),
					),
				),
			),
		)
	})

	it.effect("listChannels maps a non-JSON response to an upstream error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc5",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.listChannels(asOrgId("org_lc")))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
		}).pipe(
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(
						CONVERSATIONS_URL,
						() =>
							new Response("gateway timeout", {
								status: 200,
								headers: { "content-type": "text/plain" },
							}),
					),
				),
			),
		)
	})

	it.effect("listChannels maps an undecodable payload to an upstream error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				insertWorkspace(testDb, {
					id: "sw_lc6",
					orgId: "org_lc",
					teamId: "T-LC",
					teamName: "LC",
					botToken: "xoxb-lc-token",
					apiKey: "maple_ak_lc",
				}),
			)
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.listChannels(asOrgId("org_lc")))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
		}).pipe(
			// channels must be an array of objects with a string id.
			Effect.provide(
				withFetch(
					testDb,
					slackApiFetch(CONVERSATIONS_URL, () =>
						jsonResponse({ ok: true, channels: [{ id: 42 }] }),
					),
				),
			),
		)
	})

	// --- revokeByTeamId (the Slack-side-uninstall / reconciliation path) ------

	describe("revokeByTeamId", () => {
		it.effect("revokes locally on a bare team id — no auth.revoke call, unlike uninstall", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_evt1",
						orgId: "org_evt",
						teamId: "T-EVT",
						teamName: "EvtOrg",
						botToken: "xoxb-evt",
						apiKey: "maple_ak_evt",
					}),
				)
				const slack = yield* SlackIntegrationService
				// `neverFetch` proves the token is dropped WITHOUT calling Slack — the
				// caller already knows it's dead (event-driven or reconciliation).
				const result = yield* slack.revokeByTeamId("T-EVT", "app_uninstalled")
				assert.strictEqual(result.revoked, true)

				const status = yield* slack.getStatus(asOrgId("org_evt"))
				assert.strictEqual(status.installed, false)
				// The remote revocation surfaces on status so the dashboard can say
				// the disconnect came from Slack's side.
				assert.strictEqual(status.disconnectedReason, "app_uninstalled")
				assert.isNotNull(status.disconnectedAt)

				const secrets = yield* Effect.promise(() =>
					queryFirstRow<{
						bot_token_ciphertext: string | null
						api_key_secret_ciphertext: string | null
					}>(
						testDb,
						"SELECT bot_token_ciphertext, api_key_secret_ciphertext FROM slack_workspaces WHERE team_id = 'T-EVT'",
					),
				)
				// Both secrets go immediately — unlike `uninstall`, there is no "Slack
				// didn't confirm the revoke" case to keep the bot token for.
				assert.isNull(secrets?.bot_token_ciphertext)
				assert.isNull(secrets?.api_key_secret_ciphertext)
			}).pipe(Effect.provide(withFetch(testDb, neverFetch)))
		})

		it.effect("revokes the API key minted for the bot", () => {
			const testDb = createTestDb(trackedDbs)
			const teamRef = { current: { id: "T-EVT2", name: "EvtOrg2" } }
			return Effect.gen(function* () {
				const slack = yield* SlackIntegrationService
				const start = yield* slack.startInstall(asOrgId("org_evt2"), asUserId("user_evt2"), "https://cb")
				yield* slack.completeInstall("code_evt2", stateFromInstallUrl(start.url))

				const workspace = yield* Effect.promise(() =>
					queryFirstRow<{ api_key_id: string }>(
						testDb,
						"SELECT api_key_id FROM slack_workspaces WHERE team_id = 'T-EVT2'",
					),
				)
				assert.isString(workspace?.api_key_id)

				// `neverFetch` for the revoke itself would be wrong here — the layer is
				// shared across install (which DOES call Slack) and revoke (which must
				// NOT) — so scope the "no upstream call" assertion to auth.revoke only
				// by never registering that endpoint below.
				yield* slack.revokeByTeamId("T-EVT2", "tokens_revoked")

				const keyRow = yield* Effect.promise(() =>
					queryFirstRow<{ revoked: boolean }>(testDb, "SELECT revoked FROM api_keys WHERE id = $1", [
						workspace!.api_key_id,
					]),
				)
				assert.strictEqual(keyRow?.revoked, true)
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer(testDb),
						testDb.layer,
						Layer.succeed(FetchHttpClient.Fetch, slackOAuthFetch(teamRef)),
					),
				),
			)
		})

		it.effect("is a no-op for an unknown or already-revoked team id", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_evt3",
						orgId: "org_evt3",
						teamId: "T-EVT3",
						teamName: "EvtOrg3",
						botToken: "xoxb-evt3",
						apiKey: "maple_ak_evt3",
					}),
				)
				const slack = yield* SlackIntegrationService
				const unknown = yield* slack.revokeByTeamId("T-nonexistent", "app_uninstalled")
				assert.strictEqual(unknown.revoked, false)

				yield* slack.revokeByTeamId("T-EVT3", "app_uninstalled")
				const again = yield* slack.revokeByTeamId("T-EVT3", "app_uninstalled")
				assert.strictEqual(again.revoked, false)
			}).pipe(Effect.provide(withFetch(testDb, neverFetch)))
		})
	})

	// --- reconcileWorkspaces (the cron backstop) -------------------------------

	describe("reconcileWorkspaces", () => {
		it.effect("revokes only workspaces whose auth.test reports a dead-token error", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_rc_dead",
						orgId: "org_rc_dead",
						teamId: "T-DEAD",
						teamName: "Dead",
						botToken: "xoxb-dead",
						apiKey: "maple_ak_dead",
					}),
				)
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_rc_alive",
						orgId: "org_rc_alive",
						teamId: "T-ALIVE",
						teamName: "Alive",
						botToken: "xoxb-alive",
						apiKey: "maple_ak_alive",
					}),
				)
				const slack = yield* SlackIntegrationService
				const result = yield* slack.reconcileWorkspaces()
				assert.strictEqual(result.probed, 2)
				assert.strictEqual(result.revoked, 1)

				const statuses = yield* Effect.all({
					dead: slack.getStatus(asOrgId("org_rc_dead")),
					alive: slack.getStatus(asOrgId("org_rc_alive")),
				})
				assert.strictEqual(statuses.dead.installed, false)
				assert.strictEqual(statuses.dead.disconnectedReason, "reconciliation")
				assert.strictEqual(statuses.alive.installed, true)
				assert.isNull(statuses.alive.disconnectedReason)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackAuthTestFetch({
							"xoxb-dead": { ok: false, error: "invalid_auth" },
							"xoxb-alive": { ok: true },
						}),
					),
				),
			)
		})

		it.effect("does not revoke on an unrecognized ok:false error code (avoid false positives)", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_rc_unknown",
						orgId: "org_rc_unknown",
						teamId: "T-UNKNOWN-ERR",
						teamName: "UnknownErr",
						botToken: "xoxb-unknown",
						apiKey: "maple_ak_unknown",
					}),
				)
				const slack = yield* SlackIntegrationService
				const result = yield* slack.reconcileWorkspaces()
				assert.strictEqual(result.probed, 1)
				// `ratelimited` (or any code outside the known dead-token set) must not
				// trigger a revoke — reconciliation runs unattended.
				assert.strictEqual(result.revoked, 0)
				const status = yield* slack.getStatus(asOrgId("org_rc_unknown"))
				assert.strictEqual(status.installed, true)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackApiFetch(AUTH_TEST_URL, () =>
							jsonResponse({ ok: false, error: "ratelimited" }),
						),
					),
				),
			)
		})

		it.effect("leaves a workspace untouched when the probe response fails to decode", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_rc_bad",
						orgId: "org_rc_bad",
						teamId: "T-BADRESP",
						teamName: "BadResp",
						botToken: "xoxb-badresp",
						apiKey: "maple_ak_badresp",
					}),
				)
				const slack = yield* SlackIntegrationService
				const result = yield* slack.reconcileWorkspaces()
				assert.strictEqual(result.probed, 1)
				assert.strictEqual(result.revoked, 0)
				const status = yield* slack.getStatus(asOrgId("org_rc_bad"))
				assert.strictEqual(status.installed, true)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackApiFetch(
							AUTH_TEST_URL,
							() =>
								new Response("gateway timeout", {
									status: 200,
									headers: { "content-type": "text/plain" },
								}),
						),
					),
				),
			)
		})

		it.effect("does not count a confirmed-dead workspace as revoked when the local revoke fails", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					insertWorkspace(testDb, {
						id: "sw_rc_dbfail",
						orgId: "org_rc_dbfail",
						teamId: "T-DBFAIL",
						teamName: "DbFail",
						botToken: "xoxb-dbfail",
						apiKey: "maple_ak_dbfail",
					}),
				)
				// The probe confirms the token dead, but persisting the revoke blows up
				// (trigger below) — the run must report it as NOT revoked so the next
				// cron tick retries instead of the failure inflating the revoke metric.
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`CREATE FUNCTION slack_workspaces_block_update() RETURNS trigger AS $$
						BEGIN RAISE EXCEPTION 'simulated persistence failure'; END $$ LANGUAGE plpgsql`,
					),
				)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`CREATE TRIGGER slack_workspaces_block_update BEFORE UPDATE ON slack_workspaces
						FOR EACH ROW EXECUTE FUNCTION slack_workspaces_block_update()`,
					),
				)
				const slack = yield* SlackIntegrationService
				const result = yield* slack.reconcileWorkspaces()
				assert.strictEqual(result.probed, 1)
				assert.strictEqual(result.revoked, 0)
				// The row is still active — the failed revoke left it for the next run.
				const status = yield* slack.getStatus(asOrgId("org_rc_dbfail"))
				assert.strictEqual(status.installed, true)
			}).pipe(
				Effect.provide(
					withFetch(
						testDb,
						slackAuthTestFetch({ "xoxb-dbfail": { ok: false, error: "token_revoked" } }),
					),
				),
			)
		})

		it.effect("reports probed:0, revoked:0 when there are no active workspaces", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const slack = yield* SlackIntegrationService
				const result = yield* slack.reconcileWorkspaces()
				assert.deepStrictEqual(result, { probed: 0, revoked: 0 })
			}).pipe(Effect.provide(withFetch(testDb, neverFetch)))
		})
	})
})

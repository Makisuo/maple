import { createCipheriv, randomBytes } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import {
	resolveSlackBotTokenForDispatch,
	SlackIntegrationService,
} from "./SlackIntegrationService"
import { ApiKeysService } from "./ApiKeysService"
import { OAuthStateRepository } from "./OAuthStateRepository"
import { Database } from "../lib/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"

const ENCRYPTION_KEY = Buffer.alloc(32, 7)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY.toString("base64")

/** AES-256-GCM encrypt matching Crypto.ts's format (12-byte iv, base64 fields). */
const encryptField = (plaintext: string, key: Buffer) => {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key, iv)
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
			...(slackConfigured
				? { SLACK_CLIENT_ID: "123.abc", SLACK_CLIENT_SECRET: "shhh" }
				: {}),
		}),
	)

const makeLayer = (testDb: TestDb, slackConfigured = true) =>
	SlackIntegrationService.layer.pipe(
		Layer.provide(Layer.mergeAll(ApiKeysService.layer, OAuthStateRepository.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(slackConfigured)),
	)

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

const stateFromInstallUrl = (url: string): string => {
	const state = new URL(url).searchParams.get("state")
	if (!state) throw new Error("install url missing state")
	return state
}

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** Insert an active, encrypted slack_workspaces row directly (bypasses OAuth). */
const insertWorkspace = async (
	testDb: TestDb,
	opts: { id: string; orgId: string; teamId: string; teamName: string; botToken: string; apiKey: string },
) => {
	const bot = encryptField(opts.botToken, ENCRYPTION_KEY)
	const key = encryptField(opts.apiKey, ENCRYPTION_KEY)
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

	it.effect("completeInstall rejects an expired state (and burns it)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					// @effect/vitest it.effect freezes the Clock at epoch 0 (1970), so an
					// "expired" state must sit before that — use a pre-1970 timestamp.
					`INSERT INTO oauth_auth_states (state, org_id, provider, initiated_by_user_id, redirect_uri, created_at, expires_at)
					 VALUES ($1,$2,$3,$4,$5, timestamptz '1969-01-01 00:00:00+00', timestamptz '1969-06-01 00:00:00+00')`,
					["expired-state", "org_a", "slack", "user_a", "https://cb"],
				),
			)
			const slack = yield* SlackIntegrationService
			const error = yield* Effect.flip(slack.completeInstall("code_1", "expired-state"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "expired")
			const remaining = yield* Effect.promise(() =>
				queryFirstRow(testDb, "SELECT state FROM oauth_auth_states WHERE state = $1", [
					"expired-state",
				]),
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

	it.effect("uninstall revokes the workspace so it reads as not-installed", () => {
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
			const slack = yield* SlackIntegrationService
			const result = yield* slack.uninstall(asOrgId("org_b"))
			assert.strictEqual(result.uninstalled, true)

			const status = yield* slack.getStatus(asOrgId("org_b"))
			assert.strictEqual(status.installed, false)
			// resolveForBot skips revoked rows too
			const error = yield* Effect.flip(slack.resolveForBot("T0999"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")
		}).pipe(Effect.provide(makeLayer(testDb)))
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
})

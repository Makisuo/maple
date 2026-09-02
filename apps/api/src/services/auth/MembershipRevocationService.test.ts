import { afterEach, describe, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { EdgeCacheService, type EdgeCacheServiceApi } from "@maple/cache"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { encryptAes256Gcm } from "@/platform/Crypto"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { CliDeviceAuthService } from "./CliDeviceAuthService"
import { McpOAuthService } from "./McpOAuthService"
import { MembershipRevocationService } from "./MembershipRevocationService"
import { ORG_MEMBERSHIP_CACHE_BUCKET } from "./OrgMembershipService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 3)

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

/** Records what was evicted; nothing here needs a real edge cache. */
const recordingEdgeCache = () => {
	const invalidated: Array<{ bucket: string; key: string }> = []
	const api: EdgeCacheServiceApi = {
		getOrCompute: (_options, compute) =>
			compute.pipe(Effect.map((value) => ({ value, status: "miss", readMs: 0, wrote: false }))),
		invalidate: (options) =>
			Effect.sync(() => void invalidated.push({ bucket: options.bucket, key: options.key })),
		rawGetDetailed: () => Effect.succeed({ status: "miss", value: Option.none(), readMs: 0 }),
		rawGet: () => Effect.succeed(Option.none()),
		rawPut: () => Effect.void,
	}
	const layer = Layer.succeed(EdgeCacheService, api)
	return { invalidated, layer }
}

const makeLayer = (testDb: TestDb, edgeCache: Layer.Layer<EdgeCacheService>) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	return Layer.mergeAll(
		MembershipRevocationService.layer.pipe(Layer.provide(Layer.mergeAll(base, edgeCache))),
		McpOAuthService.layer.pipe(Layer.provide(base)),
		CliDeviceAuthService.layer.pipe(Layer.provideMerge(apiKeys), Layer.provide(base)),
		apiKeys,
		base,
	)
}

const orgId = Schema.decodeUnknownSync(OrgId)("org_revoke")
const otherOrgId = Schema.decodeUnknownSync(OrgId)("org_other")
const userId = Schema.decodeUnknownSync(UserId)("user_leaver")
const stayerId = Schema.decodeUnknownSync(UserId)("user_stayer")
const memberRole = Schema.decodeUnknownSync(RoleName)("org:member")
const adminRole = Schema.decodeUnknownSync(RoleName)("org:admin")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

const seedEmailDestination = (db: TestDb, id: string, org: OrgId, members: Array<UserId>) =>
	Effect.gen(function* () {
		const secret = JSON.stringify({
			type: "email",
			members: members.map((member) => ({
				userId: member,
				email: `${member}@example.com`,
				name: null,
			})),
		})
		const encrypted = yield* encryptAes256Gcm(secret, ENCRYPTION_KEY, (message) => new Error(message))
		yield* Effect.promise(() =>
			db.pglite.query(
				`insert into alert_destinations
					(id, org_id, name, type, config_json, secret_ciphertext, secret_iv, secret_tag,
					 created_at, updated_at, created_by, updated_by)
				 values ($1, $2, 'Oncall email', 'email', $3, $4, $5, $6, now(), now(), 'seed', 'seed')`,
				[
					id,
					org,
					JSON.stringify({
						summary: "Oncall",
						channelLabel: null,
						memberUserIds: members,
					}),
					encrypted.ciphertext,
					encrypted.iv,
					encrypted.tag,
				],
			),
		)
	})

const seedMobileDevice = (db: TestDb, id: string, org: OrgId, user: UserId) =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into mobile_devices
				(id, org_id, user_id, platform, token, environment, bundle_id, preferences,
				 last_seen_at, created_at, updated_at)
			 values ($1, $2, $3, 'ios', $1, 'production', 'dev.maple.app', '{}'::jsonb, now(), now(), now())`,
			[id, org, user],
		),
	)

const issueMcpGrant = Effect.fnUntraced(function* (
	oauth: McpOAuthService,
	user: UserId,
	org: OrgId,
	roles: ReadonlyArray<RoleName> = [memberRole],
) {
	const client = yield* oauth.register(
		{ clientName: `Client ${user}`, redirectUris: [redirectUri] },
		"127.0.0.1",
	)
	const started = yield* oauth.startAuthorization(
		{
			clientId: client.client_id,
			redirectUri,
			responseType: "code",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
			resource,
			expectedResource: resource,
		},
		"127.0.0.1",
	)
	const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
	const approved = yield* oauth.approve(requestId, {
		orgId: org,
		userId: user,
		roles,
		userEmail: null,
	})
	const tokens = yield* oauth.exchangeAuthorizationCode(
		{
			code: new URL(approved.redirectUri).searchParams.get("code")!,
			clientId: client.client_id,
			redirectUri,
			codeVerifier: verifier,
			resource,
		},
		"127.0.0.1",
	)
	return { clientId: client.client_id, tokens }
})

const countRows = (db: TestDb, sql: string, params: unknown[] = []) =>
	Effect.promise(() => queryFirstRow<{ count: number }>(db, sql, params)).pipe(
		Effect.map((row) => Number(row?.count ?? 0)),
	)

describe("MembershipRevocationService", () => {
	it.effect("retires every credential a removed member held in that org", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const cli = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService

			const grant = yield* issueMcpGrant(oauth, userId, orgId)
			const started = yield* cli.start("Leaver laptop", "127.0.0.1")
			yield* cli.approve(started.userCode, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: null,
			})
			const cliToken = yield* cli.poll(started.deviceCode)
			yield* seedMobileDevice(db, "dev_leaver", orgId, userId)
			yield* seedEmailDestination(db, "dest_shared", orgId, [userId, stayerId])

			expect(Option.isSome(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)

			const summary = yield* revocation.revokeMembership(orgId, userId)

			// The cache is the widest window and is evicted first.
			expect(cache.invalidated).toEqual([{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId }])
			expect(summary.mcpFamiliesRevoked).toBe(1)
			expect(summary.cliAuthorizationsDeleted).toBe(1)
			expect(summary.mobileDevicesDeleted).toBe(1)
			expect(summary.emailDestinationsUpdated).toBe(1)

			// Both credentials are dead, and the MCP grant cannot be refreshed back.
			expect(Option.isNone(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)
			if (cliToken.status === "complete") {
				expect(Option.isNone(yield* apiKeys.resolveByKey(cliToken.token))).toBe(true)
			}
			const refreshFailure = yield* oauth
				.refresh(
					{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(refreshFailure._tag).toBe("@maple/api/errors/McpOAuthProtocolError")

			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(0)
			expect(yield* countRows(db, "select count(*)::int as count from cli_device_authorizations")).toBe(
				0,
			)
			expect(
				yield* countRows(
					db,
					"select count(*)::int as count from mcp_oauth_refresh_tokens where revoked_at is null",
				),
			).toBe(0)

			// The remaining member keeps the destination; the leaver is gone from
			// both the public config and the encrypted recipient snapshot.
			const destination = yield* Effect.promise(() =>
				queryFirstRow<{ config_json: { memberUserIds: string[] }; enabled: boolean }>(
					db,
					"select config_json, enabled from alert_destinations where id = 'dest_shared'",
				),
			)
			expect(destination?.config_json.memberUserIds).toEqual([stayerId])
			expect(destination?.enabled).toBe(true)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("leaves other organizations and other members untouched", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService

			const elsewhere = yield* issueMcpGrant(oauth, userId, otherOrgId)
			yield* seedMobileDevice(db, "dev_other_org", otherOrgId, userId)
			yield* seedMobileDevice(db, "dev_other_user", orgId, stayerId)

			yield* revocation.revokeMembership(orgId, userId)

			expect(Option.isSome(yield* apiKeys.resolveByKey(elsewhere.tokens.access_token))).toBe(true)
			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(2)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("disables an email destination whose last recipient left", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedEmailDestination(db, "dest_solo", orgId, [userId])

			yield* revocation.revokeMembership(orgId, userId)

			const destination = yield* Effect.promise(() =>
				queryFirstRow<{
					enabled: boolean
					disabled_reason: string | null
					config_json: { memberUserIds: string[] }
				}>(db, "select enabled, disabled_reason, config_json from alert_destinations"),
			)
			expect(destination?.config_json.memberUserIds).toEqual([])
			// Disabled rather than deleted: the rules pointing at it stay valid and
			// an admin can see why it went quiet.
			expect(destination?.enabled).toBe(false)
			expect(destination?.disabled_reason).toContain("left the organization")
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("is idempotent, so a webhook retry converges instead of double-applying", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			yield* issueMcpGrant(oauth, userId, orgId)
			yield* seedMobileDevice(db, "dev_retry", orgId, userId)
			yield* seedEmailDestination(db, "dest_retry", orgId, [userId, stayerId])

			const first = yield* revocation.revokeMembership(orgId, userId)
			const second = yield* revocation.revokeMembership(orgId, userId)

			expect(first.mobileDevicesDeleted).toBe(1)
			expect(first.emailDestinationsUpdated).toBe(1)
			expect(second.mobileDevicesDeleted).toBe(0)
			expect(second.apiKeysRevoked).toBe(0)
			// The second pass finds the member already absent and rewrites nothing.
			expect(second.emailDestinationsUpdated).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("retires the admin-pinned keys of a demoted member and spares everyone else's", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const cli = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService

			// `maple auth login` as an admin: the CLI key freezes `org:admin` into
			// its metadata and `resolveByKey` never re-checks the membership.
			const asAdmin = yield* cli.start("Admin laptop", "127.0.0.1")
			yield* cli.approve(asAdmin.userCode, {
				orgId,
				userId,
				roles: [adminRole],
				userEmail: null,
			})
			const adminToken = yield* cli.poll(asAdmin.deviceCode)
			// A second member who was never an admin, and the same user in another org.
			const asMember = yield* cli.start("Member laptop", "127.0.0.1")
			yield* cli.approve(asMember.userCode, {
				orgId,
				userId: stayerId,
				roles: [memberRole],
				userEmail: null,
			})
			const memberToken = yield* cli.poll(asMember.deviceCode)
			const elsewhere = yield* cli.start("Other org laptop", "127.0.0.1")
			yield* cli.approve(elsewhere.userCode, {
				orgId: otherOrgId,
				userId,
				roles: [adminRole],
				userEmail: null,
			})
			const elsewhereToken = yield* cli.poll(elsewhere.deviceCode)

			// A promotion strips nothing.
			const promoted = yield* revocation.demoteMembership(orgId, userId, [adminRole])
			expect(promoted.apiKeysRevoked).toBe(0)

			const demoted = yield* revocation.demoteMembership(orgId, userId, [memberRole])
			expect(demoted.apiKeysRevoked).toBe(1)
			expect(cache.invalidated).toEqual([
				{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId },
				{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId },
			])

			if (adminToken.status === "complete") {
				expect(Option.isNone(yield* apiKeys.resolveByKey(adminToken.token))).toBe(true)
			}
			if (memberToken.status === "complete") {
				expect(Option.isSome(yield* apiKeys.resolveByKey(memberToken.token))).toBe(true)
			}
			if (elsewhereToken.status === "complete") {
				expect(Option.isSome(yield* apiKeys.resolveByKey(elsewhereToken.token))).toBe(true)
			}

			// Idempotent, so a Clerk retry converges.
			const retry = yield* revocation.demoteMembership(orgId, userId, [memberRole])
			expect(retry.apiKeysRevoked).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("kills the refresh family behind a demoted member's MCP grant", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService

			const grant = yield* issueMcpGrant(oauth, userId, orgId, [adminRole])
			const summary = yield* revocation.demoteMembership(orgId, userId, [memberRole])

			// The visible key alone would be re-minted by the next rotation.
			expect(summary.apiKeysRevoked).toBe(1)
			expect(summary.mcpFamiliesRevoked).toBe(1)
			expect(Option.isNone(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)
			expect(
				yield* countRows(
					db,
					"select count(*)::int as count from mcp_oauth_refresh_tokens where revoked_at is null",
				),
			).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("sweeps every org for a deleted user", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedMobileDevice(db, "dev_a", orgId, userId)
			yield* seedMobileDevice(db, "dev_b", otherOrgId, userId)
			yield* seedMobileDevice(db, "dev_c", orgId, stayerId)

			const summary = yield* revocation.revokeUser(userId)

			expect(summary.mobileDevicesDeleted).toBe(2)
			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(1)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})
})

import { afterEach, describe, expect, it, layer } from "@effect/vitest"
import {
	OrgClickHouseSettingsUpstreamRejectedError,
	OrgClickHouseSettingsUpstreamUnavailableError,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsStoredConfigInvalidError,
	OrgClickHouseSettingsValidationError,
	OrgId,
	RoleName,
} from "@maple/domain/http"
import {
	EdgeCacheService,
	type EdgeCacheBackend,
	makeEdgeCacheService,
	MemoryCacheBackendLive,
} from "@maple/cache"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import type { TableDiffEntry } from "@maple/domain/clickhouse"
import { Env } from "@/platform/Env"
import { encryptAes256Gcm } from "@/platform/Crypto"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import {
	type ClickHouseExecConfig,
	execClickHouse,
	invalidateOrgRuntimeConfigMemo,
	isRetryableUpstream,
	OrgClickHouseSettingsService,
	shouldHealSchemaVersion,
	validateClickHouseCredentialTransport,
} from "./OrgClickHouseSettingsService"

// `execClickHouse` runs through Effect's HttpClient. We inject a stub `fetch` via
// `FetchHttpClient.Fetch` (deterministic per run — no global mutation) and assert
// both the mapped error AND the number of fetch attempts, which is how we verify
// the retry policy (only transient gateway/network failures are retried, never
// timeouts or genuine ClickHouse SQL errors).

const CONFIG: ClickHouseExecConfig = {
	url: "https://clickhouse.example.test",
	user: "default",
	password: "secret",
	database: "maple",
}

const mockResponse = (body: string, status: number): Response => new Response(body, { status })

/** Build a stub `fetch` that runs `impl` and counts calls. */
const makeFetch = (impl: () => Promise<Response>) => {
	const state = { calls: 0 }
	const fetchImpl = (() => {
		state.calls += 1
		return impl()
	}) as typeof globalThis.fetch
	return { state, fetchImpl }
}

/** Run execClickHouse with the stub fetch injected. */
const run = (sql: string, fetchImpl: typeof globalThis.fetch) =>
	execClickHouse(CONFIG, sql).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchImpl))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure
	return Cause.squash(exit.cause)
}

const unavailable = (statusCode: number | null) =>
	new OrgClickHouseSettingsUpstreamUnavailableError({ message: "x", statusCode })
const rejected = (statusCode: number | null) =>
	new OrgClickHouseSettingsUpstreamRejectedError({ message: "x", statusCode })

describe("validateClickHouseCredentialTransport", () => {
	it.effect("rejects sending a ClickHouse password over plaintext HTTP", () =>
		Effect.gen(function* () {
			const exit = yield* validateClickHouseCredentialTransport(
				"http://clickhouse.example.test",
				"secret",
			).pipe(Effect.exit)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsValidationError)
		}),
	)

	it.effect("allows HTTPS credentials and passwordless HTTP", () =>
		Effect.gen(function* () {
			yield* validateClickHouseCredentialTransport("https://clickhouse.example.test", "secret")
			yield* validateClickHouseCredentialTransport("http://clickhouse.example.test", "")
		}),
	)

	it.effect("rejects URL-embedded userinfo even without a separate password", () =>
		Effect.gen(function* () {
			const exit = yield* validateClickHouseCredentialTransport(
				"https://user:secret@clickhouse.example.test",
				"",
			).pipe(Effect.exit)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsValidationError)
		}),
	)
})

describe("shouldHealSchemaVersion", () => {
	const REV = "019c3db4cf690e3748b302098cae4c9213d18c55355db9fc68ea44982c7a980a"
	const STALE = "4d5d918315933608d316aa8d6e6b57948f15a3fdca2fa6226aa271553f0b0520"
	const upToDate = (name: string): TableDiffEntry => ({
		status: "up_to_date",
		name,
		kind: "table",
	})
	const inSync: ReadonlyArray<TableDiffEntry> = [upToDate("traces"), upToDate("logs")]

	it("heals when the live schema is in sync but the stored revision is stale", () => {
		// The exact production case: CH applied via the standalone CLI (so Maple's database was never
		// stamped) or a revision bump left it behind, yet every table is up_to_date.
		expect(shouldHealSchemaVersion(inSync, STALE, REV)).toBe(true)
		expect(shouldHealSchemaVersion(inSync, null, REV)).toBe(true)
	})

	it("does not heal when the stored revision already matches", () => {
		expect(shouldHealSchemaVersion(inSync, REV, REV)).toBe(false)
	})

	it("does not heal when any table is missing or drifted", () => {
		const missing: ReadonlyArray<TableDiffEntry> = [
			upToDate("traces"),
			{ status: "missing", name: "logs", kind: "table" },
		]
		const drifted: ReadonlyArray<TableDiffEntry> = [
			{ status: "drifted", name: "traces", kind: "table", columnDrifts: [] },
		]
		expect(shouldHealSchemaVersion(missing, STALE, REV)).toBe(false)
		expect(shouldHealSchemaVersion(drifted, STALE, REV)).toBe(false)
	})

	it("does not heal off an empty diff (degenerate / failed schema fetch)", () => {
		expect(shouldHealSchemaVersion([], STALE, REV)).toBe(false)
	})
})

describe("isRetryableUpstream", () => {
	it("retries transient gateway/proxy codes and network failures, nothing else", () => {
		// Transient → retry.
		expect(isRetryableUpstream(unavailable(null))).toBe(true) // connection reset/refused
		expect(isRetryableUpstream(unavailable(502))).toBe(true)
		expect(isRetryableUpstream(unavailable(503))).toBe(true)
		expect(isRetryableUpstream(unavailable(504))).toBe(true)
		expect(isRetryableUpstream(unavailable(520))).toBe(true)
		expect(isRetryableUpstream(unavailable(524))).toBe(true) // Cloudflare edge timeout
		expect(isRetryableUpstream(unavailable(529))).toBe(true)

		// Not transient → do not retry.
		expect(isRetryableUpstream(unavailable(408))).toBe(false) // our own timeout
		expect(isRetryableUpstream(unavailable(500))).toBe(false) // ClickHouse SQL error
		expect(isRetryableUpstream(unavailable(501))).toBe(false)
		expect(isRetryableUpstream(rejected(400))).toBe(false) // 4xx rejection
		expect(isRetryableUpstream(rejected(401))).toBe(false)
	})
})

layer(FetchHttpClient.layer, { excludeTestServices: true })("execClickHouse", (it) => {
	it.effect("uses manual redirects and rejects every 3xx without following it", () =>
		Effect.gen(function* () {
			let redirectMode: RequestRedirect | undefined
			let calls = 0
			const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
				calls += 1
				redirectMode = init?.redirect
				return new Response("moved", {
					status: 307,
					headers: { Location: "https://attacker.example/steal" },
				})
			}) as typeof fetch
			const exit = yield* run("SELECT 1", fetchImpl).pipe(Effect.exit)
			const failure = getError(exit)
			expect(failure).toBeInstanceOf(OrgClickHouseSettingsUpstreamRejectedError)
			expect((failure as OrgClickHouseSettingsUpstreamRejectedError).statusCode).toBe(307)
			expect(redirectMode).toBe("manual")
			expect(calls).toBe(1)
		}),
	)

	it.effect("maps a Cloudflare 524 to a clear, actionable message (and retries 52x)", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(mockResponse("error code: 524", 524)),
			)

			const exit = yield* run("SELECT 1", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			const err = getError(exit)
			expect(err).toBeInstanceOf(OrgClickHouseSettingsUpstreamUnavailableError)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).statusCode).toBe(524)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain("Cloudflare 524")
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain("allowlist")
			// 52x is transient → 1 initial attempt + 2 retries.
			expect(state.calls).toBe(3)
		}),
	)

	it.effect("retries a transient 503 then succeeds", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(
					state.calls === 1 ? mockResponse("bad gateway", 503) : mockResponse("ok", 200),
				),
			)

			const text = yield* run("SELECT 1", fetchImpl)

			expect(text).toBe("ok")
			expect(state.calls).toBe(2)
		}),
	)

	it.effect("does NOT retry a 4xx rejection", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() => Promise.resolve(mockResponse("Syntax error", 400)))

			const exit = yield* run("SELEKT 1", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsUpstreamRejectedError)
			expect(state.calls).toBe(1)
		}),
	)

	it.effect("does NOT retry a ClickHouse 500 SQL error (carries the DB::Exception text)", () =>
		Effect.gen(function* () {
			const { state, fetchImpl } = makeFetch(() =>
				Promise.resolve(mockResponse("Code: 60. DB::Exception: UNKNOWN_TABLE", 500)),
			)

			const exit = yield* run("SELECT * FROM nope", fetchImpl).pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			const err = getError(exit)
			expect(err).toBeInstanceOf(OrgClickHouseSettingsUpstreamUnavailableError)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).statusCode).toBe(500)
			// Generic upstream message, NOT the Cloudflare 52x guidance.
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).toContain(
				"ClickHouse upstream error (500)",
			)
			expect((err as OrgClickHouseSettingsUpstreamUnavailableError).message).not.toContain("Cloudflare")
			expect(state.calls).toBe(1)
		}),
	)
})

// `resolveRuntimeConfig` runs on the hot path of every warehouse SQL execution
// (and once per missing bucket in the cache fan-out), so it must never block on
// Postgres. It answers from a module-scoped in-isolate memo served
// stale-while-revalidate, decrypting per-request.
//
// These tests pin the three branches that behaviour turns on — fresh, stale
// (serve + refresh in the background), and past the hard ceiling (block) — plus
// the invalidation that a settings write performs.
//
// The memo is MODULE-scoped, so it outlives any one test: every test here must
// use its own `orgId` or it will read another test's entry.
describe("resolveRuntimeConfig caching", () => {
	const cacheTrackedDbs: TestDb[] = []
	afterEach(async () => {
		await cleanupTestDbs(cacheTrackedDbs)
	})

	const asOrgId = Schema.decodeUnknownSync(OrgId)
	const asRole = Schema.decodeUnknownSync(RoleName)

	const configLive = ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)

	// Most tests below isolate the in-isolate memo. Keep EdgeCacheService present
	// (it is a required dependency) while making its backend a deliberate miss.
	const missOnlyBackend: EdgeCacheBackend = {
		name: "memory",
		get: () => Promise.resolve(undefined),
		put: () => Promise.resolve(),
		delete: () => Promise.resolve(),
	}

	const buildLayer = (testDb: TestDb) => {
		const envLive = Env.layer.pipe(Layer.provide(configLive))
		const edgeCacheLive = Layer.succeed(EdgeCacheService)(makeEdgeCacheService(missOnlyBackend))
		return OrgClickHouseSettingsService.layer.pipe(
			Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
		)
	}

	const buildCachedLayer = (testDb: TestDb) => {
		const envLive = Env.layer.pipe(Layer.provide(configLive))
		const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
		return OrgClickHouseSettingsService.layer.pipe(
			Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
		)
	}

	const seedRow = (db: TestDb, orgId: string, chUrl: string) =>
		executeSql(
			db,
			`INSERT INTO org_clickhouse_settings
				(org_id, ch_url, ch_user, ch_database, sync_status, created_at, updated_at, created_by, updated_by)
			 VALUES ($1, $2, 'default', 'maple', 'connected', NOW(), NOW(), 'u', 'u')`,
			[orgId, chUrl],
		)

	const seedPasswordRow = async (db: TestDb, orgId: string, chUrl: string) => {
		const encrypted = await Effect.runPromise(
			encryptAes256Gcm("legacy-password", Buffer.alloc(32, 5), (message) => new Error(message)),
		)
		await executeSql(
			db,
			`INSERT INTO org_clickhouse_settings
				(org_id, ch_url, ch_user, ch_database, ch_password_ciphertext, ch_password_iv,
				 ch_password_tag, sync_status, created_at, updated_at, created_by, updated_by)
			 VALUES ($1, $2, 'default', 'maple', $3, $4, $5, 'connected', NOW(), NOW(), 'u', 'u')`,
			[orgId, chUrl, encrypted.ciphertext, encrypted.iv, encrypted.tag],
		)
	}

	const expectSome = <A>(o: Option.Option<A>): A => {
		expect(Option.isSome(o)).toBe(true)
		return (o as Option.Some<A>).value
	}

	it.effect("distinguishes invalid saved settings from invalid request input", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_invalid_saved_config"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "ftp://clickhouse.example.test"))
			const exit = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId)).pipe(
				Effect.exit,
			)
			const error = getError(exit)
			expect(error).toBeInstanceOf(OrgClickHouseSettingsStoredConfigInvalidError)
			if (!(error instanceof OrgClickHouseSettingsStoredConfigInvalidError)) return
			expect(error.cause).toBeInstanceOf(OrgClickHouseSettingsValidationError)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("serves the config from cache — a direct Postgres mutation stays invisible", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_cache"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))

			const first = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(first).url).toBe("https://a.example")

			// Mutate the row directly in Postgres; a cached resolve must NOT see it.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			const second = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			// Still the original URL → proves the second resolve never hit Postgres.
			expect(expectSome(second).url).toBe("https://a.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("primeRuntimeConfigs warms many orgs at once, memoizing the managed org as null", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const byoOrg = "org_ch_prime_byo"
		const managedOrg = "org_ch_prime_managed"
		return Effect.gen(function* () {
			const service = yield* OrgClickHouseSettingsService
			yield* Effect.promise(() => seedRow(testDb, byoOrg, "https://primed.example"))

			// One call covering both orgs — the managed one has no settings row at all.
			yield* service.primeRuntimeConfigs([asOrgId(byoOrg), asOrgId(managedOrg)])

			// Move Postgres out from under both entries. Neither resolve may see it.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					byoOrg,
					"https://changed.example",
				]),
			)
			yield* Effect.promise(() => seedRow(testDb, managedOrg, "https://appeared.example"))

			const byo = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(byoOrg))
			expect(expectSome(byo).url).toBe("https://primed.example")

			// The negative answer has to be memoized too — it is the common case
			// (managed orgs route to Tinybird) and the whole point of priming them.
			const managed = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(managedOrg))
			expect(Option.isNone(managed)).toBe(true)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("primeRuntimeConfigs leaves a still-fresh entry alone", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_prime_fresh"
		return Effect.gen(function* () {
			const service = yield* OrgClickHouseSettingsService
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://fresh.example"))

			// Populate the memo, then change Postgres behind it.
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://rewritten.example",
				]),
			)

			// Priming must skip an entry inside its fresh window, so this cannot
			// pull the newer row forward — priming is an optimization, never a
			// refresh, and must not change what a caller would otherwise observe.
			yield* service.primeRuntimeConfigs([asOrgId(orgId)])

			const resolved = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(resolved).url).toBe("https://fresh.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("a settings write busts the cached entry", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_invalidate"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))

			// Populate the cache.
			const before = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(Option.isSome(before)).toBe(true)

			// Delete through the service — this invalidates the cached entry.
			yield* OrgClickHouseSettingsService.delete(asOrgId(orgId), [asRole("org:admin")])

			const after = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			// Would still be a stale `Some` if the write had not busted the cache.
			expect(Option.isNone(after)).toBe(true)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	// --- shared edge-cache tier ---------------------------------------------
	//
	// The tier between the memo and Postgres. What makes these tests meaningful
	// is `invalidateOrgRuntimeConfigMemo`, which drops ONLY the memo — so it
	// simulates the case the tier exists for: a second, cold isolate resolving
	// the same org while the shared entry is already warm.
	//
	// Every assertion is therefore "Postgres moved and the resolve did not see
	// it", which is only possible if the value came from the shared cache.
	it.effect("a managed org is a shared-cache hit on a cold isolate, not a Postgres read", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_edge_managed"
		return Effect.gen(function* () {
			// No settings row at all — the common case, and the one that caches
			// `null`. If the envelope ever stopped round-tripping, this is the test
			// that catches it: the majority of orgs would silently never cache.
			const first = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(Option.isNone(first)).toBe(true)

			// Cold isolate: memo gone, shared entry still warm.
			invalidateOrgRuntimeConfigMemo(orgId)
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://appeared.example"))

			const second = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			// Still none → the cached `null` answered, Postgres was never dialled.
			expect(Option.isNone(second)).toBe(true)
		}).pipe(Effect.provide(buildCachedLayer(testDb)))
	})

	it.effect("a BYO org is a shared-cache hit on a cold isolate", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_edge_byo"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://cached.example"))
			const first = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(first).url).toBe("https://cached.example")

			invalidateOrgRuntimeConfigMemo(orgId)
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://moved.example",
				]),
			)

			const second = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(second).url).toBe("https://cached.example")
		}).pipe(Effect.provide(buildCachedLayer(testDb)))
	})

	it.effect("a settings write busts the SHARED entry, not just the writing isolate's memo", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_edge_invalidate"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			expect(
				Option.isSome(yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))),
			).toBe(true)

			yield* OrgClickHouseSettingsService.delete(asOrgId(orgId), [asRole("org:admin")])

			// Drop the memo the write just cleared anyway, so this resolve can only
			// be answered by the shared tier or Postgres. If the write had evicted
			// the memo alone, the stale `Some` would come straight back here — and
			// every other isolate would serve it for the full 6h TTL.
			invalidateOrgRuntimeConfigMemo(orgId)

			const after = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(Option.isNone(after)).toBe(true)
		}).pipe(Effect.provide(buildCachedLayer(testDb)))
	})

	// The memory backend stores the encoded value BY REFERENCE, so it cannot
	// catch a value that survives `Schema.encode` but not the wire. The real
	// Workers backend round-trips through `JSON.stringify` / `response.json()`
	// and returns `undefined` — never `null` — for a miss
	// (`makeWorkersBackend` in `platform/CacheBackendLive.ts`). This backend
	// reproduces exactly that, which is what actually exercises the envelope.
	const makeJsonRoundTripBackend = () => {
		const store = new Map<string, string>()
		const stats = { puts: 0, hits: 0, misses: 0 }
		const backend: EdgeCacheBackend = {
			name: "memory",
			get: async (bucket, hash) => {
				const raw = store.get(`${bucket}/${hash}`)
				if (raw === undefined) {
					stats.misses += 1
					return undefined
				}
				stats.hits += 1
				return JSON.parse(raw) as unknown
			},
			put: async (bucket, hash, value) => {
				stats.puts += 1
				store.set(`${bucket}/${hash}`, JSON.stringify(value))
			},
			delete: async (bucket, hash) => {
				store.delete(`${bucket}/${hash}`)
			},
		}
		return { backend, stats }
	}

	it.effect("survives the JSON wire format the Workers cache actually uses", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const managedOrg = "org_ch_wire_managed"
		const byoOrg = "org_ch_wire_byo"
		const { backend, stats } = makeJsonRoundTripBackend()
		const layer = (() => {
			const envLive = Env.layer.pipe(Layer.provide(configLive))
			const edgeCacheLive = Layer.succeed(EdgeCacheService)(makeEdgeCacheService(backend))
			return OrgClickHouseSettingsService.layer.pipe(
				Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
			)
		})()
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedPasswordRow(testDb, byoOrg, "https://wire.example"))

			// Populate both shapes: the `null` envelope and a fully-populated one
			// carrying the encrypted password material.
			expect(
				Option.isNone(yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(managedOrg))),
			).toBe(true)
			expect(
				expectSome(yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(byoOrg))).url,
			).toBe("https://wire.example")
			expect(stats.puts).toBe(2)

			// Cold isolates. Move Postgres so a fallthrough would be visible.
			invalidateOrgRuntimeConfigMemo(managedOrg)
			invalidateOrgRuntimeConfigMemo(byoOrg)
			yield* Effect.promise(() => seedRow(testDb, managedOrg, "https://appeared.example"))
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					byoOrg,
					"https://moved.example",
				]),
			)

			const managed = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(managedOrg))
			expect(Option.isNone(managed)).toBe(true)

			// Decodes back to the same config, password included — proof the
			// encrypted material survived the round trip and still decrypts.
			const byo = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(byoOrg))
			expect(expectSome(byo).url).toBe("https://wire.example")
			expect(expectSome(byo).password).toBe("legacy-password")

			// Both reads were served by the cache; nothing was recomputed.
			expect(stats.puts).toBe(2)
			expect(stats.hits).toBe(2)
		}).pipe(Effect.provide(layer))
	})

	// The memo's soft TTL (5min) and hard ceiling (6h), mirrored from the
	// service. Tests drive TestClock across them rather than reaching into the
	// module's private state.
	const SOFT_TTL_MS = 300_000
	const HARD_TTL_MS = 21_600_000

	// Tests below use a raw UPDATE as an instrument for observing MEMO mechanics
	// (did the caller block? did the forked refresh land?) — it bypasses the
	// service, so it never busts the memo, which is what keeps the memo the thing
	// under test.

	/**
	 * Resolve until the forked background refresh has landed.
	 *
	 * A single `TestClock.adjust(1)` is NOT enough. The refresh completes when
	 * real promises settle — a PGlite read, plus a durable-tier read whose key
	 * hashing goes through `crypto.subtle` — and none of that is driven by the
	 * test clock. Asserting on one tick passed locally and failed in CI, where
	 * the machine is slower and contended.
	 *
	 * Polling keeps the contract honest: callers assert the STALE value first
	 * (proving nobody blocked), then use this to assert the refresh eventually
	 * lands. Bounded, so a refresh that never lands still fails the test.
	 */
	const resolveUntilUrl = Effect.fnUntraced(function* (orgId: string, expected: string) {
		let last: string | undefined
		for (let attempt = 0; attempt < 200; attempt++) {
			const resolved = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			last = Option.isSome(resolved) ? resolved.value.url : undefined
			if (last === expected) return last
			yield* TestClock.adjust(1)
			yield* Effect.yieldNow
		}
		return last
	})

	it.effect("past the soft TTL, serves the stale value and refreshes behind the request", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_swr_stale"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			const first = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(first).url).toBe("https://a.example")

			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			// Past the soft TTL but inside the hard ceiling: the caller must NOT
			// wait on Postgres, so it still sees the old URL.
			yield* TestClock.adjust(SOFT_TTL_MS + 1_000)
			const stale = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(stale).url).toBe("https://a.example")

			// The refresh forked by that call lands, so a subsequent resolve sees the
			// new value without anyone having blocked on the read.
			expect(yield* resolveUntilUrl(orgId, "https://b.example")).toBe("https://b.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("past the hard ceiling, blocks and reads fresh", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_swr_hard"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))

			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			// Nothing refreshed the entry in the meantime (an isolate whose requests
			// all ended before their refresh landed), so the ceiling forces a
			// blocking read rather than serving an unboundedly old value.
			yield* TestClock.adjust(HARD_TTL_MS + 1_000)
			const fresh = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(fresh).url).toBe("https://b.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	// The ceiling is an isolate-lifetime backstop, not a staleness bound. It used
	// to be 15min, which made a bursty workload (idle isolate, then a widget
	// fan-out) block on Postgres at the head of every burst. At 20min — well past
	// the old ceiling — the caller must still be served from the memo.
	it.effect("an idle stretch past the old 15min ceiling still serves without blocking", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_swr_ceiling_raised"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))

			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			yield* TestClock.adjust(1_200_000)
			const stale = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			// The old URL proves nobody blocked on the read; the refresh this call
			// forked lands next, so the burst behind it is already current.
			expect(expectSome(stale).url).toBe("https://a.example")

			expect(yield* resolveUntilUrl(orgId, "https://b.example")).toBe("https://b.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	// This group uses a miss-only shared backend to exercise the memo in
	// isolation, so a memo bust must force a Postgres read.
	it.effect("a memo bust reads through when the shared tier misses", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_memo_module_bust"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			const before = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(before).url).toBe("https://a.example")

			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			invalidateOrgRuntimeConfigMemo(orgId)
			const afterBust = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(afterBust).url).toBe("https://b.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	// A cold isolate whose shared lookup misses must read Postgres.
	it.effect("a cold isolate reads Postgres after a shared-cache miss", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_cold_isolate"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))

			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://b.example",
				]),
			)

			// What a fresh isolate looks like: no in-process state at all.
			invalidateOrgRuntimeConfigMemo(orgId)

			const resolved = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(expectSome(resolved).url).toBe("https://b.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	// Asserts the observable contract — none of the concurrent callers block, and
	// the in-flight marker is released so the entry can refresh again. It does
	// NOT count Postgres reads: the dedup marker is module-private, and a broken
	// marker would fork N refreshes that all write the same value, which no
	// assertion on the returned config can distinguish.
	it.effect("concurrent stale reads all serve stale, and the refresh marker clears", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_swr_dedup"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://a.example"))
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			yield* TestClock.adjust(SOFT_TTL_MS + 1_000)

			// Eight widgets hitting a stale entry at once must not become eight
			// Postgres reads — the whole point of the in-flight marker.
			const results = yield* Effect.forEach(
				Array.from({ length: 8 }, (_, index) => index),
				() => OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId)),
				{ concurrency: "unbounded" },
			)
			for (const result of results) {
				expect(expectSome(result).url).toBe("https://a.example")
			}

			// The marker must be cleared once the refresh completes, or the entry
			// would never refresh again until it aged past the hard ceiling.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_clickhouse_settings SET ch_url = $2 WHERE org_id = $1", [
					orgId,
					"https://c.example",
				]),
			)

			yield* TestClock.adjust(SOFT_TTL_MS + 1_000)
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId))
			expect(yield* resolveUntilUrl(orgId, "https://c.example")).toBe("https://c.example")
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("invalidateRuntimeConfig reports whether a BYO override was dropped", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const byoOrgId = "org_ch_invalidate_byo"
		const managedOrgId = "org_ch_invalidate_managed"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, byoOrgId, "https://a.example"))
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(byoOrgId))
			// A managed org memoizes `null` — "we know this org has no override".
			yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(managedOrgId))

			// This boolean is the warehouse executor's retry gate: re-running a query
			// can only help when a per-org override was actually dropped.
			const droppedOverride = yield* OrgClickHouseSettingsService.invalidateRuntimeConfig(
				asOrgId(byoOrgId),
			)
			expect(droppedOverride).toBe(true)

			const droppedManaged = yield* OrgClickHouseSettingsService.invalidateRuntimeConfig(
				asOrgId(managedOrgId),
			)
			expect(droppedManaged).toBe(false)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("fails closed for a legacy passworded HTTP runtime row", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_legacy_http"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedPasswordRow(testDb, orgId, "http://clickhouse.example.test"))
			const exit = yield* OrgClickHouseSettingsService.resolveRuntimeConfig(asOrgId(orgId)).pipe(
				Effect.exit,
			)
			const error = getError(exit)
			expect(error).toBeInstanceOf(OrgClickHouseSettingsStoredConfigInvalidError)
			if (!(error instanceof OrgClickHouseSettingsStoredConfigInvalidError)) return
			expect(error.cause).toBeInstanceOf(OrgClickHouseSettingsValidationError)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("fails closed for legacy URL userinfo during collector config generation", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_legacy_userinfo"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedRow(testDb, orgId, "https://user:secret@clickhouse.example.test"))
			const exit = yield* OrgClickHouseSettingsService.collectorConfig(asOrgId(orgId), [
				asRole("org:admin"),
			]).pipe(Effect.exit)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsValidationError)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})

	it.effect("reports corrupt stored collector credentials as an encryption failure", () => {
		const testDb = createTestDb(cacheTrackedDbs)
		const orgId = "org_ch_corrupt_collector_password"
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedPasswordRow(testDb, orgId, "https://clickhouse.example.test"))
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE org_clickhouse_settings SET ch_password_tag = 'corrupt' WHERE org_id = $1",
					[orgId],
				),
			)
			const exit = yield* OrgClickHouseSettingsService.collectorConfig(asOrgId(orgId), [
				asRole("org:admin"),
			]).pipe(Effect.exit)
			expect(getError(exit)).toBeInstanceOf(OrgClickHouseSettingsEncryptionError)
		}).pipe(Effect.provide(buildLayer(testDb)))
	})
})

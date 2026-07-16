import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
	WarehouseQueryError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { unsafeCompiledQuery } from "@maple/query-engine/ch"
import { makeWarehouseExecutor } from "@maple/query-engine/execution"
import { __testables, WarehouseQueryService } from "./WarehouseQueryService"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"
import type { TenantContext } from "../services/AuthService"
import { Env } from "./Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"

const trackedDbs: TestDb[] = []

afterEach(async () => {
	__testables.reset()
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = (extra: Record<string, string> = {}) =>
	ConfigProvider.layer(
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
			...extra,
		}),
	)

const buildLayer = (testDb: TestDb, extra: Record<string, string> = {}) => {
	const configLive = makeConfig(extra)
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	const orgSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive)),
	)
	return WarehouseQueryService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, orgSettingsLive)))
}

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeTenant = (): TenantContext => ({
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "self_hosted",
})

const transient503 = () => new Error("HTTP status 503 service temporarily unavailable")

describe("WarehouseQueryService.sqlQuery retry on transient upstream failures", () => {
	// Runs under it.live: the retry schedule uses real exponential backoff
	// delays, so the default TestClock would stall the retries.
	it.live("recovers after two 503s on the third attempt", () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				if (attempts < 3) throw transient503()
				return { data: [{ ok: 1 }] }
			},
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			)

			assert.strictEqual(attempts, 3)
			assert.deepStrictEqual(result, [{ ok: 1 }])
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not retry non-transient errors (auth)", () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				throw new Error("HTTP status 401 authentication failed")
			},
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) =>
					service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
				),
			)

			assert.strictEqual(attempts, 1)
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.provide(layer))
	})

	// Runs under it.live: exhausts the real backoff schedule before giving up.
	it.live("gives up after the configured retry budget when all attempts fail", () => {
		let attempts = 0
		__testables.setClientFactory(() => ({
			sql: async () => {
				attempts++
				throw transient503()
			},
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) =>
					service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
				),
			)

			// 1 initial + 2 retries
			assert.strictEqual(attempts, 3)
			assert.isTrue(Exit.isFailure(exit))

			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseUpstreamError)
			assert.strictEqual((failure as WarehouseUpstreamError).upstreamStatus, 503)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.compiledQuery", () => {
	const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

	it.effect("executes compiled SQL and decodes rows with the compiled row schema", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [{ serviceName: "api", count: "42" }] }),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly serviceName: string; readonly count: number }>({
			sql: "SELECT ServiceName AS serviceName, count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ serviceName: Schema.String, count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQuery(tenant, compiled),
			)

			assert.deepStrictEqual(result, [{ serviceName: "api", count: 42 }])
		}).pipe(Effect.provide(layer))
	})

	it.effect("maps row decode failures to WarehouseSchemaDriftError", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [{ count: "not-a-number" }] }),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly count: number }>({
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQuery(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseSchemaDriftError)
		}).pipe(Effect.provide(layer))
	})

	it.effect("still enforces OrgId scoping for compiled SQL", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [{ count: 1 }] }),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly count: number }>({
			sql: "SELECT count() AS count FROM traces",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQuery(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.strictEqual(
				(failure as { message?: string } | undefined)?.message,
				"SQL query must contain OrgId filter (sqlQuery)",
			)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.compiledQueryFirst", () => {
	const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

	it.effect("returns Some with the decoded first row", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({
				data: [
					{ serviceName: "api", count: "42" },
					{ serviceName: "worker", count: "9" },
				],
			}),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly serviceName: string; readonly count: number }>({
			sql: "SELECT ServiceName AS serviceName, count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ serviceName: Schema.String, count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQueryFirst(tenant, compiled),
			)

			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) {
				assert.deepStrictEqual(result.value, { serviceName: "api", count: 42 })
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("returns None when the compiled SQL returns no rows", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [] }),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly count: number }>({
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQueryFirst(tenant, compiled),
			)

			assert.deepStrictEqual(result, Option.none())
		}).pipe(Effect.provide(layer))
	})

	it.effect("maps first-row decode failures to WarehouseSchemaDriftError", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [{ count: "not-a-number" }] }),
			insert: async () => {},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = unsafeCompiledQuery<{ readonly count: number }>({
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQueryFirst(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseSchemaDriftError)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.ingest writes through the SQL client", () => {
	it.effect("forwards datasource + rows to the client's insert", () => {
		const calls: Array<{ datasource: string; rows: ReadonlyArray<unknown> }> = []
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [] }),
			insert: async (datasource, rows) => {
				calls.push({ datasource, rows })
			},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const rows = [{ trace_id: "a" }, { trace_id: "b" }]

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) => service.ingest(tenant, "traces", rows))

			assert.strictEqual(calls.length, 1)
			assert.strictEqual(calls[0]?.datasource, "traces")
			assert.deepStrictEqual(calls[0]?.rows, rows)
		}).pipe(Effect.provide(layer))
	})

	it.effect("short-circuits without calling insert when there are no rows", () => {
		let inserts = 0
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [] }),
			insert: async () => {
				inserts++
			},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) => service.ingest(tenant, "traces", []))
			assert.strictEqual(inserts, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("maps a failed insert to WarehouseQueryError", () => {
		__testables.setClientFactory(() => ({
			sql: async () => ({ data: [] }),
			insert: async () => {
				throw new Error("HTTP 400 Bad Request: DB::Exception: Syntax error")
			},
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.ingest(tenant, "traces", [{ trace_id: "a" }])),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseQueryError)
		}).pipe(Effect.provide(layer))
	})
})

describe("createClickHouseSqlClient.insert is disabled (ClickHouse is read-only)", () => {
	// ClickHouse only serves reads for Maple; ingest goes to Tinybird. The CH
	// client's insert must fail loudly so it can never silently 500 against the
	// read-only query gateway ("Only SELECT or DESCRIBE … Got: InsertQuery").
	const chConfig = {
		_tag: "clickhouse" as const,
		url: "https://ch.example.com",
		username: "u",
		password: "p",
		database: "default",
	}

	it("throws — ingest must use Tinybird, never ClickHouse — and issues no request", async () => {
		let fetched = 0
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => {
			fetched++
			return new Response("", { status: 200 })
		}) as typeof fetch

		let thrown: unknown
		try {
			const client = __testables.createClickHouseSqlClient(chConfig)
			await client.insert("traces", [{ trace_id: "a" }])
		} catch (error) {
			thrown = error
		} finally {
			globalThis.fetch = realFetch
		}

		assert.instanceOf(thrown, Error)
		assert.match((thrown as Error).message, /read-only|Tinybird/)
		assert.strictEqual(fetched, 0)
	})
})

describe("createTinybirdSdkSqlClient.insert wire framing (the production insert path)", () => {
	// Inserts in the cloud only need to work on Tinybird. This pins that path so a
	// future change can't silently break ingest into the managed pipeline.
	const tbConfig = { _tag: "tinybird" as const, host: "https://api.tinybird.co", token: "tok_123" }

	it("POSTs raw ndjson rows to the Tinybird Events API (/v0/events?name=<datasource>)", async () => {
		const captured: Array<{
			url: string
			method?: string
			contentType?: string
			auth?: string
			body: string
		}> = []
		const realFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>
			captured.push({
				url: String(input),
				method: init?.method,
				contentType: headers["Content-Type"],
				auth: headers.Authorization,
				body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
			})
			return new Response("", { status: 202 })
		}) as typeof fetch

		try {
			const client = __testables.createTinybirdSdkSqlClient(tbConfig)
			await client.insert("traces", [{ trace_id: "a" }, { trace_id: "b" }])
		} finally {
			globalThis.fetch = realFetch
		}

		assert.strictEqual(captured.length, 1)
		const req = captured[0]!
		assert.strictEqual(req.method, "POST")
		assert.isTrue(req.url.startsWith("https://api.tinybird.co/v0/events?name=traces"))
		assert.strictEqual(req.contentType, "application/x-ndjson")
		assert.strictEqual(req.auth, "Bearer tok_123")
		assert.strictEqual(req.body, '{"trace_id":"a"}\n{"trace_id":"b"}')
		// Tinybird ingests raw rows — never an `INSERT … FORMAT` statement (CH only).
		assert.isFalse(req.body.includes("INSERT INTO"))
	})

	it("no-ops on an empty row set (no request issued)", async () => {
		let calls = 0
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => {
			calls++
			return new Response("", { status: 202 })
		}) as typeof fetch

		try {
			const client = __testables.createTinybirdSdkSqlClient(tbConfig)
			await client.insert("traces", [])
		} finally {
			globalThis.fetch = realFetch
		}

		assert.strictEqual(calls, 0)
	})
})

describe("ingest routes writes to the managed pipeline, not a per-org read override", () => {
	const clickhouseReadOverride = {
		config: {
			_tag: "clickhouse" as const,
			url: "https://byo-clickhouse.example.com",
			username: "u",
			password: "p",
			database: "d",
		},
		source: "org_override" as const,
	}
	const tinybirdManaged = {
		config: { _tag: "tinybird" as const, host: "https://managed.tinybird.co", token: "tok" },
		source: "managed" as const,
	}

	it.effect("ingest uses resolveIngestConfig (Tinybird) while reads use resolveConfig (override)", () => {
		const used: Array<{ op: "sql" | "insert"; tag: string }> = []
		const executor = makeWarehouseExecutor({
			createClient: (config) => ({
				sql: async () => {
					used.push({ op: "sql", tag: config._tag })
					return { data: [] }
				},
				insert: async () => {
					used.push({ op: "insert", tag: config._tag })
				},
			}),
			resolveConfig: () => Effect.succeed(clickhouseReadOverride),
			resolveIngestConfig: () => Effect.succeed(tinybirdManaged),
		})
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* executor.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'")
			yield* executor.ingest(tenant, "traces", [{ trace_id: "a" }])

			assert.deepStrictEqual(used, [
				{ op: "sql", tag: "clickhouse" },
				{ op: "insert", tag: "tinybird" },
			])
		})
	})

	it.effect("falls back to resolveConfig for ingest when resolveIngestConfig is absent", () => {
		const used: Array<{ op: "insert"; tag: string }> = []
		const executor = makeWarehouseExecutor({
			createClient: (config) => ({
				sql: async () => ({ data: [] }),
				insert: async () => {
					used.push({ op: "insert", tag: config._tag })
				},
			}),
			resolveConfig: () => Effect.succeed(tinybirdManaged),
		})
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* executor.ingest(tenant, "traces", [{ trace_id: "a" }])
			assert.deepStrictEqual(used, [{ op: "insert", tag: "tinybird" }])
		})
	})
})

describe("ingest pins writes to Tinybird even when CLICKHOUSE_URL makes managed reads ClickHouse", () => {
	// Reproduces the prod incident: CLICKHOUSE_URL is set, so the managed READ
	// backend is a read-only ClickHouse query gateway. Inserts there are rejected
	// ("Only SELECT or DESCRIBE queries are supported. Got: InsertQuery"). Writes
	// MUST resolve to Tinybird regardless. Routing ingest through the managed
	// resolver (which prefers ClickHouse) is what kept demo-seed onboarding broken.
	it.effect("reads resolve to managed ClickHouse, but ingest resolves to Tinybird", () => {
		const used: Array<{ op: "sql" | "insert"; tag: string }> = []
		__testables.setClientFactory((config) => ({
			sql: async () => {
				used.push({ op: "sql", tag: config._tag })
				return { data: [] }
			},
			insert: async () => {
				used.push({ op: "insert", tag: config._tag })
			},
		}))

		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://readonly-ch.example.com",
			CLICKHOUSE_USER: "reader",
			CLICKHOUSE_DATABASE: "default",
		})
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			)
			yield* WarehouseQueryService.use((service) =>
				service.ingest(tenant, "traces", [{ trace_id: "a" }]),
			)

			assert.deepStrictEqual(used, [
				{ op: "sql", tag: "clickhouse" },
				{ op: "insert", tag: "tinybird" },
			])
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseUpstreamError surfaces transient classification", () => {
	it("carries upstreamStatus on 503", () => {
		// Sanity check that the constructor flow we depend on for retry is intact.
		const err = new WarehouseUpstreamError({
			pipeName: "test",
			message: "upstream",
			upstreamStatus: 503,
		})
		assert.strictEqual(err.upstreamStatus, 503)
	})
})

describe("isEmptyJsonBodyError (empty Tinybird body ⇒ zero rows)", () => {
	// The Tinybird SDK's sql() parses the response body as JSON; a successful (2xx) query that
	// matches zero rows can return an empty body, throwing `SyntaxError: "Unexpected end of JSON
	// input"`. That must be treated as zero rows so alert rules (and every sqlQuery caller) hit the
	// no-data path instead of surfacing a spurious WarehouseClientError.
	it("treats an empty-body SyntaxError as zero rows", () => {
		assert.isTrue(__testables.isEmptyJsonBodyError(new SyntaxError("Unexpected end of JSON input")))
	})

	it("does NOT swallow an HTML-error-page SyntaxError", () => {
		// "Unexpected token < in JSON" means Tinybird returned an HTML error page — a real failure
		// that must keep propagating as a WarehouseClientError, not be silently treated as zero rows.
		assert.isFalse(__testables.isEmptyJsonBodyError(new SyntaxError("Unexpected token < in JSON")))
	})

	it("ignores non-SyntaxError failures", () => {
		assert.isFalse(__testables.isEmptyJsonBodyError(new Error("Unexpected end of JSON input")))
		assert.isFalse(__testables.isEmptyJsonBodyError("Unexpected end of JSON input"))
		assert.isFalse(__testables.isEmptyJsonBodyError(null))
	})
})

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Ref, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain"
import { RawSqlValidationError } from "@maple/domain/http"
import { compile, listRuleChecksQuery, unsafeCompiledQuery } from "../ch"
import { logBodySearchMode, type WarehouseCapabilities } from "../capabilities"
import { makeWarehouseExecutor } from "./executor"
import { WarehouseResponseLimitError } from "./response-limits"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	WarehouseExecutorDeps,
	WarehouseSqlClient,
} from "./ports"

const tenant: ExecutionTenant = {
	orgId: Schema.decodeUnknownSync(OrgId)("org_test"),
	userId: Schema.decodeUnknownSync(UserId)("user_test"),
	authMode: "system",
}

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

// A per-org BYO read override (the read path) vs the managed Tinybird ingest
// pipeline (the write path). alert_checks rows only ever land in the latter.
const clickhouseConfig: ResolvedWarehouseConfig = {
	kind: "clickhouse",
	url: "https://byo.example.com",
	username: "default",
	password: "secret",
	database: "maple",
}
const tinybirdConfig: ResolvedWarehouseConfig = {
	kind: "tinybird",
	host: "https://api.tinybird.co",
	token: "tb_token",
}
const tinybirdGatewayConfig: ResolvedWarehouseConfig = {
	...clickhouseConfig,
	kind: "tinybird-gateway",
}
const chdbConfig: ResolvedWarehouseConfig = {
	...clickhouseConfig,
	kind: "chdb",
}

// listRuleChecksQuery declares .routing("ingest") at its definition —
// alert_checks only exists in the managed ingest pipeline.
const compiled = compile(listRuleChecksQuery({ limit: 1 }), {
	orgId: "org_test",
	ruleId: "rule_test",
})

// The old `sqlQuery(tenant, sql)` entry point took a raw string; scope now
// travels on the compiled query, so these execution/span/retry tests wrap their
// SQL in a compiled value that declares it.
const scoped = (sql: string) =>
	unsafeCompiledQuery<Record<string, unknown>>({
		sql,
		tenantScope: "org",
		reason: "test-fixture",
		note: "Synthetic SQL asserting executor behaviour, not a product query.",
	})

// A plain query with no routing declaration follows the default read route.
const untaggedCompiled = unsafeCompiledQuery<{ readonly c: number }>({
	reason: "test-fixture",
	note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
	sql: "SELECT count() AS c FROM traces WHERE OrgId = 'org_test'\nFORMAT JSON",
	tenantScope: "org",
})

// Records the backend each constructed client was wired to, so a test can assert
// which route the executor resolved through. Models a BYO-CH org: reads and raw
// SQL hit the org's ClickHouse, ingest hits the managed Tinybird pipeline.
const makeDeps = (createdKinds: Array<ResolvedWarehouseConfig["kind"]>): WarehouseExecutorDeps => ({
	createClient: (config) => {
		createdKinds.push(config.kind)
		const client: WarehouseSqlClient = {
			sql: async () => ({ data: [] }),
			insert: async () => {},
		}
		return client
	},
	resolveRoute: (_tenant, purpose) =>
		Effect.succeed(
			purpose === "ingest"
				? { source: "managed" as const, config: tinybirdConfig, clientCacheKey: "write:managed" }
				: {
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: purpose === "raw" ? "raw:org_test" : "read:org_test",
					},
		),
})

describe("makeWarehouseExecutor ingest routing", () => {
	it.effect("reads an untagged compiled query from the per-org (ClickHouse) route", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["kind"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, untaggedCompiled, { context: "test" })
			assert.deepStrictEqual(created, ["clickhouse"])
		}),
	)

	it.effect("routes a .routing('ingest')-tagged compiled query to the ingest (Tinybird) route", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["kind"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			assert.deepStrictEqual(created, ["tinybird"])
		}),
	)

	it.effect("routes hand-written SQL with the route:'ingest' option", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["kind"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, scoped("SELECT 1 WHERE OrgId = 'org_test'"), {
				context: "test",
				route: "ingest",
			})
			assert.deepStrictEqual(created, ["tinybird"])
		}),
	)
})

describe("makeWarehouseExecutor span instrumentation", () => {
	it.effect("emits the canonical SQL attributes on the Client span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const executor = makeWarehouseExecutor(makeDeps([]))

			yield* executor
				.compiledQuery(tenant, scoped("SELECT 1 WHERE OrgId = 'org_test'"), {
					profile: "list",
					context: "spanContract",
				})
				.pipe(Effect.withTracer(tracer))

			const span = spans.find((candidate) => candidate.name === "WarehouseQueryService.executeSql")
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("orgId"), "org_test")
			assert.strictEqual(span.attributes.get("tenant.userId"), "user_test")
			assert.strictEqual(span.attributes.get("tenant.authMode"), "system")
			assert.strictEqual(span.attributes.get("clientSource"), "org_override")
			assert.strictEqual(span.attributes.get("db.client"), "clickhouse")
			assert.strictEqual(span.attributes.get("db.system.name"), "clickhouse")
			assert.strictEqual(span.attributes.get("peer.service"), "clickhouse")
			assert.strictEqual(span.attributes.get("query.context"), "spanContract")
			assert.strictEqual(span.attributes.get("query.profile"), "list")
			assert.strictEqual(span.attributes.get("result.rowCount"), 0)
			assert.isNumber(span.attributes.get("db.duration_ms"))
			assert.match(span.attributes.get("db.query.fingerprint") as string, /^[0-9a-f]{8}$/)
		}),
	)

	it.effect("keeps chDB as the peer while reporting ClickHouse as the DB system", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: chdbConfig, clientCacheKey: "local" }, []),
			)

			yield* executor
				.compiledQuery(tenant, scoped("SELECT 1 WHERE OrgId = 'org_test'"), { context: "localSpan" })
				.pipe(Effect.withTracer(tracer))

			const span = spans.find((candidate) => candidate.name === "WarehouseQueryService.executeSql")
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.system.name"), "clickhouse")
			assert.strictEqual(span.attributes.get("peer.service"), "chdb")
		}),
	)

	it.effect("wraps warehouse inserts in an attributed Client span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const executor = makeWarehouseExecutor(makeDeps([]))

			yield* executor
				.ingest(tenant, "alert_checks", [{ OrgId: "org_test" }])
				.pipe(Effect.withTracer(tracer))

			const span = spans.find((candidate) => candidate.name === "WarehouseQueryService.insert")
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("db.system.name"), "tinybird")
			assert.strictEqual(span.attributes.get("peer.service"), "tinybird")
			assert.strictEqual(span.attributes.get("db.client"), "tinybird-sdk")
			assert.strictEqual(span.attributes.get("result.rowCount"), 1)
		}),
	)

	it.effect("wraps capability metadata probes in an attributed Client span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:org_test" }, []),
			)

			yield* executor
				.compiledQuery(
					tenant,
					() =>
						unsafeCompiledQuery<{ readonly c: number }>({
							reason: "test-fixture",
							note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
							sql: "SELECT count() AS c FROM logs WHERE OrgId = 'org_test' FORMAT JSON",
							tenantScope: "org",
						}),
					{ context: "capabilitySpan" },
				)
				.pipe(Effect.withTracer(tracer))

			const span = spans.find(
				(candidate) => candidate.name === "WarehouseQueryService.inspectCapabilities",
			)
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("orgId"), "org_test")
			assert.strictEqual(span.attributes.get("warehouse.backend"), "clickhouse")
			assert.strictEqual(span.attributes.get("warehouse.route"), "read")
			assert.strictEqual(span.attributes.get("maple.query.capabilities.cache"), "miss")
		}),
	)

	it.live("reports retries performed rather than failed attempts on terminal failure", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			let attempts = 0
			const executor = makeWarehouseExecutor({
				...makeDeps([]),
				createClient: () => ({
					sql: async () => {
						attempts += 1
						throw new Error("HTTP status 503 service temporarily unavailable")
					},
					insert: async () => {},
				}),
			})

			const exit = yield* executor
				.compiledQuery(tenant, scoped("SELECT 1 WHERE OrgId = 'org_test'"), { context: "retrySpan" })
				.pipe(Effect.withTracer(tracer), Effect.exit)

			assert.strictEqual(exit._tag, "Failure")
			assert.strictEqual(attempts, 3)
			const span = spans.find((candidate) => candidate.name === "WarehouseQueryService.executeSql")
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.retry.attempts"), 2)
		}),
	)
})

// Capture the final SQL the executor hands to the client so a test can assert
// whether a Tinybird-restricted setting (max_block_size) survived the strip for
// the resolved backend. The Tinybird gateway (`tinybird-gateway`) uses the
// ClickHouse protocol but still enforces Tinybird's restricted-settings policy.
const makeRecordingDeps = (
	resolved: { config: ResolvedWarehouseConfig; clientCacheKey: string },
	sqls: Array<string>,
): WarehouseExecutorDeps => ({
	createClient: () => ({
		sql: async (sql: string) => {
			sqls.push(sql)
			return { data: [] }
		},
		insert: async () => {},
	}),
	resolveRoute: (_tenant, purpose) =>
		Effect.succeed({
			source: "managed" as const,
			config: resolved.config,
			clientCacheKey: purpose === "raw" ? "raw:org_test" : resolved.clientCacheKey,
		}),
})

describe("makeWarehouseExecutor compiled-query defaults", () => {
	it.effect("defaults the profile to 'aggregation' when none is passed", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:org_test" }, sqls),
			)
			yield* executor.compiledQuery(tenant, untaggedCompiled, { context: "test" })
			// aggregation = { maxExecutionTime: 30, maxMemoryUsage: 4GB }; previously a
			// profile-less call emitted no SETTINGS clause at all.
			assert.isTrue(sqls[0]?.includes("max_execution_time=30"))
			assert.isTrue(sqls[0]?.includes("max_memory_usage=4000000000"))
		}),
	)

	it.effect("an explicit profile still wins over the default", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:org_test" }, sqls),
			)
			yield* executor.compiledQuery(tenant, untaggedCompiled, { context: "test", profile: "list" })
			assert.isTrue(sqls[0]?.includes("max_execution_time=15"))
			assert.isFalse(sqls[0]?.includes("max_execution_time=30"))
		}),
	)

	it.effect("reports the caller's context as pipeName when row decode fails", () =>
		Effect.gen(function* () {
			const badRowDeps: WarehouseExecutorDeps = {
				createClient: () => ({
					sql: async () => ({ data: [{ c: "not-a-number" }] }),
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "managed" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			}
			const withSchema = unsafeCompiledQuery<{ readonly c: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				sql: "SELECT count() AS c FROM traces WHERE OrgId = 'org_test'\nFORMAT JSON",
				tenantScope: "org",
				rowSchema: Schema.Struct({ c: Schema.Number }),
			})
			const executor = makeWarehouseExecutor(badRowDeps)
			const error = yield* executor
				.compiledQuery(tenant, withSchema, { context: "serviceOverview" })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/WarehouseSchemaDriftError")
			// The real query identity, not the old constant "compiledQuery".
			assert.strictEqual(error.pipeName, "serviceOverview")
		}),
	)
})

describe("makeWarehouseExecutor restricted-settings strip", () => {
	it.effect("strips max_block_size for the managed Tinybird CH-gateway", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdGatewayConfig, clientCacheKey: "read:managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.lengthOf(sqls, 1)
			assert.isFalse(sqls[0]?.includes("max_block_size"))
		}),
	)

	it.effect("keeps max_block_size for env-level vanilla ClickHouse", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.isTrue(sqls[0]?.includes("max_block_size=512"))
		}),
	)

	it.effect("strips max_block_size for the managed Tinybird SDK backend", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdConfig, clientCacheKey: "read:managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.isFalse(sqls[0]?.includes("max_block_size"))
		}),
	)

	it.effect("keeps max_block_size for a genuine BYO ClickHouse", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:org_test" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.isTrue(sqls[0]?.includes("max_block_size=512"))
		}),
	)
})

describe("makeWarehouseExecutor capability-aware compilation", () => {
	it.effect("selects a live-index plan, enables the verified setting, and caches metadata", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			let metadataQueries = 0
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: async (sql) => {
						sqls.push(sql)
						if (sql.includes("SELECT version()")) {
							metadataQueries += 1
							return { data: [{ version: "26.2.1" }] }
						}
						if (sql.includes("system.data_skipping_indices")) {
							return {
								data: [
									{
										table: "logs",
										name: "idx_lower_body_text",
										type: "text",
										expression: "lower(Body)",
									},
								],
							}
						}
						if (sql.includes("system.settings")) {
							return { data: [{ name: "enable_full_text_index", value: "0" }] }
						}
						if (sql.includes("system.")) return { data: [] }
						return { data: [] }
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			})

			const factory = (capabilities: WarehouseCapabilities) =>
				unsafeCompiledQuery<{ readonly c: number }>({
					reason: "test-fixture",
					note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
					sql: `SELECT count() AS c FROM logs WHERE OrgId = 'org_test' AND '${logBodySearchMode(capabilities)}' = 'text' FORMAT JSON`,
					tenantScope: "org",
				})

			yield* executor.compiledQuery(tenant, factory, { context: "capability-test" })
			yield* executor.compiledQuery(tenant, factory, { context: "capability-test" })

			assert.strictEqual(metadataQueries, 1)
			const executed = sqls.filter((sql) => sql.includes("FROM logs WHERE"))
			assert.lengthOf(executed, 2)
			assert.isTrue(executed.every((sql) => sql.includes("'text' = 'text'")))
			assert.isTrue(executed.every((sql) => sql.includes("enable_full_text_index=1")))
		}),
	)

	it.effect("keeps concurrent cold capability probes request-local", () =>
		Effect.gen(function* () {
			let versionQueries = 0
			let releaseVersionQuery: (() => void) | undefined
			let signalVersionQueryStarted: (() => void) | undefined
			const versionQueryStarted = new Promise<void>((resolve) => {
				signalVersionQueryStarted = resolve
			})
			const versionQueryGate = new Promise<void>((resolve) => {
				releaseVersionQuery = resolve
			})
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: async (sql) => {
						if (sql.includes("SELECT version()")) {
							versionQueries += 1
							signalVersionQueryStarted?.()
							await versionQueryGate
							return { data: [{ version: "26.2.1" }] }
						}
						if (sql.includes("system.settings")) {
							return { data: [{ name: "enable_full_text_index", value: "0" }] }
						}
						return { data: [] }
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			})
			const query = () =>
				executor.compiledQueryWithCapabilities(
					tenant,
					() =>
						unsafeCompiledQuery<{ readonly c: number }>({
							reason: "test-fixture",
							note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
							sql: "SELECT count() AS c FROM logs WHERE OrgId = 'org_test' FORMAT JSON",
							tenantScope: "org",
						}),
					{ context: "capability-request-local" },
				)

			const leader = yield* Effect.forkChild(query())
			yield* Effect.promise(() => versionQueryStarted)
			const follower = yield* Effect.forkChild(query())
			// Wait for the follower to actually reach its own probe rather than
			// assuming a fixed delay is long enough for it to get scheduled. The
			// leader is parked on `versionQueryGate`, so a second probe can only
			// appear if the follower genuinely issued one — which is what this test
			// asserts. Under a loaded runner a fixed 10ms window expired before the
			// follower ran, the gate released, and the leader's now-cached
			// capabilities made the follower skip its probe: a failure that meant
			// "CI was busy", not "requests coalesced". Bounded, so a regression that
			// really does coalesce them still fails the assertion below rather than
			// hanging here.
			yield* Effect.promise(
				() =>
					new Promise<void>((resolve) => {
						const deadlineAt = Date.now() + 5_000
						const poll = () => {
							if (versionQueries >= 2 || Date.now() >= deadlineAt) resolve()
							else globalThis.setTimeout(poll, 5)
						}
						poll()
					}),
			)
			releaseVersionQuery?.()
			yield* Fiber.join(leader)
			yield* Fiber.join(follower)

			assert.strictEqual(versionQueries, 2)
		}),
	)

	it.effect("falls back to the conservative plan when metadata access is denied", () =>
		Effect.gen(function* () {
			const executed: string[] = []
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: async (sql) => {
						if (sql.includes("system.") || sql.includes("SELECT version()")) {
							throw new Error("ACCESS_DENIED")
						}
						executed.push(sql)
						return { data: [] }
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			})

			yield* executor.compiledQuery(
				tenant,
				(capabilities) =>
					unsafeCompiledQuery<{ readonly c: number }>({
						reason: "test-fixture",
						note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: `SELECT count() AS c FROM logs WHERE OrgId = 'org_test' AND '${logBodySearchMode(capabilities)}' = 'scan' FORMAT JSON`,
						tenantScope: "org",
					}),
				{ context: "capability-fallback-test" },
			)

			assert.lengthOf(executed, 1)
			assert.include(executed[0]!, "'scan' = 'scan'")
			assert.notInclude(executed[0]!, "enable_full_text_index")
		}),
	)

	it.effect("does not select text indexes when the Tinybird gateway rejects setting overrides", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: async (sql) => {
						sqls.push(sql)
						if (sql.includes("SELECT version()")) return { data: [{ version: "26.2.1" }] }
						if (sql.includes("system.data_skipping_indices")) {
							return {
								data: [
									{
										table: "logs",
										name: "idx_lower_body_text",
										type: "text",
										expression: "lower(Body)",
									},
								],
							}
						}
						if (sql.includes("system.settings")) {
							return { data: [{ name: "enable_full_text_index", value: "0" }] }
						}
						return { data: [] }
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "managed" as const,
						config: tinybirdGatewayConfig,
						clientCacheKey: "read:managed",
					}),
			})

			yield* executor.compiledQuery(
				tenant,
				(capabilities) =>
					unsafeCompiledQuery<{ readonly c: number }>({
						reason: "test-fixture",
						note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: `SELECT count() AS c FROM logs WHERE OrgId = 'org_test' AND '${logBodySearchMode(capabilities)}' = 'scan' FORMAT JSON`,
						tenantScope: "org",
					}),
				{ context: "tinybird-gateway-capabilities" },
			)

			const executed = sqls.find((sql) => sql.includes("FROM logs WHERE"))
			assert.isDefined(executed)
			assert.include(executed!, "'scan' = 'scan'")
			assert.notInclude(executed!, "enable_full_text_index")
		}),
	)

	it.effect("bounds hung metadata inspection and continues with the conservative plan", () =>
		Effect.gen(function* () {
			const executed: string[] = []
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: (sql) => {
						if (sql.includes("SELECT version()") || sql.includes("system.")) {
							return new Promise<{ data: never[] }>(() => {})
						}
						executed.push(sql)
						return Promise.resolve({ data: [] })
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			})
			const outcome = yield* Ref.make("pending")

			yield* Effect.forkChild(
				executor
					.compiledQuery(
						tenant,
						(capabilities) =>
							unsafeCompiledQuery<{ readonly c: number }>({
								reason: "test-fixture",
								note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
								sql: `SELECT count() AS c FROM logs WHERE OrgId = 'org_test' AND '${logBodySearchMode(capabilities)}' = 'scan' FORMAT JSON`,
								tenantScope: "org",
							}),
						{ context: "hung-capability-probe" },
					)
					.pipe(
						Effect.matchEffect({
							onFailure: () => Ref.set(outcome, "failure"),
							onSuccess: () => Ref.set(outcome, "success"),
						}),
					),
			)

			yield* TestClock.adjust(Duration.seconds(3))
			assert.strictEqual(yield* Ref.get(outcome), "success")
			assert.lengthOf(executed, 1)
			assert.include(executed[0]!, "'scan' = 'scan'")
		}),
	)

	it.effect("optimizes named log-list queries after probing the routed warehouse", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const executor = makeWarehouseExecutor({
				createClient: () => ({
					sql: async (sql) => {
						sqls.push(sql)
						if (sql.includes("SELECT version()")) return { data: [{ version: "26.2.1" }] }
						if (sql.includes("system.data_skipping_indices")) {
							return {
								data: [
									{
										table: "logs",
										name: "idx_lower_body_text",
										type: "text",
										expression: "lower(Body)",
									},
								],
							}
						}
						if (sql.includes("system.settings")) {
							return { data: [{ name: "enable_full_text_index", value: "0" }] }
						}
						return { data: [] }
					},
					insert: async () => {},
				}),
				resolveRoute: () =>
					Effect.succeed({
						source: "org-byo" as const,
						config: clickhouseConfig,
						clientCacheKey: "read:org_test",
					}),
			})

			yield* executor.query(tenant, {
				pipeName: "list_logs",
				params: {
					start_time: "2026-01-01 00:00:00",
					end_time: "2026-01-02 00:00:00",
					search: "Connection Timeout",
					limit: 10,
				},
			})

			const executed = sqls.find((sql) => sql.includes("FROM logs") && sql.includes("hasAllTokens"))
			assert.isDefined(executed)
			assert.include(executed!, "Body ILIKE '%Connection Timeout%'")
			assert.include(executed!, "enable_full_text_index=1")
		}),
	)
})

// The compiled DSL always ends in `FORMAT JSON`; the official ClickHouse client
// rejects a trailing FORMAT/`;` (it sets the format itself) while Tinybird's
// /v0/sql requires it. Normalization follows the wire protocol (the dialect's
// normalizeSqlForClient) — the Tinybird CH-gateway speaks the ClickHouse protocol.
describe("makeWarehouseExecutor SQL normalization", () => {
	it.effect("strips the trailing FORMAT JSON for a ClickHouse-protocol backend", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, clientCacheKey: "read:org_test" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			assert.isTrue(compiled.sql.trimEnd().endsWith("FORMAT JSON"))
			assert.isFalse(sqls[0]?.includes("FORMAT JSON"))
		}),
	)

	it.effect("strips the trailing FORMAT JSON for the Tinybird CH-gateway", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdGatewayConfig, clientCacheKey: "read:managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			assert.isFalse(sqls[0]?.includes("FORMAT JSON"))
		}),
	)

	it.effect("keeps the trailing FORMAT JSON for the Tinybird SDK backend", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdConfig, clientCacheKey: "read:managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			assert.isTrue(sqls[0]?.trimEnd().endsWith("FORMAT JSON"))
		}),
	)
})

describe("makeWarehouseExecutor raw response limits", () => {
	it.effect("maps a driver byte abort directly to RawSqlValidationError", () =>
		Effect.gen(function* () {
			const executor = makeWarehouseExecutor({
				...makeDeps([]),
				createClient: () => ({
					sql: async () => {
						throw new WarehouseResponseLimitError({
							kind: "bytes",
							message: "raw response too large",
						})
					},
					insert: async () => {},
				}),
			})
			const error = yield* Effect.flip(
				executor.rawSqlQuery(tenant, "SELECT 1 WHERE OrgId = 'org_test'"),
			)
			assert.instanceOf(error, RawSqlValidationError)
			assert.strictEqual(error.code, "ResourceLimit")
		}),
	)

	it.effect("propagates the limit error unchanged for a trusted bounded query", () =>
		Effect.gen(function* () {
			// A trusted query's oversized response is OUR budget being exceeded, not
			// the caller writing bad SQL — so it must not be restated as a
			// validation error the way the raw path does above.
			const executor = makeWarehouseExecutor({
				...makeDeps([]),
				createClient: () => ({
					sql: async () => {
						throw new WarehouseResponseLimitError({
							kind: "bytes",
							message: "response too large",
						})
					},
					insert: async () => {},
				}),
			})
			const error = yield* Effect.flip(
				executor.compiledQueryBounded(tenant, compiled, {
					context: "test",
					responseLimits: { maxRows: 40, maxBytes: 8_000_000 },
				}),
			)
			assert.instanceOf(error, WarehouseResponseLimitError)
		}),
	)

	it.effect("runs an oversized bounded read exactly once instead of retrying it", () =>
		Effect.gen(function* () {
			// The regression this whole change exists for: an over-budget response
			// used to surface as an aborted subrequest, which the transient
			// classifier read as a flaky upstream and retried — re-running a read
			// that had already exhausted the heap, twice more, before 503ing.
			let attempts = 0
			const executor = makeWarehouseExecutor({
				...makeDeps([]),
				createClient: () => ({
					sql: async () => {
						attempts++
						throw new WarehouseResponseLimitError({
							kind: "bytes",
							message: "response too large",
						})
					},
					insert: async () => {},
				}),
			})
			yield* Effect.flip(
				executor.compiledQueryBounded(tenant, compiled, {
					context: "test",
					responseLimits: { maxRows: 40, maxBytes: 8_000_000 },
				}),
			)
			assert.strictEqual(attempts, 1)
		}),
	)

	it.effect("forwards the caller's budget to the driver", () =>
		Effect.gen(function* () {
			let seen: unknown
			const executor = makeWarehouseExecutor({
				...makeDeps([]),
				createClient: () => ({
					sql: async (_sql: string, options?: unknown) => {
						seen = options
						return { data: [] }
					},
					insert: async () => {},
				}),
			})
			yield* executor.compiledQueryBounded(tenant, compiled, {
				context: "test",
				responseLimits: { maxRows: 40, maxBytes: 8_000_000 },
			})
			assert.deepStrictEqual(seen, {
				responseLimits: { maxRows: 40, maxBytes: 8_000_000 },
			})
		}),
	)
})

describe("makeWarehouseExecutor client cache partitions", () => {
	it.effect("keeps standard reads, raw org reads, and managed writes in stable separate entries", () =>
		Effect.gen(function* () {
			let nextClientId = 0
			const calls: Array<{ readonly clientId: number; readonly operation: "sql" | "insert" }> = []
			const executor = makeWarehouseExecutor({
				createClient: () => {
					const clientId = ++nextClientId
					return {
						sql: async () => {
							calls.push({ clientId, operation: "sql" })
							return { data: [] }
						},
						insert: async () => {
							calls.push({ clientId, operation: "insert" })
						},
					}
				},
				resolveRoute: (_tenant, purpose) =>
					Effect.succeed({
						source: "managed" as const,
						config: tinybirdConfig,
						clientCacheKey:
							purpose === "ingest"
								? "write:managed"
								: purpose === "raw"
									? "raw:org_test"
									: "read:managed",
					}),
			})

			yield* executor.compiledQuery(tenant, scoped("SELECT 1 WHERE OrgId = 'org_test'"))
			yield* executor.rawSqlQuery(tenant, "SELECT 1 WHERE OrgId = 'org_test'")
			yield* executor.ingest(tenant, "traces", [{ TraceId: "trace" }])
			yield* executor.compiledQuery(tenant, scoped("SELECT 2 WHERE OrgId = 'org_test'"))

			assert.strictEqual(nextClientId, 3)
			assert.deepStrictEqual(calls, [
				{ clientId: 1, operation: "sql" },
				{ clientId: 2, operation: "sql" },
				{ clientId: 3, operation: "insert" },
				{ clientId: 1, operation: "sql" },
			])
		}),
	)
})

// A client whose query never resolves — models a Tinybird request stuck in the
// execution queue (the failure mode behind the 03:00–05:00 timeout storm, where
// queries rode the ambient ~30s Worker fetch limit despite a server-side budget).
const makeHangingDeps = (): WarehouseExecutorDeps => ({
	createClient: () => ({
		sql: () => new Promise<{ data: never[] }>(() => {}),
		insert: async () => {},
	}),
	resolveRoute: () =>
		Effect.succeed({
			source: "managed" as const,
			config: tinybirdConfig,
			clientCacheKey: "read:managed",
		}),
})

// Like makeHangingDeps, but counts how many times the client's `sql` is invoked
// so a test can prove the client-timeout is NON-transient — i.e. the query is
// attempted exactly once and the timeout is not fed back into the retry loop.
const makeCountingHangingDeps = (counter: { count: number }): WarehouseExecutorDeps => ({
	createClient: () => ({
		sql: () => {
			counter.count += 1
			return new Promise<{ data: never[] }>(() => {})
		},
		insert: async () => {},
	}),
	resolveRoute: () =>
		Effect.succeed({
			source: "managed" as const,
			config: tinybirdConfig,
			clientCacheKey: "read:managed",
		}),
})

describe("makeWarehouseExecutor client timeout", () => {
	it.effect("bounds a hung managed query at the profile budget and fails non-transiently", () =>
		Effect.gen(function* () {
			const executor = makeWarehouseExecutor(makeHangingDeps())
			const outcome = yield* Ref.make("pending")
			// discovery profile ⇒ 5s server budget + 5s buffer = 10s client budget.
			yield* Effect.forkChild(
				executor.compiledQuery(tenant, compiled, { profile: "discovery", context: "test" }).pipe(
					Effect.matchEffect({
						onFailure: (error) => Ref.set(outcome, error._tag),
						onSuccess: () => Ref.set(outcome, "success"),
					}),
				),
			)
			// Before the budget: still pending (not cut off early).
			yield* TestClock.adjust(Duration.seconds(9))
			assert.strictEqual(yield* Ref.get(outcome), "pending")
			// Past the budget: the timeout fires as a non-transient WarehouseQueryError
			// (so it is NOT fed back into the retry loop).
			yield* TestClock.adjust(Duration.seconds(2))
			assert.strictEqual(yield* Ref.get(outcome), "@maple/http/errors/WarehouseQueryError")
		}),
	)

	it.effect("attempts a timed-out query exactly once — the timeout is not retried", () =>
		Effect.gen(function* () {
			const counter = { count: 0 }
			const executor = makeWarehouseExecutor(makeCountingHangingDeps(counter))
			const outcome = yield* Ref.make("pending")
			yield* Effect.forkChild(
				executor.compiledQuery(tenant, compiled, { profile: "discovery", context: "test" }).pipe(
					Effect.matchEffect({
						onFailure: (error) => Ref.set(outcome, error._tag),
						onSuccess: () => Ref.set(outcome, "success"),
					}),
				),
			)
			// Advance past the 10s discovery budget AND past the transient-retry backoff
			// window (100ms → 200ms). A transient error would drive a second `sql` call;
			// the non-transient timeout must not — so exactly one attempt is made.
			yield* TestClock.adjust(Duration.seconds(11))
			assert.strictEqual(yield* Ref.get(outcome), "@maple/http/errors/WarehouseQueryError")
			assert.strictEqual(counter.count, 1)
		}),
	)

	it.effect("does NOT client-timeout an explicitly unbounded query", () =>
		Effect.gen(function* () {
			const executor = makeWarehouseExecutor(makeHangingDeps())
			const outcome = yield* Ref.make("pending")
			yield* Effect.forkChild(
				executor.compiledQuery(tenant, compiled, { profile: "unbounded", context: "test" }).pipe(
					Effect.matchEffect({
						onFailure: (error) => Ref.set(outcome, error._tag),
						onSuccess: () => Ref.set(outcome, "success"),
					}),
				),
			)
			// Well past the 30s hard cap: `unbounded` opts out of the client timeout,
			// so the query is never cut off (it only rides the ambient Worker limit).
			yield* TestClock.adjust(Duration.seconds(60))
			assert.strictEqual(yield* Ref.get(outcome), "pending")
		}),
	)
})

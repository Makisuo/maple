import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import type { OrgId } from "@maple/domain"
import { compile, listRuleChecksQuery } from "../ch"
import { makeWarehouseExecutor } from "./executor"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	WarehouseExecutorDeps,
	WarehouseSqlClient,
} from "./ports"

const tenant: ExecutionTenant = {
	orgId: "org_test" as OrgId,
	userId: "user_test",
	authMode: "system",
}

// A per-org BYO read override (the read path) vs the managed Tinybird ingest
// pipeline (the write path). alert_checks rows only ever land in the latter.
const clickhouseConfig: ResolvedWarehouseConfig = {
	_tag: "clickhouse",
	url: "https://byo.example.com",
	username: "default",
	password: "secret",
	database: "maple",
}
const tinybirdConfig: ResolvedWarehouseConfig = {
	_tag: "tinybird",
	host: "https://api.tinybird.co",
	token: "tb_token",
}

const compiled = compile(listRuleChecksQuery({ limit: 1 }), {
	orgId: "org_test",
	ruleId: "rule_test",
})

// Records the backend each constructed client was wired to, so a test can assert
// which config the executor resolved through.
const makeDeps = (createdTags: Array<ResolvedWarehouseConfig["_tag"]>): WarehouseExecutorDeps => ({
	createClient: (config) => {
		createdTags.push(config._tag)
		const client: WarehouseSqlClient = {
			sql: async () => ({ data: [] }),
			insert: async () => {},
		}
		return client
	},
	resolveConfig: () => Effect.succeed({ config: clickhouseConfig, source: "org_override" as const }),
	resolveIngestConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
})

describe("makeWarehouseExecutor pinToIngestConfig", () => {
	it.effect("reads from the per-org (ClickHouse) config by default", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["_tag"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			assert.deepStrictEqual(created, ["clickhouse"])
		}),
	)

	it.effect("reads from the ingest (Tinybird) config when pinToIngestConfig is set", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["_tag"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				pinToIngestConfig: true,
			})
			assert.deepStrictEqual(created, ["tinybird"])
		}),
	)
})

// Capture the final SQL the executor hands to the client so a test can assert
// whether a Tinybird-restricted setting (max_block_size) survived the strip for
// the resolved backend. The strip keys on the config `source`, not its `_tag`:
// the managed warehouse is Tinybird (SDK or its ClickHouse-compatible gateway,
// which surfaces as _tag "clickhouse" when CLICKHOUSE_URL is set) and enforces
// the restriction, so only a genuine per-org BYO ClickHouse keeps the setting.
const makeRecordingDeps = (
	resolved: { config: ResolvedWarehouseConfig; source: "managed" | "org_override" },
	sqls: Array<string>,
): WarehouseExecutorDeps => ({
	createClient: () => ({
		sql: async (sql: string) => {
			sqls.push(sql)
			return { data: [] }
		},
		insert: async () => {},
	}),
	resolveConfig: () => Effect.succeed(resolved),
	resolveIngestConfig: () => Effect.succeed(resolved),
})

describe("makeWarehouseExecutor restricted-settings strip", () => {
	it.effect("strips max_block_size for the managed Tinybird CH-gateway (_tag clickhouse, source managed)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, source: "managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.lengthOf(sqls, 1)
			assert.isFalse(sqls[0]?.includes("max_block_size"))
		}),
	)

	it.effect("strips max_block_size for the managed Tinybird SDK backend (_tag tinybird, source managed)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdConfig, source: "managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.isFalse(sqls[0]?.includes("max_block_size"))
		}),
	)

	it.effect("keeps max_block_size for a genuine BYO ClickHouse (_tag clickhouse, source org_override)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, source: "org_override" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			assert.isTrue(sqls[0]?.includes("max_block_size=512"))
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
	resolveConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
	resolveIngestConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
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
	resolveConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
	resolveIngestConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
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

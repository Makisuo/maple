#!/usr/bin/env bun
// bench-queries.ts — ClickHouse query benchmarking CLI (Effect)
//
// Replays production SQL (captured on `WarehouseQueryService.executeSql` spans
// as `db.query.text`) against a target ClickHouse and reports wall-time +
// ClickHouse server-side stats + EXPLAIN plans.
//
//   bun run scripts/bench-queries.ts catalog  [flags]   # compile real builders → JSON
//   bun run scripts/bench-queries.ts fetch    [flags]   # mine traces → JSON
//   bun run scripts/bench-queries.ts run      <file>    # replay queries
//   bun run scripts/bench-queries.ts inspect  <file>    # EXPLAIN + PIPELINE
//   bun run scripts/bench-queries.ts compare  <a> <b>   # diff two runs
//
// Built on Effect v4 end-to-end: `effect/unstable/cli` for the command tree
// (help/version/usage come for free), `Config` for env, `Schema.TaggedError`
// for failures, `Context.Service` HTTP clients, core `FileSystem` for IO, and
// `@effect/platform-bun` for the runtime + CLI environment. Env (via `Config`):
//   TINYBIRD_HOST, TINYBIRD_TOKEN          — source (where prod traces live)
//   CLICKHOUSE_URL, CLICKHOUSE_USER,       — target (where we replay queries)
//     CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
//   MAPLE_INTERNAL_ORG_ID  (default: internal)

import { dirname, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	Clock,
	Config,
	Console,
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import * as Bench from "@maple/query-engine/benchmark"
import { collectWarehouseQueryCatalog } from "./query-bench/catalog"
import { escapeClickHouseString } from "@maple-dev/clickhouse-builder/sql"

// Errors

class MissingConfigError extends Schema.TaggedError<MissingConfigError>()(
	"@maple/api/scripts/bench-queries/MissingConfigError",
	{
		what: Schema.String,
		message: Schema.String,
	},
) {}

class HttpRequestError extends Schema.TaggedError<HttpRequestError>()(
	"@maple/api/scripts/bench-queries/HttpRequestError",
	{
		url: Schema.String,
		message: Schema.String,
	},
) {}

class UpstreamStatusError extends Schema.TaggedError<UpstreamStatusError>()(
	"@maple/api/scripts/bench-queries/UpstreamStatusError",
	{
		source: Schema.String,
		status: Schema.Number,
		message: Schema.String,
	},
) {}

class BenchFileError extends Schema.TaggedError<BenchFileError>()(
	"@maple/api/scripts/bench-queries/BenchFileError",
	{
		path: Schema.String,
		op: Schema.String,
		message: Schema.String,
	},
) {}

class InvalidDurationError extends Schema.TaggedError<InvalidDurationError>()(
	"@maple/api/scripts/bench-queries/InvalidDurationError",
	{
		input: Schema.String,
		message: Schema.String,
	},
) {}

// Internal data shapes (typed JSON; not branded — local dev tool)

interface Sample {
	readonly fingerprint: string
	readonly context: string
	readonly profile: string
	readonly sampleSql: string
	readonly sampleCount: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
	readonly maxDurationMs: number
}

interface FetchOutput {
	readonly fetchedAt: string
	readonly source: string
	readonly criteria: {
		readonly orgId: string
		readonly startTime: string
		readonly endTime: string
		readonly contextFilter?: string
		readonly profileFilter?: string
		readonly topN: number
	}
	readonly samples: ReadonlyArray<Sample>
}

interface ChResult {
	readonly status: number
	readonly body: string
	readonly queryId: string
	readonly wallMs: number
	readonly summary: Option.Option<Readonly<Record<string, unknown>>>
}

// BenchConfig — resolve warehouse credentials from the environment via `Config`

interface ClickHouseConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

interface TinybirdConfig {
	readonly host: string
	readonly token: string
	readonly internalOrgId: string
}

interface BenchConfigValues {
	readonly clickhouse: Option.Option<ClickHouseConfig>
	readonly tinybird: Option.Option<TinybirdConfig>
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "")

export class BenchConfig extends Context.Service<BenchConfig, BenchConfigValues>()("bench/BenchConfig", {
	make: Effect.gen(function* () {
		const chUrl = yield* Config.option(Config.string("CLICKHOUSE_URL"))
		const chUser = yield* Config.string("CLICKHOUSE_USER").pipe(Config.withDefault("default"))
		const chDatabase = yield* Config.string("CLICKHOUSE_DATABASE").pipe(Config.withDefault("default"))
		const chPassword = yield* Config.option(Config.redacted("CLICKHOUSE_PASSWORD"))
		const tbHost = yield* Config.option(Config.string("TINYBIRD_HOST"))
		const tbToken = yield* Config.option(Config.redacted("TINYBIRD_TOKEN"))
		const internalOrgId = yield* Config.string("MAPLE_INTERNAL_ORG_ID").pipe(
			Config.withDefault("internal"),
		)

		const clickhouse = Option.map(chUrl, (url) => ({
			url: stripTrailingSlash(url),
			user: chUser,
			database: chDatabase,
			password: Option.match(chPassword, { onNone: () => "", onSome: Redacted.value }),
		}))

		const tinybird = Option.zipWith(tbHost, tbToken, (host, token) => ({
			host: stripTrailingSlash(host),
			token: Redacted.value(token),
			internalOrgId,
		}))

		return { clickhouse, tinybird } satisfies BenchConfigValues
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

// ClickHouse client — raw HTTP so we can read X-ClickHouse-Summary + query_id

const parseSummaryHeader = (value: string | null): Option.Option<Readonly<Record<string, unknown>>> =>
	value === null
		? Option.none()
		: Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
				value,
			)

interface ClickHouseApi {
	readonly run: (
		sql: string,
		opts?: { readonly queryId?: string; readonly timeoutMs?: number },
	) => Effect.Effect<ChResult, HttpRequestError | MissingConfigError>
	readonly queryLogs: (
		queryIds: ReadonlyArray<string>,
		waitSeconds: number,
		cluster?: string,
	) => Effect.Effect<
		{ readonly entries: ReadonlyArray<Bench.LogMetrics>; readonly warnings: ReadonlyArray<string> },
		MissingConfigError
	>
	readonly target: Effect.Effect<{ readonly url: string; readonly database: string }, MissingConfigError>
}

export class ClickHouse extends Context.Service<ClickHouse, ClickHouseApi>()("bench/ClickHouse", {
	make: Effect.gen(function* () {
		const { clickhouse } = yield* BenchConfig
		const httpClient = yield* HttpClient.HttpClient

		const requireConfig: Effect.Effect<ClickHouseConfig, MissingConfigError> = Option.match(clickhouse, {
			onNone: () =>
				Effect.fail(
					new MissingConfigError({
						what: "CLICKHOUSE_URL",
						message:
							"CLICKHOUSE_URL is required to replay queries — point it at the target cluster " +
							"(local, staging, or a BYO cluster). Tinybird's SQL endpoint can't expose " +
							"query_id / system.query_log.",
					}),
				),
			onSome: (cfg) => Effect.succeed(cfg),
		})

		const authHeader = (cfg: ClickHouseConfig) =>
			`Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`

		const run: ClickHouseApi["run"] = Effect.fn("ClickHouse.run")(
			function* (sql: string, opts?: { readonly queryId?: string; readonly timeoutMs?: number }) {
				const cfg = yield* requireConfig
				const queryId = opts?.queryId ?? randomUUID()
				const url = new URL(cfg.url)
				url.searchParams.set("database", cfg.database)
				url.searchParams.set("query_id", queryId)
				url.searchParams.set("wait_end_of_query", "1")
				url.searchParams.set("readonly", "2")
				url.searchParams.set("log_queries", "0")

				const start = performance.now()
				const request = HttpClientRequest.post(url, {
					headers: {
						Authorization: authHeader(cfg),
						"Content-Type": "text/plain; charset=utf-8",
					},
				}).pipe(HttpClientRequest.bodyText(sql))
				const response = yield* httpClient
					.execute(request)
					.pipe(
						Effect.mapError(
							(cause) => new HttpRequestError({ url: cfg.url, message: String(cause) }),
						),
					)
				const body = yield* response.text.pipe(
					Effect.mapError(
						(cause) => new HttpRequestError({ url: cfg.url, message: String(cause) }),
					),
				)
				const wallMs = performance.now() - start

				return {
					status: response.status,
					body,
					queryId,
					wallMs,
					summary: parseSummaryHeader(response.headers["x-clickhouse-summary"] ?? null),
				} satisfies ChResult
			},
			(effect, _sql, opts) =>
				effect.pipe(
					Effect.timeout(opts?.timeoutMs ?? 35_000),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new HttpRequestError({
								url: "ClickHouse",
								message: "Request timed out (including response body).",
							}),
						),
					),
				),
		)

		// Buffered logs are collected in batches AFTER the timing loop. Never flush
		// global logs or drop caches on a shared server.
		const queryLogs = Effect.fn("ClickHouse.queryLogs")(function* (
			queryIds: ReadonlyArray<string>,
			waitSeconds: number,
			cluster?: string,
		) {
			const entries = new Map<string, Bench.LogMetrics>()
			const warnings: string[] = []
			const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1000
			if (queryIds.length === 0) return { entries: [], warnings }
			while (true) {
				const pending = queryIds.filter((id) => !entries.has(id))
				for (let offset = 0; offset < pending.length; offset += 100) {
					const ids = pending
						.slice(offset, offset + 100)
						.map((id) => `'${escapeClickHouseString(id)}'`)
						.join(",")
					const table = cluster
						? `clusterAllReplicas('${escapeClickHouseString(cluster)}', system.query_log)`
						: "system.query_log"
					const sql = `SELECT query_id, memory_usage, query_duration_ms, read_rows, read_bytes, result_rows, ProfileEvents
                        FROM ${table} WHERE event_date >= today() - 1 AND is_initial_query = 1
                        AND type = 'QueryFinish' AND query_id IN (${ids})
                        ORDER BY event_time_microseconds DESC LIMIT 1 BY query_id FORMAT JSONEachRow`
					const result = yield* run(sql).pipe(Effect.result)
					if (result._tag === "Failure" || result.success.status !== 200) {
						warnings.push(
							"system.query_log unavailable (permissions, logging, or cluster configuration); using HTTP summary metrics.",
						)
						return { entries: [...entries.values()], warnings }
					}
					const decoded = yield* decodeJsonLines(result.success.body).pipe(Effect.result)
					if (decoded._tag === "Failure") {
						warnings.push("Invalid system.query_log response; using HTTP summary metrics.")
						return { entries: [...entries.values()], warnings }
					}
					for (const row of decoded.success) {
						if (typeof row.query_id !== "string" || !queryIds.includes(row.query_id)) continue
						const events: Record<string, number> = {}
						if (typeof row.ProfileEvents === "object" && row.ProfileEvents !== null) {
							for (const [key, value] of Object.entries(row.ProfileEvents)) {
								const metric = Bench.metricNumber(value)
								if (metric !== null) events[key] = metric
							}
						}
						entries.set(row.query_id, {
							queryId: row.query_id,
							memoryUsage: Bench.metricNumber(row.memory_usage),
							serverElapsedMs: Bench.metricNumber(row.query_duration_ms),
							readRows: Bench.metricNumber(row.read_rows),
							readBytes: Bench.metricNumber(row.read_bytes),
							resultRows: Bench.metricNumber(row.result_rows),
							profileEvents: events,
						})
					}
				}
				const remainingMs = deadline - (yield* Clock.currentTimeMillis)
				if (entries.size === queryIds.length || remainingMs <= 0) break
				yield* Effect.sleep(Duration.millis(Math.min(1000, remainingMs)))
			}
			return { entries: [...entries.values()], warnings }
		})
		const target = requireConfig.pipe(
			Effect.map((cfg) => ({ url: new URL(cfg.url).origin, database: cfg.database })),
		)
		return { run, queryLogs, target } satisfies ClickHouseApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BenchConfig.layer))
}

// Tinybird client — source for mining db.query.text spans

interface TinybirdApi {
	readonly query: (
		sql: string,
	) => Effect.Effect<
		ReadonlyArray<Record<string, unknown>>,
		HttpRequestError | UpstreamStatusError | MissingConfigError
	>
	readonly host: Effect.Effect<string, MissingConfigError>
	readonly internalOrgId: Effect.Effect<string, MissingConfigError>
}

export class Tinybird extends Context.Service<Tinybird, TinybirdApi>()("bench/Tinybird", {
	make: Effect.gen(function* () {
		const { tinybird } = yield* BenchConfig
		const httpClient = yield* HttpClient.HttpClient

		const requireConfig: Effect.Effect<TinybirdConfig, MissingConfigError> = Option.match(tinybird, {
			onNone: () =>
				Effect.fail(
					new MissingConfigError({
						what: "TINYBIRD_HOST/TINYBIRD_TOKEN",
						message:
							"TINYBIRD_HOST and TINYBIRD_TOKEN are required to mine recent db.query.text spans " +
							"from production traces.",
					}),
				),
			onSome: (cfg) => Effect.succeed(cfg),
		})

		const query = Effect.fn("Tinybird.query")(function* (sql: string) {
			const cfg = yield* requireConfig
			const url = `${cfg.host}/v0/sql?q=${encodeURIComponent(sql)}`
			const request = HttpClientRequest.get(url, {
				headers: { Authorization: `Bearer ${cfg.token}` },
			})
			const response = yield* httpClient
				.execute(request)
				.pipe(
					Effect.mapError(
						(cause) => new HttpRequestError({ url: cfg.host, message: String(cause) }),
					),
				)
			const text = yield* response.text.pipe(
				Effect.mapError((cause) => new HttpRequestError({ url: cfg.host, message: String(cause) })),
			)
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new UpstreamStatusError({
						source: "Tinybird",
						status: response.status,
						message: text.slice(0, 500),
					}),
				)
			}
			const parsed = yield* decodeJson(text, Schema.Struct({ data: Schema.Array(JsonRow) })).pipe(
				Effect.mapError((cause) => new HttpRequestError({ url: cfg.host, message: cause.message })),
			)
			return parsed.data
		})

		return {
			query,
			host: requireConfig.pipe(Effect.map((c) => c.host)),
			internalOrgId: requireConfig.pipe(Effect.map((c) => c.internalOrgId)),
		} satisfies TinybirdApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BenchConfig.layer))
}

// File IO via the core FileSystem service

const decodeJson = <A>(text: string, schema: Schema.Decoder<A>) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((cause) => new Bench.BenchmarkError({ message: String(cause) })),
	)

const JsonRow = Schema.Record(Schema.String, Schema.Unknown)
const decodeJsonLines = (text: string) =>
	Effect.forEach(text.trim() ? text.trim().split("\n") : [], (line) => decodeJson(line, JsonRow))

const readJsonFile = <A>(path: string, schema: Schema.Decoder<A>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs
			.readFileString(path)
			.pipe(
				Effect.mapError((cause) => new BenchFileError({ path, op: "read", message: String(cause) })),
			)
		return yield* decodeJson(text, schema).pipe(
			Effect.mapError((cause) => new BenchFileError({ path, op: "decode", message: cause.message })),
		)
	})

const writeJsonFile = (path: string, value: unknown) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs
			.makeDirectory(dirname(resolve(path)), { recursive: true })
			.pipe(
				Effect.mapError((cause) => new BenchFileError({ path, op: "mkdir", message: String(cause) })),
			)
		yield* fs
			.writeFileString(path, JSON.stringify(value, null, 2))
			.pipe(
				Effect.mapError((cause) => new BenchFileError({ path, op: "write", message: String(cause) })),
			)
	})

// Pure helpers — time, formatting, stats, table

const parseRelativeDuration = (input: string): Effect.Effect<number, InvalidDurationError> => {
	const match = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim())
	if (!match) {
		return Effect.fail(
			new InvalidDurationError({
				input,
				message: `Expected NNs / NNm / NNh / NNd (e.g. 24h, 7d), got "${input}".`,
			}),
		)
	}
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase()]!
	return Effect.succeed(Number(match[1]) * unit)
}

const formatCHDateTime = (d: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0")
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	)
}

const formatMs = (ms: number | null | undefined): string => {
	if (ms == null || Number.isNaN(ms)) return "—"
	if (ms < 1) return `${ms.toFixed(2)}ms`
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const formatRows = (n: number | null | undefined): string => {
	if (n == null || Number.isNaN(n)) return "—"
	if (n < 1_000) return String(n)
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	return `${(n / 1_000_000_000).toFixed(2)}B`
}

const formatBytes = (n: number | null | undefined): string => {
	if (n == null || Number.isNaN(n)) return "—"
	if (n < 1024) return `${n}B`
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`
	return `${(n / 1024 ** 3).toFixed(2)}GB`
}

const formatMemoryMB = (bytes: number | null | undefined): string =>
	bytes == null || Number.isNaN(bytes) ? "—" : `${(bytes / 1024 / 1024).toFixed(1)}MB`

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

interface Column {
	readonly header: string
	readonly width: number
	readonly align?: "right"
}

const renderTable = (
	title: string,
	columns: ReadonlyArray<Column>,
	rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
	const pad = (value: string, col: Column) => {
		const t = truncate(value, col.width)
		return col.align === "right" ? t.padStart(col.width) : t.padEnd(col.width)
	}
	const innerWidth = columns.reduce((sum, c) => sum + c.width, 0) + (columns.length - 1) * 3
	const border = "─".repeat(innerWidth + 2)
	const titleLine = ` ${title} `
	const titleBorderRight = "─".repeat(Math.max(0, innerWidth + 2 - titleLine.length - 2))
	const lines: string[] = []
	lines.push(`┌─${titleLine}${titleBorderRight}┐`)
	lines.push(`│ ${columns.map((c) => pad(c.header, c)).join(" │ ")} │`)
	lines.push(`├${border}┤`)
	for (const row of rows) lines.push(`│ ${row.map((v, i) => pad(v, columns[i]!)).join(" │ ")} │`)
	lines.push(`└${border}┘`)
	return lines.join("\n")
}

const artifactDirectory = fileURLToPath(new URL(".bench/", import.meta.url))
const defaultOutput = (name: string) => resolve(artifactDirectory, `${name}-${timestampSlug()}.json`)

const timestampSlug = () => new Date().toISOString().replace(/[:.]/g, "-")

// Handlers

interface FetchConfig {
	readonly context: Option.Option<string>
	readonly profile: Option.Option<string>
	readonly since: string
	readonly top: number
	readonly out: Option.Option<string>
	readonly org: Option.Option<string>
}

const fetchHandler = Effect.fn("bench.fetch")(function* (config: FetchConfig) {
	const tinybird = yield* Tinybird
	const sinceMs = yield* parseRelativeDuration(config.since)
	const nowMs = yield* Clock.currentTimeMillis
	const startTime = formatCHDateTime(new Date(nowMs - sinceMs))
	const endTime = formatCHDateTime(new Date(nowMs))
	const topN = config.top
	const orgId = yield* Option.match(config.org, {
		onNone: () => tinybird.internalOrgId,
		onSome: (o) => Effect.succeed(o),
	})
	const host = yield* tinybird.host

	const compiled = yield* CH.compile(
		Integrations.dbStatementSamplesQuery({
			contextFilter: Option.getOrUndefined(config.context),
			profileFilter: Option.getOrUndefined(config.profile),
			limit: topN,
		}),
		{ orgId, startTime, endTime },
	)

	yield* Console.log(`Mining db.query.text spans from ${host}`)
	yield* Console.log(`  org: ${orgId}   window: ${startTime} → ${endTime} (${config.since})   top: ${topN}`)

	const rows = yield* tinybird.query(compiled.sql)
	const samples: ReadonlyArray<Sample> = yield* compiled.decodeRows(rows)

	if (samples.length === 0) {
		yield* Console.log("No samples found. Widen --since or drop filters.")
		return
	}

	const outputPath = Option.getOrElse(config.out, () => defaultOutput("queries"))
	const output: FetchOutput = {
		fetchedAt: new Date(nowMs).toISOString(),
		source: host,
		criteria: {
			orgId,
			startTime,
			endTime,
			contextFilter: Option.getOrUndefined(config.context),
			profileFilter: Option.getOrUndefined(config.profile),
			topN,
		},
		samples,
	}
	yield* writeJsonFile(outputPath, output)

	yield* Console.log(
		renderTable(
			`Top ${samples.length} queries by p95 duration`,
			[
				{ header: "context", width: 28 },
				{ header: "profile", width: 12 },
				{ header: "fingerprint", width: 16 },
				{ header: "count", width: 8, align: "right" },
				{ header: "p50", width: 8, align: "right" },
				{ header: "p95", width: 8, align: "right" },
				{ header: "p99", width: 8, align: "right" },
			],
			samples.map((s) => [
				s.context || "—",
				s.profile || "—",
				s.fingerprint,
				formatRows(s.sampleCount),
				formatMs(s.p50DurationMs),
				formatMs(s.p95DurationMs),
				formatMs(s.p99DurationMs),
			]),
		),
	)
	yield* Console.log(`\nWrote ${outputPath}`)
})

const filterSuite = (suite: Bench.Suite, match: Option.Option<string>) =>
	Bench.validateSuite({
		...suite,
		samples: Option.isSome(match)
			? suite.samples.filter((sample) =>
					`${Bench.sampleId(sample)} ${sample.context}`
						.toLowerCase()
						.includes(match.value.toLowerCase()),
				)
			: suite.samples,
	})

const catalogHandler = Effect.fn("bench.catalog")(function* (config: {
	readonly match: Option.Option<string>
	readonly suite: Option.Option<string>
	readonly out: Option.Option<string>
}) {
	const suite = yield* Option.match(config.suite, {
		onSome: (path) =>
			Effect.tryPromise({
				try: () =>
					import(pathToFileURL(resolve(path)).href).then(
						(module: { default: unknown }) => module.default,
					),
				catch: (cause) => new BenchFileError({ path, op: "import suite", message: String(cause) }),
			}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Bench.Suite))),
		onNone: () => collectWarehouseQueryCatalog().pipe(Effect.flatMap(Bench.suiteFromCatalog)),
	})
	const selected = yield* filterSuite(suite, config.match)
	const path = Option.getOrElse(config.out, () => defaultOutput("catalog"))
	yield* writeJsonFile(path, selected)
	yield* Console.log(selected.samples.map((sample) => Bench.sampleId(sample)).join("\n"))
	yield* Console.log(`\nWrote ${selected.samples.length} cases to ${path}`)
	if (Option.isNone(config.suite))
		yield* Console.log(
			"Catalog fixtures use org_sql_catalog and synthetic dates/filters. Use --suite for a representative tenant and fixed window.",
		)
})

interface RunConfig {
	readonly file: string
	readonly runs: number
	readonly warmup: number
	readonly out: Option.Option<string>
	readonly match: Option.Option<string>
	readonly dataset: string
	readonly timeout: number
	readonly threads: Option.Option<number>
	readonly cache: "warm" | "bypass"
	readonly verifyResults: boolean
	readonly resultOrder: "ordered" | "unordered"
	readonly logWait: number
	readonly cluster: Option.Option<string>
}

const requireOk = (result: ChResult) =>
	result.status === 200
		? Effect.succeed(result)
		: Effect.fail(
				new Bench.BenchmarkError({
					message: `ClickHouse ${result.status}: ${result.body.slice(0, 1000)}`,
				}),
			)

const runHandler = Effect.fn("bench.run")(function* (config: RunConfig) {
	const ch = yield* ClickHouse
	const suite = yield* readJsonFile(config.file, Bench.Suite).pipe(
		Effect.flatMap((s) => filterSuite(s, config.match)),
	)
	if (
		!Number.isInteger(config.runs) ||
		config.runs < 1 ||
		config.runs > 1000 ||
		!Number.isInteger(config.warmup) ||
		config.warmup < 0 ||
		config.warmup > 100 ||
		!Number.isInteger(config.timeout) ||
		config.timeout < 1 ||
		config.timeout > 3600 ||
		!Number.isInteger(config.logWait) ||
		config.logWait < 0 ||
		config.logWait > 60 ||
		(Option.isSome(config.threads) && (config.threads.value < 1 || config.threads.value > 256))
	) {
		return yield* Effect.fail(
			new Bench.BenchmarkError({
				message:
					"Expected runs 1–1000, warmup 0–100, timeout 1–3600s, log-wait 0–60s, threads 1–256.",
			}),
		)
	}
	yield* Effect.forEach(suite.samples, (sample) => Bench.validateReplaySql(sample.sampleSql), {
		discard: true,
	})
	const target = yield* ch.target
	const metadata = yield* ch
		.run("SELECT version() AS version, currentDatabase() AS database FORMAT JSONEachRow")
		.pipe(Effect.flatMap(requireOk))
	const server = yield* decodeJson(
		metadata.body,
		Schema.Struct({ version: Schema.String, database: Schema.String }),
	)
	const settings = {
		max_execution_time: String(config.timeout),
		use_query_cache: "0",
		use_query_condition_cache: "0",
		log_queries: "1",
		log_query_settings: "1",
		log_queries_probability: "1",
		...(Option.isSome(config.threads) ? { max_threads: String(config.threads.value) } : undefined),
		...(config.cache === "bypass"
			? { enable_filesystem_cache: "0", use_uncompressed_cache: "0" }
			: undefined),
	} satisfies Bench.RunOutput["settings"]
	const execute: Bench.BenchmarkTransport["execute"] = (sql) =>
		Effect.gen(function* () {
			const result = yield* ch.run(sql, { timeoutMs: config.timeout * 1000 + 5000 }).pipe(
				Effect.mapError((cause) => new Bench.BenchmarkError({ message: cause.message })),
				Effect.flatMap(requireOk),
			)
			let resultHash: string | undefined
			if (config.verifyResults) {
				const rows = yield* decodeJsonLines(result.body)
				const canonical = rows.map(Bench.canonicalJson)
				if (config.resultOrder === "unordered") canonical.sort()
				resultHash = createHash("sha256").update(canonical.join("\n")).digest("hex")
			}
			return {
				queryId: result.queryId,
				wallMs: result.wallMs,
				summary: Option.getOrElse(result.summary, () => ({})),
				...(resultHash ? { resultHash } : undefined),
			}
		})
	yield* Console.log(
		`Benchmarking ${suite.samples.length} cases on ${target.url}/${server.database} (ClickHouse ${server.version})`,
	)
	const result = yield* Bench.runSuite(
		{
			execute,
			collectLogs: (ids) =>
				ch
					.queryLogs(ids, config.logWait, Option.getOrUndefined(config.cluster))
					.pipe(Effect.mapError((cause) => new Bench.BenchmarkError({ message: cause.message }))),
		},
		suite,
		{ runs: config.runs, warmup: config.warmup, settings, verifyResults: config.verifyResults },
		Console.log,
	)
	const output: Bench.RunOutput = {
		version: 1,
		ranAt: new Date().toISOString(),
		target: target.url,
		database: server.database,
		serverVersion: server.version,
		dataset: config.dataset,
		sourceFile: resolve(config.file),
		source: suite.source,
		runsPerQuery: config.runs,
		warmupRuns: config.warmup,
		settings,
		verifyResults: config.verifyResults,
		resultOrder: config.resultOrder,
		...result,
	}
	const path = Option.getOrElse(config.out, () => defaultOutput("results"))
	yield* writeJsonFile(path, output)
	yield* Console.log(
		renderTable(
			"Benchmark results",
			[
				{ header: "case", width: 55 },
				{ header: "p50 wall", width: 10 },
				{ header: "p95 wall", width: 10 },
				{ header: "server", width: 10 },
				{ header: "rows", width: 10 },
				{ header: "bytes", width: 10 },
				{ header: "memory", width: 10 },
			],
			result.results.map((r) => [
				r.error ? `${r.id} FAILED` : r.id,
				formatMs(r.aggregates.p50WallMs),
				formatMs(r.aggregates.p95WallMs),
				formatMs(r.aggregates.meanServerMs),
				formatRows(r.aggregates.meanReadRows),
				formatBytes(r.aggregates.meanReadBytes),
				formatMemoryMB(r.aggregates.meanMemoryUsage),
			]),
		),
	)
	for (const warning of result.warnings) yield* Console.log(`Warning: ${warning}`)
	yield* Console.log(`Wrote ${path}`)
	if (result.results.some((r) => r.error))
		return yield* Effect.fail(
			new Bench.BenchmarkError({
				message: "Some queries failed; completed measurements and errors were saved.",
			}),
		)
})

const inspectHandler = Effect.fn("bench.inspect")(function* (config: {
	readonly file: string
	readonly match: Option.Option<string>
	readonly out: Option.Option<string>
}) {
	const ch = yield* ClickHouse
	const input = yield* readJsonFile(config.file, Schema.Union([Bench.Suite, Bench.RunOutput]))
	const suite = yield* filterSuite(
		"samples" in input
			? input
			: {
					source: input.source,
					samples: input.results.map((r) => ({
						id: r.id,
						context: r.context,
						profile: r.profile,
						fingerprint: r.fingerprint,
						sampleSql: r.sql,
						...(r.inputs === undefined ? undefined : { inputs: r.inputs }),
					})),
				},
		config.match,
	)
	yield* Effect.forEach(suite.samples, (sample) => Bench.validateReplaySql(sample.sampleSql), {
		discard: true,
	})
	const target = yield* ch.target
	const plans = yield* Effect.forEach(suite.samples, (sample) =>
		Effect.gen(function* () {
			const variants = yield* Effect.forEach(["indexes", "pipeline"] as const, (kind) =>
				Effect.gen(function* () {
					const sql = Bench.explainSql(sample.sampleSql, kind)
					const result = yield* ch.run(sql)
					yield* Console.log(`\n${Bench.sampleId(sample)} — ${kind}\n${result.body}`)
					return { kind, sql, status: result.status, plan: result.body }
				}),
			)
			return { id: Bench.sampleId(sample), sql: sample.sampleSql, variants }
		}),
	)
	const tables = yield* ch.run(
		"SELECT name, engine, sorting_key, primary_key, partition_key, total_rows, total_bytes, create_table_query FROM system.tables WHERE database = currentDatabase() ORDER BY name FORMAT JSONEachRow",
	)
	const path = Option.getOrElse(config.out, () => defaultOutput("plans"))
	yield* writeJsonFile(path, {
		version: 1,
		inspectedAt: new Date().toISOString(),
		target,
		source: suite.source,
		plans,
		tables: tables.status === 200 ? yield* decodeJsonLines(tables.body) : [],
		warnings: tables.status === 200 ? [] : ["Table metadata unavailable"],
	})
	yield* Console.log(`Wrote ${path}`)
	if (plans.some((p) => p.variants.some((v) => v.status !== 200)))
		return yield* Effect.fail(
			new Bench.BenchmarkError({ message: "Some EXPLAIN plans failed; details were saved." }),
		)
})

const compareHandler = Effect.fn("bench.compare")(function* (config: {
	readonly baseline: string
	readonly candidate: string
	readonly metric: Bench.ComparisonMetric
	readonly threshold: number
	readonly minDelta: number
	readonly failOnRegression: boolean
	readonly out: Option.Option<string>
}) {
	if (
		!Number.isFinite(config.threshold) ||
		config.threshold < 0 ||
		!Number.isFinite(config.minDelta) ||
		config.minDelta < 0
	) {
		return yield* Effect.fail(
			new Bench.BenchmarkError({
				message: "Comparison thresholds must be finite non-negative numbers.",
			}),
		)
	}
	const a = yield* readJsonFile(config.baseline, Bench.RunOutput)
	const b = yield* readJsonFile(config.candidate, Bench.RunOutput)
	for (const run of [a, b]) {
		if (!run.results.length || new Set(run.results.map((r) => r.id)).size !== run.results.length)
			return yield* Effect.fail(
				new Bench.BenchmarkError({
					message: "Reports must contain measurements with unique case IDs.",
				}),
			)
	}
	const comparison = Bench.compareRuns(a, b, {
		metric: config.metric,
		thresholdPercent: config.threshold,
		minDelta: config.minDelta,
	})
	yield* Console.log(
		renderTable(
			`Compare ${config.metric} (threshold ${config.threshold}%, minimum delta ${config.minDelta})`,
			[
				{ header: "case", width: 55 },
				{ header: "status", width: 16 },
				{ header: "baseline", width: 12 },
				{ header: "candidate", width: 12 },
				{ header: "change", width: 12 },
				{ header: "SQL changed", width: 11 },
			],
			comparison.rows.map((r) => [
				r.id,
				r.status,
				r.baseline?.toFixed(2) ?? "—",
				r.candidate?.toFixed(2) ?? "—",
				r.percent === null
					? r.baseline === 0 && (r.delta ?? 0) > 0
						? "from zero"
						: "—"
					: `${r.percent.toFixed(1)}%`,
				r.sqlChanged ? "yes" : "no",
			]),
		),
	)
	for (const row of comparison.rows) if (row.reason) yield* Console.log(`${row.id}: ${row.reason}`)
	for (const warning of comparison.warnings) yield* Console.log(`Warning: ${warning}`)
	if (Option.isSome(config.out)) {
		yield* writeJsonFile(config.out.value, comparison)
		yield* Console.log(`Wrote ${config.out.value}`)
	}
	if (config.failOnRegression && comparison.failed)
		return yield* Effect.fail(
			new Bench.BenchmarkError({
				message:
					"Comparison failed: regression, changed results, or incomplete/incompatible evidence.",
			}),
		)
})

// CLI command tree (effect/unstable/cli)

const fetchCommand = Command.make(
	"fetch",
	{
		context: Flag.string("context").pipe(
			Flag.withDescription("Filter by query.context label"),
			Flag.optional,
		),
		profile: Flag.string("profile").pipe(Flag.withDescription("Filter by query.profile"), Flag.optional),
		since: Flag.string("since").pipe(
			Flag.withDescription("Look-back window, e.g. 24h or 7d"),
			Flag.withDefault("24h"),
		),
		top: Flag.integer("top").pipe(
			Flag.withDescription("Number of fingerprints to keep"),
			Flag.withDefault(20),
		),
		out: Flag.string("out").pipe(Flag.withDescription("Output JSON path"), Flag.optional),
		org: Flag.string("org").pipe(Flag.withDescription("Source org (default: internal)"), Flag.optional),
	},
	fetchHandler,
).pipe(Command.withDescription("Mine recent db.query.text spans from production traces into a JSON file"))

const matchFlag = Flag.string("match").pipe(
	Flag.withDescription("Case ID/context substring filter"),
	Flag.optional,
)
const outFlag = Flag.string("out").pipe(Flag.withDescription("Output JSON path"), Flag.optional)
const catalogCommand = Command.make(
	"catalog",
	{
		match: matchFlag,
		out: outFlag,
		suite: Flag.string("suite").pipe(
			Flag.withDescription("TS module exporting a benchmark suite (default export)"),
			Flag.optional,
		),
	},
	catalogHandler,
).pipe(
	Command.withDescription("Compile real catalog fixtures or a custom TypeScript suite without a warehouse"),
)

const runCommand = Command.make(
	"run",
	{
		file: Argument.string("file").pipe(
			Argument.withDescription("Queries JSON produced by catalog/fetch"),
		),
		runs: Flag.integer("runs").pipe(Flag.withDescription("Timed runs per query"), Flag.withDefault(5)),
		warmup: Flag.integer("warmup").pipe(
			Flag.withDescription("Warmup runs before timing"),
			Flag.withDefault(1),
		),
		out: outFlag,
		match: matchFlag,
		dataset: Flag.string("dataset").pipe(
			Flag.withDescription("Stable dataset revision for comparable runs"),
			Flag.withDefault("unspecified"),
		),
		timeout: Flag.integer("timeout").pipe(
			Flag.withDescription("Query timeout in seconds"),
			Flag.withDefault(30),
		),
		threads: Flag.integer("threads").pipe(
			Flag.withDescription("Pin max_threads for reproducible measurements"),
			Flag.optional,
		),
		cache: Flag.choice("cache", ["warm", "bypass"]).pipe(
			Flag.withDescription(
				"Result/condition caches always disabled; bypass also disables filesystem/uncompressed caches (OS cache remains)",
			),
			Flag.withDefault("warm"),
		),
		verifyResults: Flag.boolean("verify-results").pipe(
			Flag.withDescription("Hash JSON results for exact equivalence checks"),
		),
		resultOrder: Flag.choice("result-order", ["ordered", "unordered"]).pipe(
			Flag.withDefault("unordered"),
		),
		logWait: Flag.integer("log-wait").pipe(
			Flag.withDescription("Maximum log flush polling wait in seconds after timing"),
			Flag.withDefault(12),
		),
		cluster: Flag.string("cluster").pipe(
			Flag.withDescription("Read query logs across this ClickHouse cluster"),
			Flag.optional,
		),
	},
	runHandler,
).pipe(Command.withDescription("Replay each query and report wall-time + server-side stats"))

const inspectCommand = Command.make(
	"inspect",
	{ file: Argument.string("file"), match: matchFlag, out: outFlag },
	inspectHandler,
).pipe(
	Command.withDescription(
		"Save index/projection plans, pipelines, and table metadata from a suite or run report",
	),
)

const compareCommand = Command.make(
	"compare",
	{
		baseline: Argument.string("baseline").pipe(Argument.withDescription("Baseline results JSON")),
		candidate: Argument.string("candidate").pipe(Argument.withDescription("Candidate results JSON")),
		metric: Flag.choice("metric", [
			"p95WallMs",
			"meanServerMs",
			"meanReadRows",
			"meanReadBytes",
			"meanMemoryUsage",
		]).pipe(Flag.withDefault("p95WallMs")),
		threshold: Flag.float("threshold").pipe(
			Flag.withDescription("Maximum increase in percent"),
			Flag.withDefault(10),
		),
		minDelta: Flag.float("min-delta").pipe(
			Flag.withDescription("Minimum absolute increase in the metric's units"),
			Flag.withDefault(0),
		),
		failOnRegression: Flag.boolean("fail-on-regression").pipe(
			Flag.withDescription(
				"Exit nonzero on regressions, mismatches, missing cases, or incompatible evidence",
			),
		),
		out: outFlag,
	},
	compareHandler,
).pipe(Command.withDescription("Diff two run outputs (p95 wall, read bytes, memory)"))

const rootCommand = Command.make("bench-queries").pipe(
	Command.withDescription("Measure ClickHouse query performance"),
	Command.withSubcommands([catalogCommand, fetchCommand, runCommand, inspectCommand, compareCommand]),
)

const BenchServicesLive = Layer.mergeAll(ClickHouse.layer, Tinybird.layer).pipe(
	Layer.provide(FetchHttpClient.layer),
)
const BenchLive = Layer.mergeAll(BenchServicesLive, BunServices.layer)

Command.run(rootCommand, { version: "0.2.0" }).pipe(
	// Application root: this is the one runtime boundary that owns the complete layer graph.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(BenchLive),
	BunRuntime.runMain,
)

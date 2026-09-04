// The SQL gate.
//
// Runs every SQL shape the product can emit through a real ClickHouse analyzer.
// This exists because query-engine's unit tests assert on SQL *text*, and text
// is not a contract the analyzer honours — `if(sum(Float64), …, sum(UInt64))`
// produced exactly the expected string, was rejected with `NO_COMMON_TYPE`, and
// took every main chart to a 502 while CI stayed green.
//
// `DESCRIBE (SELECT …)` checks every case without reading rows. The final
// test also exercises the actual CLI against seeded production tables.
//
// Covers both catalogs: `@maple/query-engine`'s own (pipes, query specs, core
// builders) and `@maple/query-engine-integrations`' (Cloudflare, PlanetScale,
// AI builders), which lives with those builders because the core package must
// not depend on the integrations package.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Schema, type Exit } from "effect"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import type { CompiledQueryDecodeError } from "@maple-dev/clickhouse-builder"
import { caseFromCompiled, RunOutput, Suite } from "@maple/query-engine/benchmark"
import { collectWarehouseQueryCatalog } from "../../../scripts/query-bench/catalog"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	clickhouseUrl,
	clickhouseUser,
	clickhousePassword,
	describeQuery,
	isSixtyFourBitInt,
	looksLikeIdentityColumn,
	nullableColumns,
	rowWithNull,
	syntheticRow,
	uniqueDatabase,
	type DescribedColumn,
} from "./clickhouse-e2e-support"

/**
 * 64-bit identity columns that predate the identity rule and are consumed as
 * numbers on purpose. Do NOT grow this list — `toString()`-wrap the column in
 * the SELECT instead (see `looksLikeIdentityColumn`).
 */
const IDENTITY_COLUMN_ALLOWLIST: ReadonlySet<string> = new Set([])

/**
 * Output columns the analyzer types `Nullable(...)` whose row schema narrows to
 * non-null on purpose, because a predicate in the same query makes the null
 * unreachable. Each entry needs the predicate named — that is the whole value
 * of the list, since the dependency lives nowhere else.
 */
const NULLABLE_NARROWED_ALLOWLIST: ReadonlySet<string> = new Set([
	// `bucketFloorMs` runs `greatestNonNull(DurationMs, 1000)` over a nullable
	// column, so the analyzer keeps `Nullable` all the way through `toString`.
	// The branch's own `WHERE DurationMs > 0` excludes the nulls.
	"builder:session-replays:sessionReplaysFacetsQuery:default:name",
	"builder:session-replays:sessionReplaysFacetsQuery:identity-filtered:name",
])

const database = uniqueDatabase("maple_query_benchmark_e2e")

// Analyze every named case, including distinct decoder contracts that happen
// to emit the same SQL fingerprint. This is the exact catalog the CLI exports.
const catalog = Effect.runSync(collectWarehouseQueryCatalog())

// Keep command logs and JSON as reviewable evidence; only this suite's database
// is removed in afterAll. The artifact directory is already gitignored.
const artifacts = fileURLToPath(new URL(`../../../scripts/.bench/${database}/`, import.meta.url))
const benchScript = fileURLToPath(new URL("../../../scripts/bench-queries.ts", import.meta.url))
const runCli = async (label: string, args: ReadonlyArray<string>) => {
	const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
		const child = spawn("bun", [benchScript, ...args], {
			env: {
				...process.env,
				CLICKHOUSE_URL: clickhouseUrl,
				CLICKHOUSE_USER: clickhouseUser,
				CLICKHOUSE_PASSWORD: clickhousePassword,
				CLICKHOUSE_DATABASE: database,
			},
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 90_000,
		})
		let output = ""
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk
		})
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk
		})
		child.once("error", reject)
		child.once("close", (code) => resolve({ code: code ?? 1, output }))
	})
	await writeFile(join(artifacts, `${label}.log`), result.output)
	return result
}

describe.skipIf(!clickhouseE2eEnabled)("Query benchmark catalog analyzer sweep", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("has a catalog to check", () => {
		assert.isAbove(catalog.length, 50, "the catalog collapsed — fixtures are not compiling")
	})

	// A `for` loop, not `describe.each`: the latter OOMs tsc in this repo.
	for (const entry of catalog) {
		it(`analyzes ${entry.id}`, async () => {
			const sql = normalizeSqlForClickHouseClient(entry.sql)
			let columns: ReadonlyArray<DescribedColumn>
			try {
				columns = await describeQuery(sql, database)
			} catch (cause) {
				// Fail with the SQL attached — an analyzer message alone rarely
				// says which of 80 shapes produced it.
				assert.fail(
					`${entry.id} was rejected by the ClickHouse analyzer.\n\n` +
						`${String(cause)}\n\n--- SQL ---\n${sql}\n`,
				)
			}

			assert.isNotEmpty(columns, `${entry.id} described no output columns`)

			// A `Variant(...)` output column means two branches of a UNION or an
			// `if()` disagree on type and a permissive server papered over it. The
			// strictness pin should already have rejected that; this catches the
			// cases where a newer server finds some other way to say "either".
			const variantColumns = columns.filter((column) => column.type.includes("Variant("))
			assert.isEmpty(
				variantColumns,
				`${entry.id} has ambiguously typed output: ${variantColumns
					.map((column) => `${column.name} ${column.type}`)
					.join(", ")}`,
			)

			const wideColumns = columns.filter((column) => isSixtyFourBitInt(column.type))

			// Third class, same round trip: a 64-bit column that carries IDENTITY
			// (hash/id/fingerprint) must be `toString()`-wrapped in the SELECT. The
			// production clients pin `output_format_json_quote_64bit_integers=0` for
			// wire parity with Tinybird, so an unquoted identity above 2^53 would be
			// silently corrupted by JS number parsing.
			const identityColumns = wideColumns.filter(
				(column) =>
					looksLikeIdentityColumn(column.name) &&
					!IDENTITY_COLUMN_ALLOWLIST.has(`${entry.id}:${column.name}`),
			)
			assert.isEmpty(
				identityColumns,
				`${entry.id} selects identity-like 64-bit columns as integers: ${identityColumns
					.map((column) => `${column.name} ${column.type}`)
					.join(", ")}\n` +
					`Wrap them in toString(...) in the SELECT so the value survives JSON as a string.`,
			)

			// Second class, same round trip: a query's row schema has to accept the
			// JSON its own SQL produces, for BOTH 64-bit wire shapes — unquoted is
			// what the pinned production clients receive, quoted is what a
			// gateway/readonly cluster that refuses the setting still sends.
			// `CH.CHNumber` accepts both; `Schema.Number` rejects the quoted shape.
			//
			// Run for every query that has a schema at all, not just the ones with
			// 64-bit columns: the schema is now usually DERIVED from the SELECT, so
			// this is what checks the builder's own idea of a column's wire type
			// against the type the analyzer resolved.
			if (entry.compiled && entry.compiled.rowSchemaSource !== "none") {
				for (const quote64Bit of [false, true]) {
					// `sampleValues` covers columns whose schema narrows what the
					// ClickHouse type allows — the synthetic row is built from column
					// TYPES alone, so a literal union over a String would otherwise be
					// handed "" and fail a check that is about integer quoting.
					const row = { ...syntheticRow(columns, { quote64Bit }), ...entry.sampleValues }
					const decoded: Exit.Exit<
						ReadonlyArray<unknown>,
						CompiledQueryDecodeError
					> = await Effect.runPromise(Effect.exit(entry.compiled.decodeRows([row])))
					if (decoded._tag === "Failure") {
						assert.fail(
							`${entry.id} declares a row schema that rejects ClickHouse's own JSON output ` +
								`(64-bit ints ${quote64Bit ? "quoted" : "unquoted"}).\n` +
								`64-bit columns: ${wideColumns
									.map((column) => `${column.name} ${column.type}`)
									.join(", ")}\n` +
								`Decode those with CH.CHNumber, not Schema.Number.\n\n${String(decoded.cause)}\n`,
						)
					}
				}

				// Third wire shape, and the one the quoted/unquoted pair cannot see:
				// a column ClickHouse resolved as `Nullable(...)` really arriving as
				// null. `sampleValue` strips the wrapper, so a row schema that cannot
				// decode a null passes both passes above and fails on the first real
				// row. Narrowing a nullable column on purpose is legitimate — a WHERE
				// that excludes the nulls is the usual reason — but it has to be said
				// out loud here rather than being invisible.
				const row = { ...syntheticRow(columns, { quote64Bit: true }), ...entry.sampleValues }
				for (const column of nullableColumns(columns)) {
					if (NULLABLE_NARROWED_ALLOWLIST.has(`${entry.id}:${column.name}`)) continue
					const decoded: Exit.Exit<
						ReadonlyArray<unknown>,
						CompiledQueryDecodeError
					> = await Effect.runPromise(
						Effect.exit(entry.compiled.decodeRows([rowWithNull(row, column.name)])),
					)
					if (decoded._tag === "Failure") {
						assert.fail(
							`${entry.id} declares a row schema that rejects a null in ${column.name} ` +
								`(${column.type}).
` +
								`Either decode it with a nullable schema, or — if a predicate makes the ` +
								`null unreachable — add "${entry.id}:${column.name}" to ` +
								`NULLABLE_NARROWED_ALLOWLIST with the predicate that rules it out.

` +
								`${String(decoded.cause)}
`,
						)
					}
				}
			}
		}, 60_000)
	}

	it("benchmarks populated Maple queries through the real CLI and verifies raw/rollup parity", async () => {
		await mkdir(artifacts, { recursive: true })
		const exportedPath = join(artifacts, "catalog.json")
		const exported = await runCli("catalog", ["catalog", "--out", exportedPath])
		assert.equal(exported.code, 0, exported.output)
		const exportedSuite = Schema.decodeUnknownSync(Schema.fromJsonString(Suite))(
			await readFile(exportedPath, "utf8"),
		)
		assert.deepEqual(
			exportedSuite.samples.map((s) => s.id),
			catalog.map((c) => c.id),
			"CLI and analyzer must use exactly the same cases",
		)

		// Recent timestamps survive production TTLs. Minute-aligned bounds let
		// the rollup avoid raw edge reads; separate parity tests cover those seams.
		const startMs = Math.floor((Date.now() - 2 * 86_400_000) / 86_400_000) * 86_400_000 + 10.5 * 3_600_000
		const dateTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
		const inputs = {
			orgId: "org_benchmark_live",
			startTime: dateTime(startMs),
			endTime: dateTime(startMs + 13_500_000),
			bucketSeconds: 300,
		}
		await clickhouseExec(
			`INSERT INTO traces
			(OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, ResourceAttributes)
			SELECT if(number % 5 = 0, 'org_benchmark_other', 'org_benchmark_live'),
			toDateTime('${inputs.startTime}') + toIntervalSecond(number % 13500),
			lower(leftPad(hex(number), 32, '0')), lower(leftPad(hex(number), 16, '0')), '', 'GET /bench', 'Server',
			concat('service-', toString(number % 8)), toUInt64(100000000),
			if(number % 10 = 1, 'Error', 'Ok'), 1,
			map('deployment.environment', 'production', 'deployment.environment.name', 'production',
			'service.namespace', concat('ns-', toString(number % 2)), 'vcs.ref.head.revision', 'bench-commit')
			FROM numbers(50000)`,
			database,
		)
		for (const table of [
			"traces",
			"service_overview_spans",
			"service_overview_minutely",
			"service_overview_hourly",
		]) {
			const rows = Number(
				(
					await clickhouseExec(
						`SELECT count() FROM ${table} WHERE OrgId = 'org_benchmark_live'`,
						database,
					)
				).trim(),
			)
			assert.isAbove(rows, 0, `${table} has no seeded tenant rows`)
		}
		const options = {
			metric: "count",
			allMetrics: true,
			needsSampling: true,
			rootOnly: true,
			groupBy: ["service"],
			bucketSeconds: 300,
		} as const
		const raw = await Effect.runPromise(
			CH.compile(CH.tracesTimeseriesQuery({ ...options, overviewTiers: "hour" }), inputs),
		)
		const rollup = await Effect.runPromise(
			CH.compile(CH.tracesTimeseriesQuery({ ...options, overviewTiers: "minute" }), inputs),
		)
		const facets = await Effect.runPromise(CH.compileUnion(CH.servicesFacetsQuery(), inputs))
		assert.notInclude(raw.sql, "service_overview_minutely")
		assert.include(rollup.sql, "service_overview_minutely")
		const rows = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
			),
		)(await clickhouseExec(rollup.sql, database))
		const decoded = await Effect.runPromise(rollup.decodeRows(rows.data))
		assert.equal(
			decoded.reduce((sum, row) => sum + row.count, 0),
			40000,
			"The actual builder must count only the seeded tenant's 40,000 spans",
		)

		const makeSuite = (compiled: typeof raw): Suite => ({
			source: "populated-maple-e2e",
			samples: [
				caseFromCompiled("traces/overview/5m", compiled, { ...inputs, ...options }),
				caseFromCompiled("services/facets", facets, inputs),
			],
		})
		const baselineSuite = join(artifacts, "baseline-suite.json")
		const candidateSuite = join(artifacts, "candidate-suite.json")
		await writeFile(baselineSuite, JSON.stringify(makeSuite(raw)))
		await writeFile(candidateSuite, JSON.stringify(makeSuite(rollup)))
		const baselinePath = join(artifacts, "baseline.json")
		const candidatePath = join(artifacts, "candidate.json")
		const controls = [
			"--runs",
			"5",
			"--warmup",
			"1",
			"--threads",
			"2",
			"--verify-results",
			"--dataset",
			database,
			"--log-wait",
			"20",
		]
		for (const [label, suitePath, outputPath] of [
			["baseline", baselineSuite, baselinePath],
			["candidate", candidateSuite, candidatePath],
		]) {
			const run = await runCli(label, ["run", suitePath, ...controls, "--out", outputPath])
			assert.equal(run.code, 0, run.output)
			const report = Schema.decodeUnknownSync(Schema.fromJsonString(RunOutput))(
				await readFile(outputPath, "utf8"),
			)
			assert.lengthOf(report.results, 2)
			for (const result of report.results) {
				assert.lengthOf(result.runs, 5)
				for (const observation of result.runs) {
					assert.isAbove(observation.readRows ?? 0, 0, `${result.id}: no rows read`)
					assert.isAbove(observation.resultRows ?? 0, 0, `${result.id}: empty results`)
					assert.equal(observation.metricSource, "query_log", `${result.id}: query log missing`)
					assert.isAbove(observation.memoryUsage ?? 0, 0)
					assert.isAbove(Object.keys(observation.profileEvents).length, 0)
				}
			}
		}
		const comparisonPath = join(artifacts, "comparison.json")
		const comparison = await runCli("compare", [
			"compare",
			baselinePath,
			candidatePath,
			"--metric",
			"meanReadRows",
			"--fail-on-regression",
			"--out",
			comparisonPath,
		])
		assert.equal(comparison.code, 0, comparison.output)
		const before = Schema.decodeUnknownSync(Schema.fromJsonString(RunOutput))(
			await readFile(baselinePath, "utf8"),
		)
		const after = Schema.decodeUnknownSync(Schema.fromJsonString(RunOutput))(
			await readFile(candidatePath, "utf8"),
		)
		assert.isBelow(
			after.results[0]?.aggregates.meanReadRows ?? Infinity,
			before.results[0]?.aggregates.meanReadRows ?? 0,
			"The rollup must measurably read fewer rows than the raw fallback",
		)
		const reverse = await runCli("regression", [
			"compare",
			candidatePath,
			baselinePath,
			"--metric",
			"meanReadRows",
			"--fail-on-regression",
		])
		assert.equal(reverse.code, 1, reverse.output)
		assert.include(reverse.output, "regression")
		const inspected = await runCli("inspect", [
			"inspect",
			candidatePath,
			"--out",
			join(artifacts, "plans.json"),
		])
		assert.equal(inspected.code, 0, inspected.output)
		assert.include(inspected.output, "service_overview_minutely")
	}, 120_000)
})

// The SQL gate.
//
// Runs every SQL shape the product can emit through a real ClickHouse analyzer.
// This exists because query-engine's unit tests assert on SQL *text*, and text
// is not a contract the analyzer honours — `if(sum(Float64), …, sum(UInt64))`
// produced exactly the expected string, was rejected with `NO_COMMON_TYPE`, and
// took every main chart to a 502 while CI stayed green.
//
// `DESCRIBE (SELECT …)` type-checks without reading a row, so this is cheap:
// ~80 unique shapes, a few seconds on top of a job that already boots the
// server and replays the migrations.
//
// Covers both catalogs: `@maple/query-engine`'s own (pipes, query specs, core
// builders) and `@maple/query-engine-integrations`' (Cloudflare, PlanetScale,
// AI builders), which lives with those builders because the core package must
// not depend on the integrations package.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { collectSqlCatalog, dedupeByFingerprint } from "@maple/query-engine/sql-catalog"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { collectIntegrationCatalog } from "@maple/query-engine-integrations/catalog"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
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

const database = uniqueDatabase("maple_sql_catalog_e2e")

/** The subset of a catalog entry the sweep reads — the core and integration
 *  catalogs are separate types (`@maple/query-engine` must not import the
 *  integrations package), but both satisfy this shape. */
interface SweepEntry {
	readonly id: string
	readonly sql: string
	readonly compiled?: CompiledQuery<unknown>
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

/** Core catalog deduped so N fixtures over one shape cost one analyzer round
 *  trip; the integration catalog has no fingerprints and every fixture is a
 *  distinct shape, so it is appended as-is. */
const catalog: ReadonlyArray<SweepEntry> = [
	...dedupeByFingerprint(collectSqlCatalog()),
	...collectIntegrationCatalog(),
]

describe.skipIf(!clickhouseE2eEnabled)("SQL catalog analyzer sweep", () => {
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
					const decoded = await Effect.runPromise(Effect.exit(entry.compiled.decodeRows([row])))
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
					const decoded = await Effect.runPromise(
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
})

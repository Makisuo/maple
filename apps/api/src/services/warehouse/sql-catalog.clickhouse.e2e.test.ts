// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { collectSqlCatalog, dedupeByFingerprint } from "@maple/query-engine/sql-catalog"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	describeQuery,
	isSixtyFourBitInt,
	looksLikeIdentityColumn,
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

const database = uniqueDatabase("maple_sql_catalog_e2e")

/** Deduped so N fixtures over one shape cost one analyzer round trip. */
const catalog = dedupeByFingerprint(collectSqlCatalog())

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

			// Second class, same round trip: if the query declares a row schema, it
			// has to accept BOTH 64-bit wire shapes — unquoted is what the pinned
			// production clients receive, quoted is what a gateway/readonly cluster
			// that refuses the setting still sends. `CH.CHNumber` accepts both;
			// `Schema.Number` rejects the quoted shape.
			if (wideColumns.length > 0 && entry.compiled) {
				for (const quote64Bit of [false, true]) {
					const row = syntheticRow(columns, { quote64Bit })
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
			}
		}, 60_000)
	}
})

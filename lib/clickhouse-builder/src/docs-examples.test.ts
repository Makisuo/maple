// Executable documentation examples.
//
// Every non-trivial snippet in `docs/` lives here as a real test that compiles
// the query and asserts the emitted SQL. Test names match the docs page and
// heading they back, and each fenced block in the docs points here.
//
// This exists because the README once documented a `castRows` API that had been
// deleted and an `.orderBy("count", "desc")` call that silently compiled to
// `ORDER BY c O, d E`. Both survived review because nothing ever executed the
// docs. A snippet that stops compiling now fails the suite instead of shipping.
//
// When changing an example here, change the matching docs block in the same
// commit — the pairing is the whole point.

import type { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import * as CH from "./ch/index"
import * as T from "./ch/types"
import { parseStatement, renderStatement, withSettings } from "./sql/statement"
import { compileCHUnsafe, compileUnionUnsafe } from "./ch/compile"
import { raw as rawFragment, compile as compileFragment } from "./sql/sql-fragment"

/** The compiler emits multi-line SQL with leading indentation; docs quote it
 *  collapsed to one line for readability, so assertions compare it collapsed. */
const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim()

// Shared fixtures — the tables every docs page builds on.

const Events = CH.table(
	"events",
	{
		OrgId: T.string,
		Name: T.string,
		Timestamp: T.dateTime,
		DurationMs: T.uint64,
		Attributes: T.map(T.string, T.string),
	},
	{ tenantColumn: "OrgId" },
)

const Services = CH.table(
	"services",
	{ OrgId: T.string, Name: T.string, Team: T.string },
	{ tenantColumn: "OrgId" },
)

// README.md
//
// The README once documented a deleted API (see the header comment); its
// snippets are executable here for the same reason the docs pages are.

describe("README.md", () => {
	it("Quick start", () => {
		const query = CH.from(Events)
			.select(($) => ({
				name: $.Name,
				p95: CH.quantile(0.95)($.DurationMs),
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(CH.param.string("orgId")),
				$.Timestamp.gte(CH.param.dateTime("startTime")),
				CH.when(true, () => $.Name.like("checkout%")),
			])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(50)

		const compiled = compileCHUnsafe(query, { orgId: "org_123", startTime: "2026-01-01 00:00:00" })

		expect(oneLine(compiled.sql)).toBe(
			"SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, count() AS count " +
				"FROM events WHERE OrgId = 'org_123' AND Timestamp >= '2026-01-01 00:00:00' " +
				"AND Name LIKE 'checkout%' GROUP BY name ORDER BY count DESC LIMIT 50",
		)
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it.effect("Decoding results", () =>
		Effect.gen(function* () {
			const query = CH.from(Events)
				.select(($) => ({ name: $.Name, count: CH.count() }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
				.groupBy("name")

			const compiled = compileCHUnsafe(
				query,
				{ orgId: "org_123" },
				{ rowSchema: Schema.Struct({ name: Schema.String, count: Schema.Number }) },
			)

			expect(compiled.rowSchemaSource).toBe("declared")
			expect(yield* compiled.decodeRows([{ name: "checkout", count: 3 }])).toEqual([
				{ name: "checkout", count: 3 },
			])
		}),
	)

	it("Extending with custom functions", () => {
		const toStartOfFiveMinute = CH.defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>(
			"toStartOfFiveMinute",
			T.dateTime,
		)

		const query = CH.from(Events)
			.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("toStartOfFiveMinute(Timestamp) AS bucket")
	})
})

// getting-started.md

describe("docs/getting-started.md", () => {
	it("Your first query", () => {
		const query = CH.from(Events)
			.select(($) => ({
				name: $.Name,
				p95: CH.quantile(0.95)($.DurationMs),
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(CH.param.string("orgId")),
				$.Timestamp.gte(CH.param.dateTime("startTime")),
			])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(50)

		const compiled = CH.compileUnsafe(query, {
			orgId: "org_123",
			startTime: "2026-01-01 00:00:00",
		})

		expect(oneLine(compiled.sql)).toBe(
			"SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, count() AS count " +
				"FROM events WHERE OrgId = 'org_123' AND Timestamp >= '2026-01-01 00:00:00' " +
				"GROUP BY name ORDER BY count DESC LIMIT 50",
		)
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it.effect("Decoding the results", () =>
		Effect.gen(function* () {
			const compiled = CH.compileUnsafe(
				CH.from(Events)
					.select(($) => ({ name: $.Name, count: CH.count() }))
					.where(($) => [$.OrgId.eq("org_123")])
					.groupBy("name"),
				{},
				{
					rowSchema: Schema.Struct({
						name: Schema.String,
						count: Schema.Number,
					}),
				},
			)

			const rows = yield* compiled.decodeRows([{ name: "checkout", count: 3 }])

			expect(rows).toEqual([{ name: "checkout", count: 3 }])
			expect(compiled.rowSchemaSource).toBe("declared")
		}),
	)
})

// tables-and-types.md

describe("docs/tables-and-types.md", () => {
	it("Reading a Map column", () => {
		const query = CH.from(Events)
			.select(($) => ({ method: $.Attributes.get("http.method") }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toBe(
			"SELECT Attributes['http.method'] AS method FROM events WHERE OrgId = 'org_123'",
		)
	})

	it("Column types come from /types as a namespace", () => {
		// The docs tell you to `import * as T from ".../types"`. Every constructor
		// is on the root barrel too — this asserts the namespace form the docs
		// actually show, which is the one that has to keep working.
		const Counters = CH.table(
			"counters",
			{ OrgId: T.string, Hits: T.uint16, Live: T.bool },
			{ tenantColumn: "OrgId" },
		)

		const query = CH.from(Counters)
			.select(($) => ({ hits: $.Hits }))
			.where(($) => [$.OrgId.eq("org_123"), $.Live.eq(true)])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toBe(
			"SELECT Hits AS hits FROM counters WHERE OrgId = 'org_123' AND Live = 1",
		)
	})
})

// queries.md

describe("docs/queries.md", () => {
	it("select by column name", () => {
		const query = CH.from(Events).select("Name", "DurationMs")

		// Each column is aliased to itself, so output keys match column names.
		expect(oneLine(compileCHUnsafe(query, {}).sql)).toBe(
			"SELECT Name AS Name, DurationMs AS DurationMs FROM events",
		)
	})

	it("Queries are immutable", () => {
		const base = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const limited = base.limit(10)

		// `base` is untouched — `limit` returned a new query.
		expect(oneLine(compileCHUnsafe(base, {}).sql)).not.toContain("LIMIT")
		expect(oneLine(compileCHUnsafe(limited, {}).sql)).toContain("LIMIT 10")
	})

	it("orderBy takes tuples", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name, count: CH.count() }))
			.where(($) => [$.OrgId.eq("org_123")])
			.groupBy("name")
			.orderBy(["count", "desc"], ["name", "asc"])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("ORDER BY count DESC, name ASC")
	})

	it("orderBy rejects a bare string", () => {
		const query = CH.from(Events).select(($) => ({ name: $.Name }))

		// TypeScript rejects this; the runtime guard catches callers who bypass it.
		expect(() => compileCHUnsafe((query as any).orderBy("name", "desc"), {})).toThrow(
			/orderBy\(\) takes \[column, direction\] tuples/,
		)
	})
})

// expressions.md

describe("docs/expressions.md", () => {
	// ClickHouse renders `1/0` and `0/0` as JSON null, and `CHNumber` is
	// Schema.Finite-based — so a division has to decode the null it can produce.
	it.effect("division decodes nullably and ifNotFinite guards it", () =>
		Effect.gen(function* () {
			const unguarded = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ perMs: CH.count().div(CH.sum($.DurationMs)) }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)
			expect(yield* unguarded.decodeRows([{ perMs: null }])).toEqual([{ perMs: null }])

			const guarded = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ perMs: CH.ifNotFinite(CH.count().div(CH.sum($.DurationMs)), 0) }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)
			expect(oneLine(guarded.sql)).toContain("ifNotFinite(count() / sum(DurationMs), 0) AS perMs")
			// The guard is in the SQL, so the column is a number again.
			expect(Exit.isFailure(yield* Effect.exit(guarded.decodeRows([{ perMs: null }])))).toBe(true)

			// The other operators cannot manufacture a null from finite operands.
			const added = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ total: CH.count().add(CH.sum($.DurationMs)) }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)
			expect(Exit.isFailure(yield* Effect.exit(added.decodeRows([{ total: null }])))).toBe(true)
		}),
	)

	it("Optional predicates with when", () => {
		const build = (nameFilter?: string) =>
			CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(($) => [$.OrgId.eq("org_123"), CH.when(nameFilter, (n) => $.Name.eq(n))])

		expect(oneLine(compileCHUnsafe(build("checkout"), {}).sql)).toBe(
			"SELECT Name AS name FROM events WHERE OrgId = 'org_123' AND Name = 'checkout'",
		)
		// `undefined` drops the predicate entirely rather than emitting `AND true`.
		expect(oneLine(compileCHUnsafe(build(), {}).sql)).toBe(
			"SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
		)
	})

	it("Arithmetic does not parenthesise", () => {
		const query = CH.from(Events)
			.select(($) => ({ ratio: $.DurationMs.sub(1).div(2) }))
			.where(($) => [$.OrgId.eq("org_123")])

		// `a.sub(1).div(2)` is `a - 1 / 2`, i.e. `a - (1 / 2)` — NOT `(a - 1) / 2`.
		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("DurationMs - 1 / 2 AS ratio")
	})

	it("Combining conditions with and/or", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Name.eq("checkout").or($.Name.eq("cart"))])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("AND (Name = 'checkout' OR Name = 'cart')")
	})

	it("Conditional aggregation", () => {
		const query = CH.from(Events)
			.select(($) => ({
				total: CH.count(),
				slow: CH.countIf($.DurationMs.gt(1000)),
			}))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain(
			"count() AS total, countIf(DurationMs > 1000) AS slow",
		)
	})
})

// joins-and-subqueries.md

describe("docs/joins-and-subqueries.md", () => {
	// The claim the guide makes for these three over `compileUnsafe(inner).sql`:
	// the inner query is compiled by the OUTER compile, so its params resolve
	// from the outer set and its failures land in the outer error channel.
	it.effect("subqueryExpr splices an inner query, compiled by the outer compile", () =>
		Effect.gen(function* () {
			const cheapScan = CH.from(Events)
				.select(($) => ({ ts: $.Timestamp }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
				.orderBy(["ts", "desc"])
				.limit(100)

			const cutoff = CH.subqueryExpr(cheapScan, T.dateTime, (sql) => `(SELECT min(ts) FROM (${sql}))`)
			const compiled = yield* CH.compile(
				CH.from(Events)
					.select(($) => ({ name: $.Name }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Timestamp.gte(cutoff)]),
				{ orgId: "org_123" },
			)

			expect(oneLine(compiled.sql)).toContain("Timestamp >= (SELECT min(ts) FROM (")
			// One param, passed once, resolved in both halves by the outer pass.
			expect(compiled.sql).not.toContain("__PARAM_")
			expect(compiled.sql.match(/OrgId = 'org_123'/g)).toHaveLength(2)

			// And the failure lands in the outer compile rather than throwing out
			// of the function that built the expression.
			const bad = CH.subqueryExpr(
				CH.from(Events)
					.select(($) => ({ ts: $.Timestamp }))
					.where(($) => [$.DurationMs.eq("lots" as never)]),
				T.dateTime,
			)
			const error = yield* Effect.flip(
				CH.compile(
					CH.from(Events)
						.select(($) => ({ name: $.Name }))
						.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.gte(bad)]),
					{},
				),
			)
			expect(error.code).toBe("InvalidLiteral")
		}),
	)

	it("Joining a table", () => {
		const query = CH.from(Events, "e")
			.innerJoin(Services, "s", (main, joined) => main.Name.eq(joined.Name))
			.select(($) => ({ name: $.Name, team: $.s.Team }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toBe(
			"SELECT e.Name AS name, s.Team AS team FROM events AS e " +
				"INNER JOIN services AS s ON e.Name = s.Name WHERE e.OrgId = 'org_123'",
		)
	})

	it("Subquery in FROM uses flat accessors", () => {
		const inner = CH.from(Events)
			.select(($) => ({ name: $.Name, ms: $.DurationMs }))
			.where(($) => [$.OrgId.eq("org_123")])

		// NOTE: columns of the subquery are accessed FLAT (`$.name`), not under
		// the alias (`$.sub.name`) — the alias only names the derived table.
		const outer = CH.fromQuery(inner, "sub")
			.select(($) => ({ name: $.name, worst: CH.max($.ms) }))
			.groupBy("name")

		expect(oneLine(compileCHUnsafe(outer, {}).sql)).toBe(
			"SELECT name AS name, max(ms) AS worst FROM (SELECT Name AS name, DurationMs AS ms " +
				"FROM events WHERE OrgId = 'org_123') AS sub GROUP BY name",
		)
	})

	it("Joining a subquery", () => {
		const perTeam = CH.from(Services)
			.select(($) => ({ name: $.Name, team: $.Team }))
			.where(($) => [$.OrgId.eq("org_123")])

		const query = CH.from(Events, "e")
			.innerJoinQuery(perTeam, "s", (main, joined) => main.Name.eq(joined.name))
			.select(($) => ({ team: $.s.team }))

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain(
			"INNER JOIN (SELECT Name AS name, Team AS team FROM services " +
				"WHERE OrgId = 'org_123') AS s ON e.Name = s.name",
		)
	})

	it("Correlated subquery with outerRef", () => {
		const inner = CH.from(Events)
			.select(($) => ({ n: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Name.eq(CH.outerRef("s.Name"))])

		const query = CH.from(Services, "s")
			.select(($) => ({ team: $.Team }))
			.where(($) => [$.OrgId.eq("org_123"), CH.exists(inner)])

		const sql = oneLine(compileCHUnsafe(query, {}).sql)
		expect(sql).toContain("EXISTS (")
		expect(sql).toContain("Name = s.Name")
	})

	it("notInSubquery splices a query and resolves its params from the outer set", () => {
		const excluded = CH.from(Events)
			.select(($) => ({ n: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		const query = CH.from(Services, "s")
			.select(($) => ({ team: $.Team }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), CH.notInSubquery($.Team, excluded)])

		const sql = oneLine(compileCHUnsafe(query, { orgId: "org_123" }).sql)
		expect(sql).toContain("Team NOT IN (SELECT Name AS n FROM events WHERE OrgId = 'org_123')")
		expect(sql).not.toContain("__PARAM_")
	})

	it("A subquery does not scope its outer query", () => {
		const scopedInner = CH.from(Events)
			.select(($) => ({ n: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const query = CH.from(Services, "s")
			.select(($) => ({ team: $.Team }))
			.where(($) => [CH.inSubquery($.Team, scopedInner)])

		// The inner filter confines the subquery, not the outer scan.
		expect(compileCHUnsafe(query, {}).tenantScope).toBe("cross-tenant")
	})

	it("A scoped subquery keeps the outer query scoped", () => {
		const inner = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const outer = CH.fromQuery(inner, "sub").select(($) => ({ name: $.name }))

		expect(compileCHUnsafe(outer, {}).tenantScope).toBe("single-tenant")
	})
})

// unions-and-ctes.md

describe("docs/unions-and-ctes.md", () => {
	it("unionAll with an outer ORDER BY", () => {
		const recent = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.gte("2026-01-01 00:00:00")])

		const archived = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.lt("2026-01-01 00:00:00")])

		const combined = CH.unionAll(recent, archived).orderBy(["name", "asc"]).limit(100)

		const sql = oneLine(compileUnionUnsafe(combined, {}).sql)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("ORDER BY name ASC LIMIT 100")
	})

	it("fromUnion aggregates across branches", () => {
		const branch = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const combined = CH.unionAll(branch, branch)

		const outer = CH.fromUnion(combined, "branches")
			.select(($) => ({ name: $.name, total: CH.count() }))
			.groupBy("name")

		const compiled = compileCHUnsafe(outer, {})
		expect(oneLine(compiled.sql)).toContain(") AS branches GROUP BY name")
		// A union of scoped branches keeps the outer query scoped.
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it("Selecting from a CTE", () => {
		// To read a CTE, declare a table whose name matches it and start there.
		const Recent = CH.table("recent", { Name: T.string })

		const cte = CH.from(Events)
			.select(($) => ({ Name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const query = CH.from(Recent)
			.withCTE("recent", cte)
			.select(($) => ({ name: $.Name }))

		const compiled = compileCHUnsafe(query, {})
		expect(oneLine(compiled.sql)).toBe(
			"WITH recent AS ( SELECT Name AS Name FROM events WHERE OrgId = 'org_123' ) " +
				"SELECT Name AS name FROM recent",
		)
		// Derived off the CTE — the outer query has no OrgId predicate of its own.
		expect(compiled.tenantScope).toBe("single-tenant")
	})

	it("A CTE needs its tenantScope declared", () => {
		const Recent = CH.table("recent", { Name: T.string })
		const cteSql = "SELECT Name FROM events WHERE OrgId = 'org_123'"

		const declared = CH.from(Recent)
			.withCTE("recent", cteSql, { tenantScope: "single-tenant" })
			.select(($) => ({ name: $.Name }))

		const undeclared = CH.from(Recent)
			.withCTE("recent", cteSql)
			.select(($) => ({ name: $.Name }))

		// The CTE body is an opaque string, so the declaration is the only thing
		// that can carry its scope. Omit it and the query reads as cross-tenant even
		// though the SQL filters OrgId.
		expect(compileCHUnsafe(declared, {}).tenantScope).toBe("single-tenant")
		expect(compileCHUnsafe(undeclared, {}).tenantScope).toBe("cross-tenant")
	})
})

// params-and-compilation.md

describe("docs/params-and-compilation.md", () => {
	it("Params are resolved at compile time", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		// The value lands in the SQL text — this is not server-side binding.
		expect(oneLine(compileCHUnsafe(query, { orgId: "org_123" }).sql)).toContain("OrgId = 'org_123'")
	})

	it("String params are escaped", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		expect(oneLine(compileCHUnsafe(query, { orgId: "a'b\\c" }).sql)).toContain("OrgId = 'a\\'b\\\\c'")
	})

	it("One query, many parameter sets", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		expect(oneLine(compileCHUnsafe(query, { orgId: "org_a" }).sql)).toContain("'org_a'")
		expect(oneLine(compileCHUnsafe(query, { orgId: "org_b" }).sql)).toContain("'org_b'")
	})
})

// decoding-results.md

describe("docs/decoding-results.md", () => {
	const rowSchema = Schema.Struct({
		name: Schema.String,
		count: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
	})

	const compiled = () =>
		CH.compileUnsafe(
			CH.from(Events)
				.select(($) => ({ name: $.Name, count: CH.count() }))
				.where(($) => [$.OrgId.eq("org_123")])
				.groupBy("name"),
			{},
			{ rowSchema },
		)

	it.effect("decodeRows validates every row", () =>
		Effect.gen(function* () {
			// `count` arrives quoted from some backends; the schema accepts both.
			const rows = yield* compiled().decodeRows([{ name: "checkout", count: "42" }])

			expect(rows).toEqual([{ name: "checkout", count: 42 }])
		}),
	)

	it.effect("decodeFirstRow returns an Option", () =>
		Effect.gen(function* () {
			const first = yield* compiled().decodeFirstRow([{ name: "checkout", count: 42 }])
			const empty = yield* compiled().decodeFirstRow([])

			expect(Option.getOrNull(first)).toEqual({ name: "checkout", count: 42 })
			expect(Option.isNone(empty)).toBe(true)
		}),
	)

	it.effect("A bad row fails with CompiledQueryDecodeError", () =>
		Effect.gen(function* () {
			const result = yield* Effect.flip(compiled().decodeRows([{ name: 42, count: 1 }]))

			expect(result._tag).toBe("@maple-dev/clickhouse-builder/CompiledQueryDecodeError")
			expect(result.rowIndex).toBe(0)
		}),
	)

	it.effect("The row schema is derived from the SELECT", () =>
		Effect.gen(function* () {
			const derived = CH.compileUnsafe(
				CH.from(Events)
					.select(($) => ({ name: $.Name, calls: CH.count() }))
					.where(($) => [$.OrgId.eq("org_123")])
					.groupBy("name"),
				{},
			)

			expect(derived.rowSchemaSource).toBe("derived")
			// `count()` is a UInt64: quoted by ClickHouse, bare when the client sets
			// output_format_json_quote_64bit_integers=0, and
			// the column type knows it either way.
			expect(yield* derived.decodeRows([{ name: "checkout", calls: "42" }])).toEqual([
				{ name: "checkout", calls: 42 },
			])
		}),
	)

	it.effect("An untyped expression leaves the query undecoded", () =>
		Effect.gen(function* () {
			const noSchema = CH.compileUnsafe(
				CH.from(Events)
					.select(($) => ({ name: $.Name, odd: CH.untypedExpr("anyLast(Whatever)") }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)

			expect(noSchema.rowSchemaSource).toBe("none")
			// And it names the alias responsible, so the fix is one column away.
			expect(noSchema.untypedColumns).toEqual(["odd"])
			// Nothing is validated — the wrong-typed value passes straight through.
			expect(yield* noSchema.decodeRows([{ name: 42, odd: 1 }])).toEqual([{ name: 42, odd: 1 }])
		}),
	)

	// docs/decoding-results.md > "Going back to the wire"
	it.effect("Rows go back to the wire through the same schema", () =>
		Effect.gen(function* () {
			const compiled = CH.compileUnsafe(
				CH.from(Events)
					.select(($) => ({ at: $.Timestamp, name: $.Name }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)

			const wire = [{ at: "2026-05-24 14:30:00", name: "checkout" }]
			const rows = yield* compiled.decodeRows(wire)
			expect(yield* compiled.encodeRows(rows)).toEqual(wire)
		}),
	)
})

// tenant-scoping.md

describe("docs/tenant-scoping.md", () => {
	it("An OrgId equality scopes the query", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(compileCHUnsafe(query, {}).tenantScope).toBe("single-tenant")
	})

	it("in_ also scopes; neq does not", () => {
		const scoped = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.in_("org_a", "org_b")])

		const unscoped = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.neq("org_123")])

		expect(compileCHUnsafe(scoped, {}).tenantScope).toBe("single-tenant")
		// `OrgId != 'x'` narrows nothing, so it must not read as scoped.
		expect(compileCHUnsafe(unscoped, {}).tenantScope).toBe("cross-tenant")
	})

	it("The marker does not survive or()", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123").or($.Name.eq("checkout"))])

		// `OrgId = x OR anything` can match other tenants' rows.
		expect(compileCHUnsafe(query, {}).tenantScope).toBe("cross-tenant")
	})

	it("A table without a declared tenant column is untenanted", () => {
		const Untenanted = CH.table("untenanted", { tenant_id: T.string, Name: T.string })

		const query = CH.from(Untenanted)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.tenant_id.eq("org_123")])

		// Nothing declared row-level tenancy, so there is nothing to pin — and
		// nothing to leak either, which is why this is not `"cross-tenant"`.
		expect(compileCHUnsafe(query, {}).tenantScope).toBe("untenanted")
	})

	it("Declare the tenant column", () => {
		const Tenanted = CH.table(
			"tenanted",
			{ tenant_id: T.string, Name: T.string },
			{ tenantColumn: "tenant_id" },
		)

		const query = CH.from(Tenanted)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.tenant_id.eq("org_123")])

		expect(compileCHUnsafe(query, {}).tenantScope).toBe("single-tenant")
	})

	it("crossTenant() is the explicit opt-out", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])
			.crossTenant()

		// Explicit intent wins over the inferred scope.
		expect(compileCHUnsafe(query, {}).tenantScope).toBe("cross-tenant")
	})

	it("route is carried onto the compiled query", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])
			.route("archive")

		expect(compileCHUnsafe(query, {}).route).toBe("archive")
	})
})

// reference.md

describe("docs/reference.md", () => {
	it("Window functions", () => {
		const query = CH.from(Events)
			.select(($) => ({
				name: $.Name,
				previous: CH.over(
					CH.lagInFrame($.DurationMs, 1, 0),
					CH.windowSpec({
						partitionBy: [$.Name],
						orderBy: [[$.Timestamp, "asc"]],
						frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
					}),
				),
			}))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain(
			"lagInFrame(DurationMs, 1, 0) OVER (PARTITION BY Name ORDER BY Timestamp ASC " +
				"ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS previous",
		)
	})
})

// extending.md

describe("docs/extending.md", () => {
	it("defineFn declares a missing function", () => {
		const toStartOfFiveMinute = CH.defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>(
			"toStartOfFiveMinute",
			T.dateTime,
		)

		const query = CH.from(Events)
			.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("toStartOfFiveMinute(Timestamp) AS bucket")
	})

	// docs/extending.md > "Results that depend on the arguments"
	it("a result rule reads the type off an argument", () => {
		const anyLast = CH.defineFn<[CH.Expr<string>], string>("anyLast", CH.sameAs(0))

		const compiled = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ last: anyLast($.Name) }))
				.where(($) => [$.OrgId.eq("org_123")]),
			{},
		)

		// `anyLast` declared no type of its own, and the query still decodes:
		// the rule says the result is whatever `Name` is.
		expect(compiled.rowSchemaSource).toBe("derived")
		expect(oneLine(compiled.sql)).toContain("anyLast(Name) AS last")
	})

	it("defineCondFn declares a predicate", () => {
		const matchesRegex = CH.defineCondFn<[CH.Expr<string>, string]>("match")

		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), matchesRegex($.Name, "^checkout")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("match(Name, '^checkout')")
	})

	it("rawExpr and rawCond are the last resort", () => {
		const query = CH.from(Events)
			.select(($) => ({ odd: CH.rawExpr("DurationMs % 2", T.float64) }))
			.where(($) => [$.OrgId.eq("org_123"), CH.rawCond("Name GLOBAL IN (SELECT 1)")])

		const sql = oneLine(compileCHUnsafe(query, {}).sql)
		expect(sql).toContain("DurationMs % 2 AS odd")
		expect(sql).toContain("Name GLOBAL IN (SELECT 1)")
	})

	it("compileFnCall handles variadic shapes", () => {
		const greatestOf = <T>(...exprs: CH.Expr<T>[]) => CH.compileFnCall<T>("greatest", ...exprs)

		const query = CH.from(Events)
			.select(($) => ({ worst: greatestOf($.DurationMs, CH.lit(100)) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("greatest(DurationMs, 100) AS worst")
	})

	it("makeExpr builds custom call syntax", () => {
		const quantileExact = (q: number) => (expr: CH.Expr<number>) =>
			CH.makeExpr<number>(
				rawFragment(`quantileExact(${q})(${compileFragment(expr.toFragment())})`),
				T.float64.schema,
			)

		const query = CH.from(Events)
			.select(($) => ({ p99: quantileExact(0.99)($.DurationMs) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCHUnsafe(query, {}).sql)).toContain("quantileExact(0.99)(DurationMs) AS p99")
	})

	it.effect("rawCompiledQuery wraps handwritten SQL", () =>
		Effect.gen(function* () {
			const compiled = CH.rawCompiledQuery<{ readonly name: string }>({
				sql: "SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
				reason: "user-authored-sql",
				justification: "The SQL came from a user; there is no AST to build.",
				// Cannot be inferred from a raw string — the caller must assert it.
				tenantScope: "single-tenant",
				rowSchema: Schema.Struct({ name: Schema.String }),
			})

			expect(yield* compiled.decodeRows([{ name: "checkout" }])).toEqual([{ name: "checkout" }])
			expect(compiled.tenantScope).toBe("single-tenant")
		}),
	)
})

describe("docs/running-queries.md", () => {
	const Events = CH.table("events", { OrgId: T.string, Name: T.string }, { tenantColumn: "OrgId" })

	// The reason the guide tells you not to append `SETTINGS …` by hand: a query
	// that already carries a FORMAT clause ends up with the two in the order
	// ClickHouse rejects.
	it("SETTINGS precede FORMAT whatever order you add them in", () => {
		const compiled = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(($) => [$.OrgId.eq("org_123")])
				.format("JSON"),
			{},
		)

		const statement = withSettings(parseStatement(compiled.sql), "SETTINGS max_execution_time = 30")

		expect(statement.text.endsWith("SETTINGS max_execution_time = 30\nFORMAT JSON")).toBe(true)
		// Total: a statement with no terminal clauses round-trips unchanged.
		expect(renderStatement(parseStatement("SELECT 1")).trim()).toBe("SELECT 1")
	})
})

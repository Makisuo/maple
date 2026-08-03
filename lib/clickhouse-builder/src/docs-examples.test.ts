// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import * as CH from "./ch/index"
import * as T from "./ch/types"
import { compileCH, compileUnion } from "./ch/compile"
import { raw as rawFragment, compile as compileFragment } from "./sql/sql-fragment"

/** The compiler emits multi-line SQL with leading indentation; docs quote it
 *  collapsed to one line for readability, so assertions compare it collapsed. */
const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim()

// ---------------------------------------------------------------------------
// Shared fixtures — the tables every docs page builds on.
// ---------------------------------------------------------------------------

const Events = CH.table("events", {
	OrgId: T.string,
	Name: T.string,
	Timestamp: T.dateTime,
	DurationMs: T.uint64,
	Attributes: T.map(T.string, T.string),
})

const Services = CH.table("services", {
	OrgId: T.string,
	Name: T.string,
	Team: T.string,
})

// ---------------------------------------------------------------------------
// getting-started.md
// ---------------------------------------------------------------------------

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

		const compiled = CH.compile(query, {
			orgId: "org_123",
			startTime: "2026-01-01 00:00:00",
		})

		expect(oneLine(compiled.sql)).toBe(
			"SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, count() AS count " +
				"FROM events WHERE OrgId = 'org_123' AND Timestamp >= '2026-01-01 00:00:00' " +
				"GROUP BY name ORDER BY count DESC LIMIT 50",
		)
		expect(compiled.tenantScope).toBe("org")
	})

	it.effect("Decoding the results", () =>
		Effect.gen(function* () {
			const compiled = CH.compile(
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
			expect(compiled.rowSchemaDeclared).toBe(true)
		}),
	)
})

// ---------------------------------------------------------------------------
// tables-and-types.md
// ---------------------------------------------------------------------------

describe("docs/tables-and-types.md", () => {
	it("Reading a Map column", () => {
		const query = CH.from(Events)
			.select(($) => ({ method: $.Attributes.get("http.method") }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toBe(
			"SELECT Attributes['http.method'] AS method FROM events WHERE OrgId = 'org_123'",
		)
	})

	it("Types outside the curated barrel come from /types", () => {
		// `uint16`/`uint32`/`int32`/`bool` are not re-exported from the root
		// entry point — the docs say to reach for `/types` for these.
		const Counters = CH.table("counters", { OrgId: T.string, Hits: T.uint16, Live: T.bool })

		const query = CH.from(Counters)
			.select(($) => ({ hits: $.Hits }))
			.where(($) => [$.OrgId.eq("org_123"), $.Live.eq(true)])

		expect(oneLine(compileCH(query, {}).sql)).toBe(
			"SELECT Hits AS hits FROM counters WHERE OrgId = 'org_123' AND Live = 1",
		)
	})
})

// ---------------------------------------------------------------------------
// queries.md
// ---------------------------------------------------------------------------

describe("docs/queries.md", () => {
	it("select by column name", () => {
		const query = CH.from(Events).select("Name", "DurationMs")

		// Each column is aliased to itself, so output keys match column names.
		expect(oneLine(compileCH(query, {}).sql)).toBe(
			"SELECT Name AS Name, DurationMs AS DurationMs FROM events",
		)
	})

	it("Queries are immutable", () => {
		const base = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const limited = base.limit(10)

		// `base` is untouched — `limit` returned a new query.
		expect(oneLine(compileCH(base, {}).sql)).not.toContain("LIMIT")
		expect(oneLine(compileCH(limited, {}).sql)).toContain("LIMIT 10")
	})

	it("orderBy takes tuples", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name, count: CH.count() }))
			.where(($) => [$.OrgId.eq("org_123")])
			.groupBy("name")
			.orderBy(["count", "desc"], ["name", "asc"])

		expect(oneLine(compileCH(query, {}).sql)).toContain("ORDER BY count DESC, name ASC")
	})

	it("orderBy rejects a bare string", () => {
		const query = CH.from(Events).select(($) => ({ name: $.Name }))

		// TypeScript rejects this; the runtime guard catches callers who bypass it.
		expect(() => compileCH((query as any).orderBy("name", "desc"), {})).toThrow(
			/orderBy\(\) takes \[column, direction\] tuples/,
		)
	})
})

// ---------------------------------------------------------------------------
// expressions.md
// ---------------------------------------------------------------------------

describe("docs/expressions.md", () => {
	it("Optional predicates with when", () => {
		const build = (nameFilter?: string) =>
			CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(($) => [$.OrgId.eq("org_123"), CH.when(nameFilter, (n) => $.Name.eq(n))])

		expect(oneLine(compileCH(build("checkout"), {}).sql)).toBe(
			"SELECT Name AS name FROM events WHERE OrgId = 'org_123' AND Name = 'checkout'",
		)
		// `undefined` drops the predicate entirely rather than emitting `AND true`.
		expect(oneLine(compileCH(build(), {}).sql)).toBe(
			"SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
		)
	})

	it("Arithmetic does not parenthesise", () => {
		const query = CH.from(Events)
			.select(($) => ({ ratio: $.DurationMs.sub(1).div(2) }))
			.where(($) => [$.OrgId.eq("org_123")])

		// `a.sub(1).div(2)` is `a - 1 / 2`, i.e. `a - (1 / 2)` — NOT `(a - 1) / 2`.
		expect(oneLine(compileCH(query, {}).sql)).toContain("DurationMs - 1 / 2 AS ratio")
	})

	it("Combining conditions with and/or", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Name.eq("checkout").or($.Name.eq("cart"))])

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"AND (Name = 'checkout' OR Name = 'cart')",
		)
	})

	it("Conditional aggregation", () => {
		const query = CH.from(Events)
			.select(($) => ({
				total: CH.count(),
				slow: CH.countIf($.DurationMs.gt(1000)),
			}))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"count() AS total, countIf(DurationMs > 1000) AS slow",
		)
	})
})

// ---------------------------------------------------------------------------
// joins-and-subqueries.md
// ---------------------------------------------------------------------------

describe("docs/joins-and-subqueries.md", () => {
	it("Joining a table", () => {
		const query = CH.from(Events, "e")
			.innerJoin(Services, "s", (main, joined) => main.Name.eq(joined.Name))
			.select(($) => ({ name: $.Name, team: $.s.Team }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toBe(
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

		expect(oneLine(compileCH(outer, {}).sql)).toBe(
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

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"INNER JOIN (SELECT Name AS name, Team AS team FROM services " +
				"WHERE OrgId = 'org_123') AS s ON e.Name = s.name",
		)
	})

	it("Correlated subquery with outerRef", () => {
		const inner = CH.compile(
			CH.from(Events)
				.select(($) => ({ n: $.Name }))
				.where(($) => [$.OrgId.eq("org_123"), $.Name.eq(CH.outerRef("s.Name"))]),
			{},
		)

		const query = CH.from(Services, "s")
			.select(($) => ({ team: $.Team }))
			.where(($) => [$.OrgId.eq("org_123"), CH.exists(inner.sql)])

		const sql = oneLine(compileCH(query, {}).sql)
		expect(sql).toContain("EXISTS (")
		expect(sql).toContain("Name = s.Name")
	})

	it("A scoped subquery keeps the outer query scoped", () => {
		const inner = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		const outer = CH.fromQuery(inner, "sub").select(($) => ({ name: $.name }))

		expect(compileCH(outer, {}).tenantScope).toBe("org")
	})
})

// ---------------------------------------------------------------------------
// unions-and-ctes.md
// ---------------------------------------------------------------------------

describe("docs/unions-and-ctes.md", () => {
	it("unionAll with an outer ORDER BY", () => {
		const recent = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.gte("2026-01-01 00:00:00")])

		const archived = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.lt("2026-01-01 00:00:00")])

		const combined = CH.unionAll(recent, archived).orderBy(["name", "asc"]).limit(100)

		const sql = oneLine(compileUnion(combined, {}).sql)
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

		const compiled = compileCH(outer, {})
		expect(oneLine(compiled.sql)).toContain(") AS branches GROUP BY name")
		// A union of scoped branches keeps the outer query scoped.
		expect(compiled.tenantScope).toBe("org")
	})

	it("Selecting from a CTE", () => {
		// To read a CTE, declare a table whose name matches it and start there.
		const Recent = CH.table("recent", { Name: T.string })
		const cteSql = "SELECT Name FROM events WHERE OrgId = 'org_123'"

		const query = CH.from(Recent)
			.withCTE("recent", cteSql, { tenantScope: "org" })
			.select(($) => ({ name: $.Name }))

		expect(oneLine(compileCH(query, {}).sql)).toBe(
			`WITH recent AS ( ${cteSql} ) SELECT Name AS name FROM recent`,
		)
	})

	it("A CTE needs its tenantScope declared", () => {
		const Recent = CH.table("recent", { Name: T.string })
		const cteSql = "SELECT Name FROM events WHERE OrgId = 'org_123'"

		const declared = CH.from(Recent)
			.withCTE("recent", cteSql, { tenantScope: "org" })
			.select(($) => ({ name: $.Name }))

		const undeclared = CH.from(Recent)
			.withCTE("recent", cteSql)
			.select(($) => ({ name: $.Name }))

		// The CTE body is an opaque string, so the declaration is the only thing
		// that can carry its scope. Omit it and the query reads as cross-org even
		// though the SQL filters OrgId.
		expect(compileCH(declared, {}).tenantScope).toBe("org")
		expect(compileCH(undeclared, {}).tenantScope).toBe("cross-org")
	})
})

// ---------------------------------------------------------------------------
// params-and-compilation.md
// ---------------------------------------------------------------------------

describe("docs/params-and-compilation.md", () => {
	it("Params are resolved at compile time", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		// The value lands in the SQL text — this is not server-side binding.
		expect(oneLine(compileCH(query, { orgId: "org_123" }).sql)).toContain("OrgId = 'org_123'")
	})

	it("String params are escaped", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		expect(oneLine(compileCH(query, { orgId: "a'b\\c" }).sql)).toContain("OrgId = 'a\\'b\\\\c'")
	})

	it("One query, many parameter sets", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

		expect(oneLine(compileCH(query, { orgId: "org_a" }).sql)).toContain("'org_a'")
		expect(oneLine(compileCH(query, { orgId: "org_b" }).sql)).toContain("'org_b'")
	})
})

// ---------------------------------------------------------------------------
// decoding-results.md
// ---------------------------------------------------------------------------

describe("docs/decoding-results.md", () => {
	const rowSchema = Schema.Struct({
		name: Schema.String,
		count: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
	})

	const compiled = () =>
		CH.compile(
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

	it.effect("Without a rowSchema decoding is a pass-through", () =>
		Effect.gen(function* () {
			const noSchema = CH.compile(
				CH.from(Events)
					.select(($) => ({ name: $.Name }))
					.where(($) => [$.OrgId.eq("org_123")]),
				{},
			)

			expect(noSchema.rowSchemaDeclared).toBe(false)
			// Nothing is validated — the wrong-typed value passes straight through.
			expect(yield* noSchema.decodeRows([{ name: 42 }])).toEqual([{ name: 42 }])
		}),
	)
})

// ---------------------------------------------------------------------------
// tenant-scoping.md
// ---------------------------------------------------------------------------

describe("docs/tenant-scoping.md", () => {
	it("An OrgId equality scopes the query", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(compileCH(query, {}).tenantScope).toBe("org")
	})

	it("in_ also scopes; neq does not", () => {
		const scoped = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.in_("org_a", "org_b")])

		const unscoped = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.neq("org_123")])

		expect(compileCH(scoped, {}).tenantScope).toBe("org")
		// `OrgId != 'x'` narrows nothing, so it must not read as scoped.
		expect(compileCH(unscoped, {}).tenantScope).toBe("cross-org")
	})

	it("The marker does not survive or()", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123").or($.Name.eq("checkout"))])

		// `OrgId = x OR anything` can match other tenants' rows.
		expect(compileCH(query, {}).tenantScope).toBe("cross-org")
	})

	it("A column named anything else does not scope", () => {
		const Tenanted = CH.table("tenanted", { tenant_id: T.string, Name: T.string })

		const query = CH.from(Tenanted)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.tenant_id.eq("org_123")])

		// The tenant column name is currently hardcoded to `OrgId`.
		expect(compileCH(query, {}).tenantScope).toBe("cross-org")
	})

	it("crossOrg() is the explicit opt-out", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])
			.crossOrg()

		// Explicit intent wins over the inferred scope.
		expect(compileCH(query, {}).tenantScope).toBe("cross-org")
	})

	it("routing is carried onto the compiled query", () => {
		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123")])
			.routing("ingest")

		expect(compileCH(query, {}).routing).toBe("ingest")
	})
})

// ---------------------------------------------------------------------------
// reference.md
// ---------------------------------------------------------------------------

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

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"lagInFrame(DurationMs, 1, 0) OVER (PARTITION BY Name ORDER BY Timestamp ASC " +
				"ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS previous",
		)
	})
})

// ---------------------------------------------------------------------------
// extending.md
// ---------------------------------------------------------------------------

describe("docs/extending.md", () => {
	it("defineFn declares a missing function", () => {
		const toStartOfFiveMinute = CH.defineFn<[CH.Expr<string>], string>("toStartOfFiveMinute")

		const query = CH.from(Events)
			.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"toStartOfFiveMinute(Timestamp) AS bucket",
		)
	})

	it("defineCondFn declares a predicate", () => {
		const matchesRegex = CH.defineCondFn<[CH.Expr<string>, string]>("match")

		const query = CH.from(Events)
			.select(($) => ({ name: $.Name }))
			.where(($) => [$.OrgId.eq("org_123"), matchesRegex($.Name, "^checkout")])

		expect(oneLine(compileCH(query, {}).sql)).toContain("match(Name, '^checkout')")
	})

	it("rawExpr and rawCond are the last resort", () => {
		const query = CH.from(Events)
			.select(($) => ({ odd: CH.rawExpr<number>("DurationMs % 2") }))
			.where(($) => [$.OrgId.eq("org_123"), CH.rawCond("Name GLOBAL IN (SELECT 1)")])

		const sql = oneLine(compileCH(query, {}).sql)
		expect(sql).toContain("DurationMs % 2 AS odd")
		expect(sql).toContain("Name GLOBAL IN (SELECT 1)")
	})

	it("compileFnCall handles variadic shapes", () => {
		const greatestOf = <T>(...exprs: CH.Expr<T>[]) => CH.compileFnCall<T>("greatest", ...exprs)

		const query = CH.from(Events)
			.select(($) => ({ worst: greatestOf($.DurationMs, CH.lit(100)) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toContain("greatest(DurationMs, 100) AS worst")
	})

	it("makeExpr builds custom call syntax", () => {
		const quantileExact = (q: number) => (expr: CH.Expr<number>) =>
			CH.makeExpr<number>(rawFragment(`quantileExact(${q})(${compileFragment(expr.toFragment())})`))

		const query = CH.from(Events)
			.select(($) => ({ p99: quantileExact(0.99)($.DurationMs) }))
			.where(($) => [$.OrgId.eq("org_123")])

		expect(oneLine(compileCH(query, {}).sql)).toContain(
			"quantileExact(0.99)(DurationMs) AS p99",
		)
	})

	it.effect("unsafeCompiledQuery wraps handwritten SQL", () =>
		Effect.gen(function* () {
			const compiled = CH.unsafeCompiledQuery<{ readonly name: string }>({
				sql: "SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
				// Cannot be inferred from a raw string — the caller must assert it.
				tenantScope: "org",
				rowSchema: Schema.Struct({ name: Schema.String }),
			})

			expect(yield* compiled.decodeRows([{ name: "checkout" }])).toEqual([{ name: "checkout" }])
			expect(compiled.tenantScope).toBe("org")
		}),
	)
})

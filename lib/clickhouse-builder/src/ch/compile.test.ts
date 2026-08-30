import { describe, expect, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Option, Result, Schema } from "effect"
import {
	CompiledQueryDecodeError,
	compileCHUnsafe,
	compileUnionUnsafe,
	rawCompiledQuery,
} from "./compile"
import * as CH from "./index"
import * as T from "./types"

const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

describe("CompiledQuery.decodeRows", () => {
	// A `UInt64` reaches the client quoted or bare depending on the backend, and
	// that is modelled in the column type — so this decodes without anyone
	// writing a schema, which is the whole reason the column types are schemas.
	it.effect("derives the row schema from the selected columns", () =>
		Effect.gen(function* () {
			const table = CH.table(
				"events",
				{ OrgId: CH.string, Count: CH.uint64 },
				{ tenantColumn: "OrgId" },
			)
			const compiled = compileCHUnsafe(
				CH.from(table)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)

			expect(compiled.rowSchemaSource).toBe("derived")
			expect(yield* compiled.decodeRows([{ count: "42" }])).toEqual([{ count: 42 }])
			expect(yield* compiled.decodeRows([{ count: 42 }])).toEqual([{ count: 42 }])
		}),
	)

	// `T.custom("String", branded)` is how a caller brands an id column. The
	// brand must survive derivation — it is the whole reason to declare it — and
	// the column must still compare against a plain-string param.
	it.effect("a branded custom column derives a branded row schema", () =>
		Effect.gen(function* () {
			const OrgId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("OrgId"))
			const table = CH.table(
				"events",
				{ OrgId: T.custom("String", OrgId), Count: CH.uint64 },
				{ tenantColumn: "OrgId" },
			)
			const compiled = compileCHUnsafe(
				CH.from(table)
					.select(($) => ({ orgId: $.OrgId }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))]),
				{ orgId: "org_1" },
			)

			expect(compiled.rowSchemaSource).toBe("derived")
			expect(yield* compiled.decodeRows([{ orgId: "org_1" }])).toEqual([{ orgId: "org_1" }])
			// The brand's checks validate: an empty id is a decode failure.
			const exit = yield* Effect.exit(compiled.decodeRows([{ orgId: "" }]))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it.effect("has no schema when a selected expression has no type to read", () =>
		Effect.gen(function* () {
			const table = CH.table("events", { OrgId: CH.string, Count: CH.uint64 })
			const compiled = compileCHUnsafe(
				CH.from(table).select(($) => ({
					count: $.Count,
					whatever: CH.untypedExpr("anyLast(Something)"),
				})),
				{},
			)

			expect(compiled.rowSchemaSource).toBe("none")
			// One untyped field is enough: nothing in the row is validated.
			expect(yield* compiled.decodeRows([{ count: "42", whatever: 1 }])).toEqual([
				{ count: "42", whatever: 1 },
			])
		}),
	)

	it.effect("takes a declared schema over the derived one", () =>
		Effect.gen(function* () {
			const table = CH.table("events", { OrgId: CH.string, Status: CH.string })
			const compiled = compileCHUnsafe(
				CH.from(table).select(($) => ({ status: $.Status })),
				{},
				{ rowSchema: Schema.Struct({ status: Schema.Literals(["ok", "error"]) }) },
			)

			expect(compiled.rowSchemaSource).toBe("declared")
			// The declared schema narrows what the builder inferred, so it rejects
			// a String the derived schema would have accepted.
			const failure = yield* Effect.exit(compiled.decodeRows([{ status: "banana" }]))
			expect(Exit.isFailure(failure)).toBe(true)
		}),
	)

	// The `Decoded extends Output` constraint already refuses a drifted schema
	// wherever the SELECT's type is visible at the call site. What it cannot see
	// is a schema whose own type has been erased — assembled from generic
	// `Schema.Struct.Fields`, or exported as a `CompiledQueryRowSchema<any>` and
	// handed to a builder typed `CHQuery<any, any, any>`. That is where drift
	// survives to runtime, so that is the shape these tests declare.
	const erased = <
		Fields extends Schema.Struct.Fields & Record<PropertyKey, Schema.Codec<any, any, never, never>>,
	>(
		fields: Fields,
	): Schema.Codec<any, any, never, never> => Schema.Struct(fields)

	it("reports a declared schema that has drifted from the SELECT", () => {
		const table = CH.table("events", { OrgId: CH.string, Status: CH.string, Count: CH.uint64 })
		const compiled = compileCHUnsafe(
			CH.from(table).select(($) => ({ status: $.Status, count: $.Count })),
			{},
			// A schema left behind by a SELECT that gained `count` and lost `name`.
			{ rowSchema: erased({ status: Schema.String, name: Schema.String }) },
		)

		expect(compiled.rowSchemaSource).toBe("declared")
		expect(compiled.rowSchemaMismatch).toEqual({ undeclared: ["count"], unselected: ["name"] })
	})

	it("stays silent when a declared schema only narrows", () => {
		const table = CH.table("events", { OrgId: CH.string, Status: CH.string })
		const compiled = compileCHUnsafe(
			CH.from(table).select(($) => ({ status: $.Status })),
			{},
			{ rowSchema: Schema.Struct({ status: Schema.Literals(["ok", "error"]) }) },
		)

		// Same field, narrower type — the legitimate reason to declare one.
		expect(compiled.rowSchemaMismatch).toBeUndefined()
	})

	it("has nothing to compare against an untyped SELECT", () => {
		const table = CH.table("events", { OrgId: CH.string, Status: CH.string })
		const compiled = compileCHUnsafe(
			CH.from(table).select(($) => ({
				status: $.Status,
				whatever: CH.untypedExpr("anyLast(Something)"),
			})),
			{},
			{ rowSchema: erased({ status: Schema.String, whatever: Schema.Number }) },
		)

		// Derivation is all-or-nothing, so there is no derived shape to disagree
		// with — reporting every field as undeclared here would be noise.
		expect(compiled.rowSchemaMismatch).toBeUndefined()
	})

	it("compares a union's declared schema against the branches", () => {
		const table = CH.table("events", { OrgId: CH.string, Status: CH.string })
		const branch = (status: string) =>
			CH.from(table)
				.select(($) => ({ status: $.Status }))
				.where(($) => [$.OrgId.eq("org"), $.Status.eq(status)])
		const compiled = compileUnionUnsafe(CH.unionAll(branch("ok"), branch("error")), {}, {
			rowSchema: erased({ status: Schema.String, missing: Schema.String }),
		})

		expect(compiled.rowSchemaMismatch).toEqual({ undeclared: [], unselected: ["missing"] })
	})

	it.effect("decodes rows with the declared schema for handwritten SQL", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly name: string; readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT name, count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ name: Schema.String, count: RowNumber }),
			})

			const rows = yield* compiled.decodeRows([{ name: "api", count: "42" }])

			expect(rows).toEqual([{ name: "api", count: 42 }])
		}),
	)

	it.effect("fails with CompiledQueryDecodeError when a row does not match its schema", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ count: RowNumber }),
			})

			const exit = yield* Effect.exit(compiled.decodeRows([{ count: "not-a-number" }]))

			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				const error = Option.getOrUndefined(Exit.findErrorOption(exit))
				expect(error).toBeInstanceOf(CompiledQueryDecodeError)
				expect((error as CompiledQueryDecodeError).rowIndex).toBe(0)
			}
		}),
	)
})

describe("CompiledQuery.decodeFirstRow", () => {
	it.effect("returns Some with the first decoded row", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly name: string; readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT name, count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ name: Schema.String, count: RowNumber }),
			})

			const row = yield* compiled.decodeFirstRow([
				{ name: "api", count: "42" },
				{ name: "worker", count: "9" },
			])

			expect(Option.isSome(row)).toBe(true)
			if (Option.isSome(row)) {
				expect(row.value).toEqual({ name: "api", count: 42 })
			}
		}),
	)

	it.effect("returns None when the result set is empty", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ count: RowNumber }),
			})

			const row = yield* compiled.decodeFirstRow([])

			expect(Option.isNone(row)).toBe(true)
		}),
	)

	it.effect("fails when the first row does not match the declared schema", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ count: RowNumber }),
			})

			const exit = yield* Effect.exit(compiled.decodeFirstRow([{ count: "not-a-number" }]))

			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				const error = Option.getOrUndefined(Exit.findErrorOption(exit))
				expect(error).toBeInstanceOf(CompiledQueryDecodeError)
				expect((error as CompiledQueryDecodeError).rowIndex).toBe(0)
			}
		}),
	)

	it.effect("does not decode later rows when only the first row is requested", () =>
		Effect.gen(function* () {
			const compiled = rawCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ count: RowNumber }),
			})

			const row = yield* compiled.decodeFirstRow([{ count: "42" }, { count: "not-a-number" }])

			expect(Option.isSome(row)).toBe(true)
			if (Option.isSome(row)) {
				expect(row.value).toEqual({ count: 42 })
			}
		}),
	)
})

// Tenant scope
//
// `tenantScope` is what executors gate on, so these cases pin the exact shapes
// that must NOT read as scoped. Each one compiles to SQL that mentions the
// tenant column — which is why a substring check can't tell them apart.

describe("CompiledQuery.tenantScope", () => {
	const events = CH.table("events", { OrgId: CH.string, Count: CH.uint64 }, { tenantColumn: "OrgId" })
	const other = CH.table("other", { OrgId: CH.string, Count: CH.uint64 }, { tenantColumn: "OrgId" })

	const scopeOf = (build: (q: typeof events) => any) => compileCHUnsafe(build(events), {}).tenantScope

	it("is 'tenant' for a top-level equality on the tenant column", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")]),
			),
		).toBe("single-tenant")
	})

	it("is 'tenant' for a top-level membership test", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.in_("a", "b")]),
			),
		).toBe("single-tenant")
	})

	it("is 'cross-tenant' when the tenant predicate is disjoined away", () => {
		// `OrgId = 'x' OR Count > 0` matches every tenant's rows.
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org").or($.Count.gt(0))]),
			),
		).toBe("cross-tenant")
	})

	it("is 'cross-tenant' for a negated tenant predicate", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.neq("org")]),
			),
		).toBe("cross-tenant")
	})

	it("is 'cross-tenant' when only the SELECT mentions the tenant column", () => {
		// The shape that satisfied the old `sql.includes("OrgId")` guard.
		const compiled = compileCHUnsafe(
			CH.from(events)
				.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
				.groupBy("OrgId"),
			{},
		)
		expect(compiled.sql).toContain("OrgId")
		expect(compiled.tenantScope).toBe("cross-tenant")
	})

	// A query reading only from a scoped source is itself confined to that
	// tenant, even with no WHERE of its own — this is the
	// `SELECT sum(total) FROM (scoped UNION scoped)` shape that rollup-splice
	// queries compile to.
	it("is 'tenant' when the FROM source is already scoped", () => {
		const inner = CH.from(events)
			.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		expect(
			compileCHUnsafe(
				CH.fromQuery(inner, "i")
					.select(($) => ({ total: CH.sum($.count) }))
					.where(($) => [$.count.gt(0)]),
				{},
			).tenantScope,
		).toBe("single-tenant")
	})

	it("is 'cross-tenant' when the FROM source is unscoped", () => {
		const inner = CH.from(events).select(($) => ({ OrgId: $.OrgId, count: $.Count }))
		expect(
			compileCHUnsafe(
				CH.fromQuery(inner, "i").select(($) => ({ total: CH.sum($.count) })),
				{},
			).tenantScope,
		).toBe("cross-tenant")
	})

	// Joins add row sources the FROM scope says nothing about, so a joined query
	// has to pin the tenant at its own level.
	it("is 'cross-tenant' when a scoped source is joined to an unscoped table", () => {
		const inner = CH.from(events)
			.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		expect(
			compileCHUnsafe(
				CH.fromQuery(inner, "i")
					.leftJoin(other, "o", (main, o) => main.OrgId.eq(o.OrgId))
					.select(($) => ({ total: CH.sum($.count) })),
				{},
			).tenantScope,
		).toBe("cross-tenant")
	})

	it("is 'tenant' for a tenant predicate on a joined alias", () => {
		expect(
			compileCHUnsafe(
				CH.from(events)
					.leftJoin(other, "o", (main, o) => main.OrgId.eq(o.OrgId))
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.o.OrgId.eq("org")]),
				{},
			).tenantScope,
		).toBe("single-tenant")
	})

	it("is 'cross-tenant' for a union with one unscoped branch", () => {
		const scoped = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		const unscoped = CH.from(other).select(($) => ({ count: $.Count }))

		expect(CH.compileUnionUnsafe(CH.unionAll(scoped, scoped), {}).tenantScope).toBe("single-tenant")
		expect(CH.compileUnionUnsafe(CH.unionAll(scoped, unscoped), {}).tenantScope).toBe("cross-tenant")
	})

	it("is 'cross-tenant' when .crossTenant() overrides a tenant predicate", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")])
					.crossTenant(),
			),
		).toBe("cross-tenant")
	})

	it("requires handwritten SQL to state its scope", () => {
		expect(
			rawCompiledQuery({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				sql: "SELECT 1",
				tenantScope: "cross-tenant",
			}).tenantScope,
		).toBe("cross-tenant")
	})
})

describe("CompiledQuery.encodeRows", () => {
	const Events = CH.table("events", {
		OrgId: T.string,
		Timestamp: T.dateTime64,
		Name: T.string,
		Count: T.uint64,
	})

	// The reason the round trip matters: a `DateTime` column is worth decoding —
	// a `DateTime.Utc` is what you compute with — but a surface forwarding these
	// rows onto its own wire has to emit ClickHouse's spelling, not ISO-8601.
	// Re-encoding through the same codec gives back exactly what came in.
	it.effect("returns a decoded row to the wire shape ClickHouse sent", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ at: $.Timestamp, name: $.Name, count: $.Count }))
					.where(($) => [$.OrgId.eq("org_1")]),
				{},
			)

			const wire = [{ at: "2026-05-24 14:30:00", name: "checkout", count: "9007199254740993" }]
			const decoded = yield* compiled.decodeRows(wire)
			expect(DateTime.isDateTime(decoded[0]!.at)).toBe(true)

			const reencoded = yield* compiled.encodeRows(decoded)
			expect(reencoded[0]!.at).toBe("2026-05-24 14:30:00")
			expect(reencoded[0]!.name).toBe("checkout")
		}),
	)

	it.effect("fails on a row the schema cannot represent", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ at: $.Timestamp }))
					.where(($) => [$.OrgId.eq("org_1")]),
				{},
			)

			const exit = yield* Effect.exit(compiled.encodeRows([{ at: "not a DateTime" } as never]))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	// Same contract as `decodeRows`: with nothing to reverse, the rows pass
	// through rather than the call becoming an error nobody can act on.
	it.effect("passes rows through when the query has no row schema", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ name: $.Name, odd: CH.untypedExpr("anyLast(Whatever)") }))
					.where(($) => [$.OrgId.eq("org_1")]),
				{},
			)
			expect(compiled.rowSchemaSource).toBe("none")

			const rows = [{ name: "checkout", odd: 1 }]
			expect(yield* compiled.encodeRows(rows)).toEqual(rows)
		}),
	)
})

describe("compile puts failures in the error channel", () => {
	const Events = CH.table(
		"events",
		{ OrgId: T.string, Name: T.string, Count: T.uint64 },
		{ tenantColumn: "OrgId" },
	)

	const query = CH.from(Events)
		.select(($) => ({ name: $.Name }))
		.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])

	// The whole point of the change: a route can `catchTag` this. Thrown, it was
	// a defect — a missing param reached production as an unhandled crash rather
	// than a typed failure anyone could map to a 400.
	it.effect("a missing param value is a typed failure", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(CH.compile(query, {}))
			expect(error._tag).toBe("@maple-dev/clickhouse-builder/QueryBuilderError")
			expect(error.code).toBe("UnresolvedParam")
			expect(error.message).toContain("orgId")
		}),
	)

	it.effect("a value the column cannot hold is a typed failure", () =>
		Effect.gen(function* () {
			const bad = CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(($) => [$.OrgId.eq("org"), $.Count.eq("lots" as never)])

			const error = yield* Effect.flip(CH.compile(bad, {}))
			expect(error.code).toBe("InvalidLiteral")
		}),
	)

	it.effect("a success carries the same compiled query the unsafe path returns", () =>
		Effect.gen(function* () {
			const compiled = yield* CH.compile(query, { orgId: "org_1" })
			expect(compiled.sql).toBe(CH.compileUnsafe(query, { orgId: "org_1" }).sql)
			expect(compiled.tenantScope).toBe("single-tenant")
		}),
	)

	// A bug inside a callback is not an expected failure and must stay a defect:
	// making it a `QueryBuilderError` would hand callers a value to pattern-match
	// on where the honest answer is that the process is broken.
	it.effect("an unexpected throw stays a defect", () =>
		Effect.gen(function* () {
			const exploding = CH.from(Events).select(() => {
				throw new TypeError("boom")
			})

			const exit = yield* Effect.exit(CH.compile(exploding, {}))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(String(exit)).toContain("boom")
		}),
	)
})

describe("CompiledQuery.rowSchema", () => {
	const Events = CH.table("events", { OrgId: T.string, Name: T.string, Count: T.uint64 })

	// The codec as a value, for callers that need a `Schema` rather than a call:
	// a cache round-tripping through JSON, a boundary composing it into a larger
	// schema. Without it they re-declare a shape the builder already knows.
	it.effect("exposes the derived codec so it can be composed", () =>
		Effect.gen(function* () {
			const compiled = yield* CH.compile(
				CH.from(Events)
					.select(($) => ({ name: $.Name, count: $.Count }))
					.where(($) => [$.OrgId.eq("org_1")]),
				{},
			)

			const schema = compiled.rowSchema
			expect(schema).toBeDefined()
			// It is the codec `decodeRows` runs, not a lookalike: a quoted UInt64
			// decodes the same through either door.
			expect(yield* compiled.decodeRows([{ name: "a", count: "7" }])).toEqual([{ name: "a", count: 7 }])
			// Stable across reads: composing it must not rebuild a new struct.
			expect(compiled.rowSchema).toBe(schema)
		}),
	)

	it.effect("is undefined when the query derives nothing", () =>
		Effect.gen(function* () {
			const compiled = yield* CH.compile(
				CH.from(Events)
					.select(($) => ({ name: $.Name, odd: CH.untypedExpr("anyLast(Whatever)") }))
					.where(($) => [$.OrgId.eq("org_1")]),
				{},
			)
			expect(compiled.rowSchema).toBeUndefined()
		}),
	)
})

/** Assert an exit died with a `QueryBuilderDefect` rather than failing. */
const expectDefect = (exit: Exit.Exit<unknown, unknown>) => {
	expect(Exit.isFailure(exit)).toBe(true)
	const defect = Exit.isFailure(exit) ? Cause.findDefect(exit.cause) : undefined
	expect(
		defect && Result.isSuccess(defect) ? (defect.success as CH.QueryBuilderDefect)._tag : undefined,
	).toBe("@maple-dev/clickhouse-builder/QueryBuilderDefect")
}

// Failures vs defects — the rule is on `QueryBuilderError` in ./errors.
describe("what reports and what dies", () => {
	const Events = CH.table(
		"events",
		{ OrgId: T.string, Name: T.string, Count: T.uint64 },
		{ tenantColumn: "OrgId" },
	)

	// The argument *count* is the number of steps a funnel has, and that comes
	// from data as often as from source — so it reports.
	it.effect("an empty condition list is a typed failure", () =>
		Effect.gen(function* () {
			const steps: ReadonlyArray<CH.Condition> = []
			const query = CH.from(Events)
				.select(($) => ({ level: CH.windowFunnel(60)($.Count, ...steps) }))
				.where(($) => [$.OrgId.eq("org")])

			const error = yield* Effect.flip(CH.compile(query, {}))
			expect(error.code).toBe("InvalidArguments")
		}),
	)

	it.effect("a pattern that would break out of its quotes is a typed failure", () =>
		Effect.gen(function* () {
			const query = CH.from(Events)
				.select(($) => ({ matched: CH.sequenceMatch("(?1)' OR 1=1 --")($.Count, $.Count.gt(0)) }))
				.where(($) => [$.OrgId.eq("org")])

			const error = yield* Effect.flip(CH.compile(query, {}))
			expect(error.code).toBe("InvalidArguments")
		}),
	)

	// Which side of the comparison a param sits on is written in the source, so
	// no input can cause or avoid it: a defect, in the Cause, not the channel.
	it.effect("comparing on a param marker dies rather than failing", () =>
		Effect.gen(function* () {
			const query = CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(() => [CH.param.string("orgId").eq("org")])

			const exit = yield* Effect.exit(CH.compile(query, { orgId: "org" }))
			expect(Exit.isFailure(exit)).toBe(true)
			expectDefect(exit)
		}),
	)

	// `select()` is written at the query definition. A params bag cannot remove
	// one, so a compile with none is a bug in the definition and reports as such
	// — the reason it moved out of the error channel.
	it.effect("a query with no select dies rather than failing", () =>
		Effect.gen(function* () {
			const query = CH.from(Events).where(($) => [$.OrgId.eq("org")])

			expectDefect(yield* Effect.exit(CH.compile(query as never, {})))
		}),
	)

	// Same rule for the order-by specs: they are literals in the source, and a
	// caller who bypasses the types has a bug, not a bad request.
	it.effect("a bare-string orderBy dies rather than failing", () =>
		Effect.gen(function* () {
			const query = CH.from(Events)
				.select(($) => ({ name: $.Name }))
				.where(($) => [$.OrgId.eq("org")])

			expectDefect(yield* Effect.exit(CH.compile((query as any).orderBy("name", "desc"), {})))
		}),
	)
})

describe("arithmetic decoding", () => {
	const Events = CH.table(
		"events",
		{ OrgId: T.string, Total: T.uint64, Hits: T.uint64 },
		{ tenantColumn: "OrgId" },
	)

	// ClickHouse renders `1/0` and `0/0` as JSON null, and `CHNumber` is
	// `Schema.Finite`-based. A division that decoded strictly turned a query that
	// ran fine into a 500 the first time a denominator was zero.
	it.effect("a division decodes the null a zero denominator produces", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ rate: CH.sum($.Hits).div(CH.sum($.Total)) }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)

			expect(yield* compiled.decodeRows([{ rate: null }])).toEqual([{ rate: null }])
			expect(yield* compiled.decodeRows([{ rate: 0.5 }])).toEqual([{ rate: 0.5 }])
		}),
	)

	// The SQL-side guard, for callers that need a number rather than a null.
	it.effect("ifNotFinite keeps the column non-null", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ rate: CH.ifNotFinite(CH.sum($.Hits).div(CH.sum($.Total)), 0) }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)

			expect(compiled.sql).toContain("ifNotFinite(sum(Hits) / sum(Total), 0) AS rate")
			const exit = yield* Effect.exit(compiled.decodeRows([{ rate: null }]))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	// Addition cannot manufacture a null out of two finite operands, so it stays
	// strict — the looseness is bought only where it is paid for.
	it.effect("addition stays strict", () =>
		Effect.gen(function* () {
			const compiled = compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ total: CH.sum($.Hits).add(CH.sum($.Total)) }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)

			const exit = yield* Effect.exit(compiled.decodeRows([{ total: null }]))
			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)
})

describe("handwritten SQL", () => {
	// `reason` and `note` are required arguments, and used to be dropped — so the
	// gate they describe existed only at the call site, where no sweep could see
	// it. They are on the compiled query now.
	it("carries its reason and note so a catalog can audit them", () => {
		const compiled = CH.rawCompiledQuery<{ readonly n: string }>({
			sql: "SELECT Name AS n FROM events WHERE OrgId = 'org'",
			tenantScope: "single-tenant",
			reason: "user-authored-sql",
			justification: "The SQL came from a user; there is no AST to build.",
		})

		expect(compiled.rawSql?.reason).toBe("user-authored-sql")
		expect(compiled.rawSql?.justification).toContain("no AST")
		// Absent for a query the builder produced, so the two are distinguishable.
		const built = compileCHUnsafe(
			CH.from(CH.table("events", { OrgId: T.string, Name: T.string }, { tenantColumn: "OrgId" }))
				.select(($) => ({ n: $.Name }))
				.where(($) => [$.OrgId.eq("org")]),
			{},
		)
		expect(built.rawSql).toBeUndefined()
	})
})

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Option, Schema } from "effect"
import { CompiledQueryDecodeError, compileCHUnsafe, unsafeCompiledQuery } from "./compile"
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

	it.effect("decodes rows with the declared schema for handwritten SQL", () =>
		Effect.gen(function* () {
			const compiled = unsafeCompiledQuery<{ readonly name: string; readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
				sql: "SELECT name, count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ name: Schema.String, count: RowNumber }),
			})

			const rows = yield* compiled.decodeRows([{ name: "api", count: "42" }])

			expect(rows).toEqual([{ name: "api", count: 42 }])
		}),
	)

	it.effect("fails with CompiledQueryDecodeError when a row does not match its schema", () =>
		Effect.gen(function* () {
			const compiled = unsafeCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
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
			const compiled = unsafeCompiledQuery<{ readonly name: string; readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
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
			const compiled = unsafeCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
				sql: "SELECT count FROM events WHERE OrgId = 'org'",
				rowSchema: Schema.Struct({ count: RowNumber }),
			})

			const row = yield* compiled.decodeFirstRow([])

			expect(Option.isNone(row)).toBe(true)
		}),
	)

	it.effect("fails when the first row does not match the declared schema", () =>
		Effect.gen(function* () {
			const compiled = unsafeCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
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
			const compiled = unsafeCompiledQuery<{ readonly count: number }>({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "tenant",
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
		).toBe("tenant")
	})

	it("is 'tenant' for a top-level membership test", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.in_("a", "b")]),
			),
		).toBe("tenant")
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
		).toBe("tenant")
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
		).toBe("tenant")
	})

	it("is 'cross-tenant' for a union with one unscoped branch", () => {
		const scoped = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		const unscoped = CH.from(other).select(($) => ({ count: $.Count }))

		expect(CH.compileUnionUnsafe(CH.unionAll(scoped, scoped), {}).tenantScope).toBe("tenant")
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
			unsafeCompiledQuery({
				reason: "test-fixture",
				note: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
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
			expect(compiled.tenantScope).toBe("tenant")
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

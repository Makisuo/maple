import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import { CompiledQueryDecodeError, compileCH, unsafeCompiledQuery } from "./compile"
import * as CH from "./index"

const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

describe("CompiledQuery.decodeRows", () => {
	it.effect("preserves cast-only behavior for DSL-compiled queries without a row schema", () =>
		Effect.gen(function* () {
			const table = CH.table("events", { OrgId: CH.string, Count: CH.uint64 })
			const compiled = compileCH(
				CH.from(table)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")]),
				{},
			)

			const rows = yield* compiled.decodeRows([{ count: "42" }])

			expect(rows).toEqual([{ count: "42" }])
		}),
	)

	it.effect("decodes rows with the declared schema for handwritten SQL", () =>
		Effect.gen(function* () {
			const compiled = unsafeCompiledQuery<{ readonly name: string; readonly count: number }>({
				tenantScope: "org",
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
				tenantScope: "org",
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
				tenantScope: "org",
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
				tenantScope: "org",
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
				tenantScope: "org",
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
				tenantScope: "org",
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

// ---------------------------------------------------------------------------
// Tenant scope
//
// `tenantScope` is what executors gate on, so these cases pin the exact shapes
// that must NOT read as scoped. Each one compiles to SQL that mentions the
// tenant column — which is why a substring check can't tell them apart.
// ---------------------------------------------------------------------------

describe("CompiledQuery.tenantScope", () => {
	const events = CH.table("events", { OrgId: CH.string, Count: CH.uint64 })
	const other = CH.table("other", { OrgId: CH.string, Count: CH.uint64 })

	const scopeOf = (build: (q: typeof events) => any) => compileCH(build(events), {}).tenantScope

	it("is 'org' for a top-level equality on the tenant column", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")]),
			),
		).toBe("org")
	})

	it("is 'org' for a top-level membership test", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.in_("a", "b")]),
			),
		).toBe("org")
	})

	it("is 'cross-org' when the tenant predicate is disjoined away", () => {
		// `OrgId = 'x' OR Count > 0` matches every tenant's rows.
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org").or($.Count.gt(0))]),
			),
		).toBe("cross-org")
	})

	it("is 'cross-org' for a negated tenant predicate", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.neq("org")]),
			),
		).toBe("cross-org")
	})

	it("is 'cross-org' when only the SELECT mentions the tenant column", () => {
		// The shape that satisfied the old `sql.includes("OrgId")` guard.
		const compiled = compileCH(
			CH.from(events)
				.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
				.groupBy("OrgId"),
			{},
		)
		expect(compiled.sql).toContain("OrgId")
		expect(compiled.tenantScope).toBe("cross-org")
	})

	// A query reading only from a scoped source is itself confined to that
	// tenant, even with no WHERE of its own — this is the
	// `SELECT sum(total) FROM (scoped UNION scoped)` shape that rollup-splice
	// queries compile to.
	it("is 'org' when the FROM source is already scoped", () => {
		const inner = CH.from(events)
			.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		expect(
			compileCH(
				CH.fromQuery(inner, "i")
					.select(($) => ({ total: CH.sum($.count) }))
					.where(($) => [$.count.gt(0)]),
				{},
			).tenantScope,
		).toBe("org")
	})

	it("is 'cross-org' when the FROM source is unscoped", () => {
		const inner = CH.from(events).select(($) => ({ OrgId: $.OrgId, count: $.Count }))
		expect(
			compileCH(
				CH.fromQuery(inner, "i").select(($) => ({ total: CH.sum($.count) })),
				{},
			).tenantScope,
		).toBe("cross-org")
	})

	// Joins add row sources the FROM scope says nothing about, so a joined query
	// has to pin the tenant at its own level.
	it("is 'cross-org' when a scoped source is joined to an unscoped table", () => {
		const inner = CH.from(events)
			.select(($) => ({ OrgId: $.OrgId, count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		expect(
			compileCH(
				CH.fromQuery(inner, "i")
					.leftJoin(other, "o", (main, o) => main.OrgId.eq(o.OrgId))
					.select(($) => ({ total: CH.sum($.count) })),
				{},
			).tenantScope,
		).toBe("cross-org")
	})

	it("is 'org' for a tenant predicate on a joined alias", () => {
		expect(
			compileCH(
				CH.from(events)
					.leftJoin(other, "o", (main, o) => main.OrgId.eq(o.OrgId))
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.o.OrgId.eq("org")]),
				{},
			).tenantScope,
		).toBe("org")
	})

	it("is 'cross-org' for a union with one unscoped branch", () => {
		const scoped = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq("org")])
		const unscoped = CH.from(other).select(($) => ({ count: $.Count }))

		expect(CH.compileUnion(CH.unionAll(scoped, scoped), {}).tenantScope).toBe("org")
		expect(CH.compileUnion(CH.unionAll(scoped, unscoped), {}).tenantScope).toBe("cross-org")
	})

	it("is 'cross-org' when .crossOrg() overrides a tenant predicate", () => {
		expect(
			scopeOf((t) =>
				CH.from(t)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")])
					.crossOrg(),
			),
		).toBe("cross-org")
	})

	it("requires handwritten SQL to state its scope", () => {
		expect(
			unsafeCompiledQuery({ sql: "SELECT 1", tenantScope: "cross-org" }).tenantScope,
		).toBe("cross-org")
	})
})

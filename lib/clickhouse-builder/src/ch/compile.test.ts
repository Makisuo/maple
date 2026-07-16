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

	it.effect("applies a declared row schema to compiled UNION queries", () =>
		Effect.gen(function* () {
			const table = CH.table("events", { OrgId: CH.string, Count: CH.uint64 })
			const selectCount = () =>
				CH.from(table)
					.select(($) => ({ count: $.Count }))
					.where(($) => [$.OrgId.eq("org")])
			const compiled = CH.compileUnion(
				CH.unionAll(selectCount(), selectCount()).format("JSON"),
				{},
				{
					rowSchema: Schema.Struct({ count: RowNumber }),
				},
			)

			const rows = yield* compiled.decodeRows([{ count: "42" }])

			expect(rows).toEqual([{ count: 42 }])
		}),
	)
})

describe("CompiledQuery.decodeFirstRow", () => {
	it.effect("returns Some with the first decoded row", () =>
		Effect.gen(function* () {
			const compiled = unsafeCompiledQuery<{ readonly name: string; readonly count: number }>({
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

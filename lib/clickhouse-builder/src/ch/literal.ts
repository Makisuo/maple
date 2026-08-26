// Values → ClickHouse literals
//
// The encode half of the column types. A column type is a `Schema`, so a value
// compared against that column can be encoded through it — turning a
// `DateTime.Utc` into `'2026-01-01 00:00:00'`, a boolean into `1` — and the
// result is a wire value this module writes as ClickHouse syntax.
//
// Everything that reaches SQL as a literal goes through `sqlLiteral`, and it is
// deliberately total: a value it cannot represent raises rather than falling
// back to `String(value)`. That fallback is what emitted `Attrs = [object
// Object]` and `Tags = a,b` — SQL that is either an error or, worse, a bare
// identifier that happens to parse.

import { Result, Schema } from "effect"
import { QueryBuilderError } from "./errors"
import { escapeClickHouseString } from "../sql/sql-fragment"
import type { CHType } from "./types"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const describe = (value: unknown): string => {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "function") return "a function"
	if (typeof value === "symbol") return "a symbol"
	if (typeof value === "number" || typeof value === "boolean") return `${value}`
	if (value instanceof Date) return "a Date"
	if (Array.isArray(value)) return "an array"
	if (typeof value === "object") return "an object"
	return `${typeof value} ${JSON.stringify(value) ?? String(value)}`
}

/** Schema failures are multi-line, and one line reads better inside a sentence. */
const oneLine = (failure: unknown): string =>
	String(failure)
		.replace(/^SchemaError:?\s*/, "")
		.replace(/\s*\n\s*/g, "; ")
		.trim()

/**
 * A wire value as ClickHouse literal syntax.
 *
 * The input is what a column type's schema *encodes to* — a string, a number, a
 * boolean, null, or arrays and records of those — not an arbitrary JS value.
 */
export function sqlLiteral(value: unknown, context: string): string {
	if (value === null) return "NULL"
	if (typeof value === "string") return `'${escapeClickHouseString(value)}'`
	if (typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "1" : "0"

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new QueryBuilderError({
				code: "InvalidLiteral",
				message: `${context}: ${value} has no ClickHouse literal`,
			})
		}
		return String(value)
	}

	if (Array.isArray(value)) {
		return `[${value.map((element) => sqlLiteral(element, context)).join(", ")}]`
	}

	// ClickHouse has no object literal syntax: a Map is built by `map(k, v, …)`.
	if (isPlainObject(value)) {
		const pairs = Object.entries(value).flatMap(([key, entry]) => [
			sqlLiteral(key, context),
			sqlLiteral(entry, context),
		])
		return `map(${pairs.join(", ")})`
	}

	throw new QueryBuilderError({
		code: "InvalidLiteral",
		message: `${context}: cannot write ${describe(value)} as a ClickHouse literal`,
	})
}

/**
 * Encode a value through a schema, then write it as a literal.
 *
 * The schema is the contract in both directions, so a value of the wrong shape
 * fails here — while building the SQL — instead of becoming part of it.
 */
export function encodeLiteral<A>(schema: Schema.Codec<A, any>, value: unknown, context: string): string {
	const encoded = Schema.encodeUnknownResult(schema)(value)
	if (Result.isFailure(encoded)) {
		throw new QueryBuilderError({
			code: "InvalidLiteral",
			message: `${context}: ${describe(value)} is not a valid value — ${oneLine(encoded.failure)}`,
		})
	}
	return sqlLiteral(encoded.success, context)
}

/** `encodeLiteral` against a column type, naming the column in any failure. */
export const encodeColumnLiteral = (
	columnType: CHType<string, any, any>,
	value: unknown,
	column: string,
): string => encodeLiteral(columnType.literalSchema, value, `column ${column}`)

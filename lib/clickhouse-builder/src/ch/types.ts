// ClickHouse Type Descriptors
//
// A column type is an Effect `Schema` plus the ClickHouse type name it stands
// for. The schema is the single source of truth: TypeScript infers row shapes
// from it (`InferTS`), and `compile` folds the selected columns' schemas into
// the row schema that `decodeRows` validates against.
//
// That is why the schemas describe the WIRE representation rather than the
// storage type. `UInt64` is the case that matters: ClickHouse's `FORMAT JSON`
// quotes 64-bit integers, a client setting output_format_json_quote_64bit_integers=0
// gets them bare, and a gateway that refuses
// `output_format_json_quote_64bit_integers=0` quotes them whatever the client
// asked for. Modelling that once here is what stops every consumer from
// rediscovering it as a `ParseError` in production.

import { DateTime, Schema, SchemaGetter } from "effect"

export interface CHType<Tag extends string, A, I = A> {
	readonly _tag: Tag
	/** The ClickHouse type name, e.g. `UInt64`, `Map(String, String)`. */
	readonly sql: string
	/** Wire representation → domain value. Decoding rows reads this direction. */
	readonly schema: Schema.Codec<A, I>
	/**
	 * What a *literal* compared against this column may be, and how it encodes.
	 *
	 * Usually `schema` itself: a value of the column's own type encodes back to
	 * the wire form, which is the literal. It differs where comparisons accept
	 * more than the column decodes to — a `DateTime` column takes a
	 * `DateTime.Utc`, a `Date`, or the string form, and all three write the same
	 * `'YYYY-MM-DD hh:mm:ss'`.
	 */
	readonly literalSchema: Schema.Codec<any, any>
	/**
	 * The type this one wraps: an `Array`'s element, a `Map`'s value, a
	 * `Nullable`'s inner type. Absent for scalars.
	 *
	 * Kept as a `CHType` rather than recovered from `schema`'s AST because the
	 * wrapper's schema is lossy in the direction that matters: `Map(String, V)`
	 * becomes `Schema.Record(String, V.schema)`, and reading `V` back out of a
	 * record AST is a different shape per Effect version. Subscripting a Map
	 * (`$.Attrs.get(k)`) needs `V` to know how the result decodes.
	 */
	readonly element?: CHType<string, any, any>
	readonly _phantom?: A
}

const chType = <const Tag extends string, A, I>(
	_tag: Tag,
	sql: string,
	schema: Schema.Codec<A, I>,
	literalSchema: Schema.Codec<any, any> = schema,
	element?: CHType<string, any, any>,
): CHType<Tag, A, I> => ({
	_tag,
	sql,
	schema,
	literalSchema,
	...(element !== undefined ? { element } : undefined),
})

// Wire codecs

/**
 * A 64-bit integer as ClickHouse may actually send it: a JSON number, or the
 * same value quoted. Rejects `NaN`/`Infinity`.
 */
export const CHNumber: Schema.Codec<number, number | string> = Schema.Union([
	Schema.Finite,
	Schema.FiniteFromString,
])

/** ClickHouse `Bool` arrives as `true`/`false`, but `UInt8` flags as `1`/`0`. */
const CHBoolean: Schema.Codec<boolean, boolean | number> = Schema.Union([
	// Numeric arm first: union order is encode order, and ClickHouse compares a
	// `UInt8` against `1`/`0`, not against `true`/`false`.
	Schema.Number.pipe(
		Schema.decodeTo(Schema.Boolean, {
			decode: SchemaGetter.transform((n: number) => n !== 0),
			encode: SchemaGetter.transform((b: boolean) => (b ? 1 : 0)),
		}),
	),
	Schema.Boolean,
])

const CH_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

/**
 * ClickHouse writes `DateTime` as `2026-05-24 14:30:00` — UTC, but with no zone
 * marker and a space separator, which `new Date(…)` reads as LOCAL time and
 * shifts by the runtime's offset. Normalising to an explicit `Z` before parsing
 * is the whole job.
 */
export const chDateTimeToIso = (value: string): string => {
	const trimmed = value.trim()
	const match = CH_DATETIME_PATTERN.exec(trimmed)
	if (!match) return trimmed // already zoned, or not a timestamp — let the parse fail

	const [, date, time, fractional] = match
	if (fractional === undefined) return `${date}T${time}Z`
	return `${date}T${time}.${`${fractional}000`.slice(0, 3)}Z`
}

/** `DateTime.Utc` → the tz-less second-precision literal ClickHouse expects. */
export const chDateTimeLiteral = (value: DateTime.Utc): string =>
	new Date(DateTime.toEpochMillis(value)).toISOString().replace("T", " ").slice(0, 19)

const isChDateTime = Schema.makeFilter(
	(value: string) =>
		Number.isNaN(Date.parse(chDateTimeToIso(value)))
			? `\`${value}\` is not a ClickHouse DateTime — expected \`YYYY-MM-DD hh:mm:ss\` or an ISO-8601 timestamp`
			: undefined,
	{ title: "clickHouseDateTime" },
)

/** A ClickHouse `DateTime`/`DateTime64` string decoded as UTC. */
export const CHDateTimeUtc: Schema.Codec<DateTime.Utc, string> = Schema.String.pipe(
	Schema.check(isChDateTime),
	Schema.decodeTo(Schema.DateTimeUtc, {
		// Total by construction: the check above already proved this parses.
		decode: SchemaGetter.transform((value: string) => DateTime.makeUnsafe(chDateTimeToIso(value))),
		encode: SchemaGetter.transform(chDateTimeLiteral),
	}),
)

/** A `Date` written as a ClickHouse DateTime literal. */
const CHDateTimeFromDate: Schema.Codec<Date, string> = Schema.String.pipe(
	Schema.check(isChDateTime),
	Schema.decodeTo(Schema.Date, {
		decode: SchemaGetter.transform((value: string) => new Date(chDateTimeToIso(value))),
		encode: SchemaGetter.transform((value: Date) => chDateTimeLiteral(DateTime.makeUnsafe(value))),
	}),
)

/** A literal string already in ClickHouse's DateTime shape, passed through. */
const CHDateTimeFromString: Schema.Codec<string, string> = Schema.String.pipe(Schema.check(isChDateTime))

/**
 * The same, floored to whole seconds.
 *
 * A `DateTime` column rejects a fractional literal outright — `TimestampTime >=
 * '2026-09-01 02:40:00.000'` is `TYPE_MISMATCH`, not a rounding — while the
 * `DateTime64` column beside it in the same table needs that fraction kept. The
 * two cannot share one rendering of one bound, which is what
 * {@link param.dateTimeSeconds} exists to resolve: same param value, floored
 * encoding, so a second-precision column gets a literal it can parse.
 *
 * The `DateTime.Utc` and `Date` arms already floor via `chDateTimeLiteral`;
 * only the string passthrough needed teaching.
 */
export const CHDateTimeSecondsLiteral: Schema.Codec<string, string> = Schema.String.pipe(
	Schema.check(isChDateTime),
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value: string) => value),
		encode: SchemaGetter.transform((value: string) => {
			const trimmed = value.trim()
			const dot = trimmed.indexOf(".")
			return dot === -1 ? trimmed : trimmed.slice(0, dot)
		}),
	}),
)

/**
 * Everything a DateTime column can be compared against.
 *
 * Union order is the encode order: the first member whose type matches wins, so
 * each arm has to produce the same literal — they do, all three go through
 * `chDateTimeLiteral` or are already in its shape.
 */
const CHDateTimeLiteral = Schema.Union([CHDateTimeUtc, CHDateTimeFromDate, CHDateTimeFromString])

// Primitive types

export type CHString = CHType<"String", string>
export type CHUInt8 = CHType<"UInt8", number, number | string>
export type CHUInt16 = CHType<"UInt16", number, number | string>
export type CHUInt32 = CHType<"UInt32", number, number | string>
export type CHUInt64 = CHType<"UInt64", number, number | string>
export type CHInt32 = CHType<"Int32", number, number | string>
export type CHInt64 = CHType<"Int64", number, number | string>
export type CHFloat64 = CHType<"Float64", number, number | string>
export type CHDateTime = CHType<"DateTime", DateTime.Utc, string>
export type CHDateTime64 = CHType<"DateTime64", DateTime.Utc, string>
export type CHBool = CHType<"Bool", boolean, boolean | number>

/**
 * A `String` column whatever its decoded type — plain, branded, or narrowed.
 *
 * The constraint form of `CHString`, for "this table must carry this String
 * column" (a tenant column, a join key) where how the value decodes is the
 * table's own business. Spelling such a constraint as `CHString` would reject
 * a branded column: `CHType` is invariant in its decoded type, so
 * `custom("String", OrgId)` is not a `CHType<"String", string>`.
 */
export type CHStringLike = CHType<"String", any, any>

/**
 * The same columns left as the strings ClickHouse sends.
 *
 * `DateTime` decodes to a `DateTime.Utc` by default, which is the right value
 * to compute with — but a consumer that forwards rows onto a wire of its own
 * usually wants the timestamp it was given, byte for byte, rather than a parsed
 * value re-serialized in a different format. Declare these instead where that
 * matters; the date-time functions preserve whichever flavour they are handed.
 */
export type CHDateTimeString = CHType<"DateTime", string, string>
export type CHDateTime64String = CHType<"DateTime64", string, string>

// Compound types

export type CHMap<_K extends CHType<string, string, any>, V extends CHType<string, any, any>> = CHType<
	"Map",
	Record<string, InferTS<V>>,
	Record<string, InferEncoded<V>>
>

export type CHArray<E extends CHType<string, any, any>> = CHType<
	"Array",
	ReadonlyArray<InferTS<E>>,
	ReadonlyArray<InferEncoded<E>>
>

export type CHNullable<T extends CHType<string, any, any>> = CHType<
	"Nullable",
	InferTS<T> | null,
	InferEncoded<T> | null
>

// Type-level extraction

export type InferTS<T> = T extends CHType<string, infer A, any> ? A : never
export type InferEncoded<T> = T extends CHType<string, any, infer I> ? I : never

export type ColumnDefs = Record<string, CHType<string, any, any>>

/** Convert a query's Output record to synthetic ColumnDefs for subquery-as-table usage. */
export type OutputToColumnDefs<O extends Record<string, any>> = {
	readonly [K in keyof O & string]: CHType<"Inferred", O[K], unknown>
}

/** Wrap each column type with `| null` for LEFT JOIN results. */
export type NullableColumnDefs<Cols extends ColumnDefs> = {
	readonly [K in keyof Cols & string]: CHType<
		"Nullable",
		InferTS<Cols[K]> | null,
		InferEncoded<Cols[K]> | null
	>
}

// Constructors

export const string: CHString = chType("String", "String", Schema.String)
export const uint8: CHUInt8 = chType("UInt8", "UInt8", CHNumber)
export const uint16: CHUInt16 = chType("UInt16", "UInt16", CHNumber)
export const uint32: CHUInt32 = chType("UInt32", "UInt32", CHNumber)
export const uint64: CHUInt64 = chType("UInt64", "UInt64", CHNumber)
export const int32: CHInt32 = chType("Int32", "Int32", CHNumber)
export const int64: CHInt64 = chType("Int64", "Int64", CHNumber)
export const float64: CHFloat64 = chType("Float64", "Float64", CHNumber)
export const dateTime: CHDateTime = chType("DateTime", "DateTime", CHDateTimeUtc, CHDateTimeLiteral)
export const dateTime64: CHDateTime64 = chType("DateTime64", "DateTime64", CHDateTimeUtc, CHDateTimeLiteral)
export const bool: CHBool = chType("Bool", "Bool", CHBoolean)
export const dateTimeString: CHDateTimeString = chType(
	"DateTime",
	"DateTime",
	Schema.String,
	CHDateTimeLiteral,
)
export const dateTime64String: CHDateTime64String = chType(
	"DateTime64",
	"DateTime64",
	Schema.String,
	CHDateTimeLiteral,
)

export const map = <K extends CHType<string, string, any>, V extends CHType<string, any, any>>(
	k: K,
	v: V,
): CHMap<K, V> =>
	chType("Map", `Map(${k.sql}, ${v.sql})`, Schema.Record(Schema.String, v.schema), undefined, v) as CHMap<
		K,
		V
	>

export const array = <E extends CHType<string, any, any>>(e: E): CHArray<E> =>
	chType("Array", `Array(${e.sql})`, Schema.Array(e.schema), undefined, e) as CHArray<E>

export const nullable = <T extends CHType<string, any, any>>(t: T): CHNullable<T> =>
	chType("Nullable", `Nullable(${t.sql})`, Schema.NullOr(t.schema), undefined, t) as CHNullable<T>

/**
 * A column type of your own: a ClickHouse type name and the schema its wire
 * value decodes with.
 *
 * This is the extension point behind everything above — `T.uint64` is
 * `custom("UInt64", CHNumber)`. Declare one for a type this package does not
 * model (an `Enum8`, a `Decimal`, an id you want branded) and it works
 * everywhere a built-in does: rows decode through it, literals and
 * `param.of(type, name)` encode through it.
 */
export const custom = <const Sql extends string, A, I>(
	sql: Sql,
	schema: Schema.Codec<A, I>,
	/** Only when comparisons accept more than the column decodes to. */
	literalSchema?: Schema.Codec<any, any>,
): CHType<Sql, A, I> => chType(sql, sql, schema, literalSchema)

/**
 * An `AggregateFunction(fn, args…)` state column.
 *
 * The value is ClickHouse's opaque binary state, only ever consumed by a
 * matching `-Merge` in an outer query — it is never a row the client decodes.
 * `Schema.Unknown` says exactly that, and saying it is the point: an aggregate
 * state selected in an inner subquery used to be a `rawExpr` with no type,
 * which stopped that subquery's *other* columns from deriving a row schema too.
 */
export const aggregateState = (
	fn: string,
	...args: ReadonlyArray<string>
): CHType<"AggregateFunction", unknown, unknown> =>
	chType("AggregateFunction", `AggregateFunction(${[fn, ...args].join(", ")})`, Schema.Unknown)

/**
 * A column whose wire value is passed through unvalidated.
 *
 * The escape hatch for a type this package does not model yet, named for the
 * same reason `untypedExpr` and `defineUntypedFn` are: prefer a real type,
 * because an untyped column makes the whole query's derived row schema weaker.
 */
export const untyped = <const Tag extends string>(sql: Tag): CHType<Tag, unknown, unknown> =>
	chType(sql, sql, Schema.Unknown)

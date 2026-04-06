// ---------------------------------------------------------------------------
// ClickHouse Type Descriptors
//
// Phantom-typed descriptors that map ClickHouse column types to TypeScript
// types. The `_phantom` field is never read at runtime — it exists only so
// TypeScript can infer the correct TS type from a column definition.
// ---------------------------------------------------------------------------

export interface CHType<Tag extends string, TSType> {
  readonly _tag: Tag
  readonly _phantom?: TSType
}

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

export type CHString = CHType<"String", string>
export type CHUInt8 = CHType<"UInt8", number>
export type CHUInt16 = CHType<"UInt16", number>
export type CHUInt32 = CHType<"UInt32", number>
export type CHUInt64 = CHType<"UInt64", number>
export type CHInt32 = CHType<"Int32", number>
export type CHFloat64 = CHType<"Float64", number>
export type CHDateTime = CHType<"DateTime", string>
export type CHDateTime64 = CHType<"DateTime64", string>
export type CHBool = CHType<"Bool", boolean>

// ---------------------------------------------------------------------------
// Compound types
// ---------------------------------------------------------------------------

export type CHMap<
  _K extends CHType<string, string>,
  V extends CHType<string, any>,
> = CHType<"Map", Record<string, InferTS<V>>>

export type CHArray<E extends CHType<string, any>> = CHType<
  "Array",
  ReadonlyArray<InferTS<E>>
>

export type CHNullable<T extends CHType<string, any>> = CHType<
  "Nullable",
  InferTS<T> | null
>

// ---------------------------------------------------------------------------
// Type-level TS extraction
// ---------------------------------------------------------------------------

export type InferTS<T> = T extends CHType<string, infer TS> ? TS : never

export type ColumnDefs = Record<string, CHType<string, any>>

/** Convert a query's Output record to synthetic ColumnDefs for subquery-as-table usage. */
export type OutputToColumnDefs<O extends Record<string, any>> = {
  readonly [K in keyof O & string]: CHType<"Inferred", O[K]>
}

/** Wrap each column type with `| null` for LEFT JOIN results. */
export type NullableColumnDefs<Cols extends ColumnDefs> = {
  readonly [K in keyof Cols & string]: CHType<"Nullable", InferTS<Cols[K]> | null>
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const string: CHString = { _tag: "String" }
export const uint8: CHUInt8 = { _tag: "UInt8" }
export const uint16: CHUInt16 = { _tag: "UInt16" }
export const uint32: CHUInt32 = { _tag: "UInt32" }
export const uint64: CHUInt64 = { _tag: "UInt64" }
export const int32: CHInt32 = { _tag: "Int32" }
export const float64: CHFloat64 = { _tag: "Float64" }
export const dateTime: CHDateTime = { _tag: "DateTime" }
export const dateTime64: CHDateTime64 = { _tag: "DateTime64" }
export const bool: CHBool = { _tag: "Bool" }

export const map = <K extends CHType<string, string>, V extends CHType<string, any>>(
  _k: K,
  _v: V,
): CHMap<K, V> => ({ _tag: "Map" }) as CHMap<K, V>

export const array = <E extends CHType<string, any>>(
  _e: E,
): CHArray<E> => ({ _tag: "Array" }) as CHArray<E>

export const nullable = <T extends CHType<string, any>>(
  _t: T,
): CHNullable<T> => ({ _tag: "Nullable" }) as CHNullable<T>

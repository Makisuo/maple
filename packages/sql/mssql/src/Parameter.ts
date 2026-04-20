/**
 * @since 1.0.0
 */
import { identity } from "effect/Function"
import type { DataType } from "tedious/lib/data-type.ts"
import type { ParameterOptions } from "tedious/lib/request.ts"

/**
 * @category type id
 * @since 1.0.0
 */
export const TypeId: TypeId = "~@effect/sql-mssql/Parameter"

/**
 * @category type id
 * @since 1.0.0
 */
export type TypeId = "~@effect/sql-mssql/Parameter"

/**
 * @category model
 * @since 1.0.0
 */
export interface Parameter<out A> {
  readonly [TypeId]: (_: never) => A
  readonly _tag: "Parameter"
  readonly name: string
  readonly type: DataType
  readonly options: ParameterOptions
}

/**
 * @category constructor
 * @since 1.0.0
 */
export const make = <A>(
  name: string,
  type: DataType,
  options: ParameterOptions = {}
): Parameter<A> => ({
  [TypeId]: identity,
  _tag: "Parameter",
  name,
  type,
  options
})

/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as IndexedDbTable from "./IndexedDbTable.ts"

const TypeId = "~@effect/platform-browser/IndexedDbVersion"

/**
 * @since 4.0.0
 * @category interface
 */
export interface IndexedDbVersion<
  out Tables extends IndexedDbTable.AnyWithProps
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly tables: ReadonlyMap<string, Tables>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnyWithProps = IndexedDbVersion<IndexedDbTable.AnyWithProps>

/**
 * @since 4.0.0
 * @category models
 */
export type Tables<Db extends Any> = Db extends IndexedDbVersion<infer _Tables> ? _Tables : never

/**
 * @since 4.0.0
 * @category models
 */
export type TableWithName<
  Db extends Any,
  TableName extends string
> = IndexedDbTable.WithName<Tables<Db>, TableName>

/**
 * @since 4.0.0
 * @category models
 */
export type SchemaWithName<
  Db extends Any,
  TableName extends string
> = IndexedDbTable.TableSchema<IndexedDbTable.WithName<Tables<Db>, TableName>>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <Tables extends IndexedDbTable.AnyWithProps>(options: {
  readonly tables: ReadonlyMap<string, Tables>
}): IndexedDbVersion<Tables> => {
  // oxlint-disable-next-line typescript/no-extraneous-class
  class Version {}
  Object.assign(Version, Proto)
  ;(Version as any).tables = options.tables
  return Version as any
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <
  const Tables extends NonEmptyReadonlyArray<IndexedDbTable.AnyWithProps>
>(
  ...tables: Tables
): IndexedDbVersion<Tables[number]> =>
  makeProto({
    tables: new Map(tables.map((table) => [table.tableName, table]))
  })

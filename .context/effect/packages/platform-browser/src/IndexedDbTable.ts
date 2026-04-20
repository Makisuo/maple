/**
 * @since 4.0.0
 */
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import type { NoInfer } from "effect/Types"
import * as IndexedDb from "./IndexedDb.ts"
import type * as IndexedDbQueryBuilder from "./IndexedDbQueryBuilder.ts"

const TypeId = "~@effect/platform-browser/IndexedDbTable"

/**
 * @since 4.0.0
 * @category interface
 */
export interface IndexedDbTable<
  out Name extends string,
  out TableSchema extends AnySchemaStruct,
  out Indexes extends Record<
    string,
    IndexedDbQueryBuilder.KeyPath<TableSchema>
  >,
  out KeyPath extends Readonly<IDBValidKey | undefined>,
  out AutoIncrement extends boolean
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly tableName: Name
  readonly tableSchema: TableSchema
  readonly readSchema: Schema.Top
  readonly autoincrementSchema: Schema.Top
  readonly arraySchema: Schema.Top
  readonly keyPath: KeyPath
  readonly indexes: Indexes
  readonly autoIncrement: AutoIncrement
  readonly durability: IDBTransactionDurability
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnySchemaStruct = Schema.Top & {
  readonly fields: Schema.Struct.Fields
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly keyPath: any
  readonly tableName: string
  readonly tableSchema: Schema.Top
  readonly readSchema: Schema.Top
  readonly autoincrementSchema: Schema.Top
  readonly arraySchema: Schema.Top
  readonly autoIncrement: boolean
  readonly indexes: any
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnyWithProps = IndexedDbTable<
  string,
  AnySchemaStruct,
  any,
  any,
  boolean
>

/**
 * @since 4.0.0
 * @category models
 */
export type TableName<Table extends Any> = Table["tableName"]
/**
 * @since 4.0.0
 * @category models
 */
export type KeyPath<Table extends Any> = Table["keyPath"]

/**
 * @since 4.0.0
 * @category models
 */
export type AutoIncrement<Table extends Any> = Table["autoIncrement"]

/**
 * @since 4.0.0
 * @category models
 */
export type TableSchema<Table extends Any> = Table["tableSchema"]
/**
 * @since 4.0.0
 * @category models
 */
export type Context<Table extends Any> =
  | Table["tableSchema"]["DecodingServices"]
  | Table["tableSchema"]["EncodingServices"]

/**
 * @since 4.0.0
 * @category models
 */
export type Encoded<Table extends Any> = Table["tableSchema"]["Encoded"]

/**
 * @since 4.0.0
 * @category models
 */
export type Indexes<Table extends Any> = Table["indexes"]

/**
 * @since 4.0.0
 * @category models
 */
export type WithName<Table extends Any, TableName extends string> = Extract<
  Table,
  { readonly tableName: TableName }
>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <
  const Name extends string,
  TableSchema extends AnySchemaStruct,
  const Indexes extends Record<
    string,
    IndexedDbQueryBuilder.KeyPath<TableSchema>
  >,
  const KeyPath extends
    | (AutoIncrement extends true ? IndexedDbQueryBuilder.KeyPathNumber<NoInfer<TableSchema>>
      : IndexedDbQueryBuilder.KeyPath<NoInfer<TableSchema>>)
    | undefined = undefined,
  const AutoIncrement extends boolean = false
>(options: {
  readonly name: Name
  readonly schema: [KeyPath] extends [undefined]
    ? "key" extends keyof TableSchema["fields"] ? "Cannot have a 'key' field when keyPath is undefined"
    : TableSchema
    : TableSchema
  readonly keyPath?: KeyPath
  readonly indexes?: Indexes | undefined
  readonly autoIncrement?: IsValidAutoIncrementKeyPath<
    TableSchema,
    KeyPath
  > extends true ? AutoIncrement | undefined
    : never
  readonly durability?: IDBTransactionDurability | undefined
}): IndexedDbTable<
  Name,
  TableSchema,
  Indexes,
  Extract<KeyPath, Readonly<IDBValidKey | undefined>>,
  AutoIncrement
> => {
  // oxlint-disable-next-line typescript/no-extraneous-class
  class Table {}
  Object.assign(Table, Proto)
  const readSchema = options.keyPath === undefined
    ? Schema.Struct({
      ...(options.schema as Schema.Struct<{}>).fields,
      key: IndexedDb.IDBValidKey
    })
    : options.schema
  ;(Table as any).tableName = options.name
  ;(Table as any).tableSchema = options.schema
  ;(Table as any).readSchema = readSchema
  ;(Table as any).arraySchema = Schema.Array(readSchema as any)
  ;(Table as any).autoincrementSchema = options.autoIncrement
    ? Schema.Struct(Struct.omit((options.schema as Schema.Struct<{}>).fields, [options.keyPath!] as any))
    : options.schema
  ;(Table as any).keyPath = options.keyPath
  ;(Table as any).indexes = options.indexes
  ;(Table as any).autoIncrement = options.autoIncrement === true
  ;(Table as any).durability = options.durability ?? "relaxed"
  return Table as any
}

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

type IsValidAutoIncrementKeyPath<
  TableSchema extends AnySchemaStruct,
  KeyPath
> = KeyPath extends keyof TableSchema["Encoded"] ? TableSchema["Encoded"][KeyPath] extends number ? true
  : false
  : false

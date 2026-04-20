/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type { Inspectable } from "effect/Inspectable"
import { BaseProto } from "effect/Inspectable"
import type * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Pipeable from "effect/Pipeable"
import type * as Queue from "effect/Queue"
import type * as Record from "effect/Record"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Utils from "effect/Utils"
import type * as IndexedDb from "./IndexedDb.ts"
import type * as IndexedDbDatabase from "./IndexedDbDatabase.ts"
import type * as IndexedDbTable from "./IndexedDbTable.ts"
import type * as IndexedDbVersion from "./IndexedDbVersion.ts"

const ErrorTypeId = "~@effect/platform-browser/IndexedDbQueryBuilder/IndexedDbQueryError"

const CommonProto = {
  [Symbol.iterator]() {
    return new Utils.SingleShotGen(this) as any
  },
  ...Pipeable.Prototype,
  ...BaseProto,
  toJSON(this: any) {
    return {
      _id: "IndexedDbQueryBuilder"
    }
  }
}

/**
 * @since 4.0.0
 * @category errors
 */
export type ErrorReason =
  | "NotFoundError"
  | "UnknownError"
  | "DecodeError"
  | "EncodeError"
  | "TransactionError"

/**
 * @since 4.0.0
 * @category errors
 */
export class IndexedDbQueryError extends Data.TaggedError(
  "IndexedDbQueryError"
)<{
  reason: ErrorReason
  cause: unknown
}> {
  /**
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: typeof ErrorTypeId = ErrorTypeId

  override readonly message = this.reason
}

/**
 * @since 4.0.0
 * @category models
 */
export interface IndexedDbQueryBuilder<
  Source extends IndexedDbVersion.AnyWithProps
> extends Pipeable.Pipeable, Inspectable {
  readonly tables: ReadonlyMap<string, IndexedDbVersion.Tables<Source>>
  readonly database: MutableRef.MutableRef<globalThis.IDBDatabase>
  readonly reactivity: Reactivity.Reactivity["Service"]
  readonly IDBKeyRange: typeof globalThis.IDBKeyRange
  readonly IDBTransaction: globalThis.IDBTransaction | undefined

  readonly use: <A = unknown>(
    f: (database: globalThis.IDBDatabase) => A
  ) => Effect.Effect<A, IndexedDbQueryError>

  readonly from: <
    const Name extends IndexedDbTable.TableName<
      IndexedDbVersion.Tables<Source>
    >
  >(
    table: Name
  ) => IndexedDbQuery.From<IndexedDbVersion.TableWithName<Source, Name>>

  readonly clearAll: Effect.Effect<void, IndexedDbQueryError>

  readonly withTransaction: <
    Tables extends NonEmptyReadonlyArray<
      IndexedDbTable.TableName<IndexedDbVersion.Tables<Source>>
    >,
    Mode extends "readonly" | "readwrite"
  >(options: {
    readonly tables: Tables
    readonly mode: Mode
    readonly durability?: IDBTransactionDurability
  }) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, IndexedDbTransaction>>
}

/**
 * @since 4.0.0
 * @category models
 */
export type KeyPath<TableSchema extends IndexedDbTable.AnySchemaStruct> =
  | IndexedDbValidKeys<TableSchema>
  | NonEmptyReadonlyArray<IndexedDbValidKeys<TableSchema>>

/**
 * @since 4.0.0
 * @category models
 */
export type KeyPathNumber<TableSchema extends IndexedDbTable.AnySchemaStruct> =
  | IndexedDbValidNumberKeys<TableSchema>
  | NonEmptyReadonlyArray<IndexedDbValidNumberKeys<TableSchema>>

/**
 * @since 4.0.0
 * @category models
 */
export declare namespace IndexedDbQuery {
  /**
   * @since 4.0.0
   * @category models
   */
  export type SelectType<
    Table extends IndexedDbTable.AnyWithProps
  > = [IndexedDbTable.KeyPath<Table>] extends [undefined] ? IndexedDbTable.TableSchema<Table>["Type"] & {
      readonly key: (typeof IndexedDb.IDBValidKey)["Type"]
    } :
    IndexedDbTable.TableSchema<Table>["Type"]

  /**
   * @since 4.0.0
   * @category models
   */
  export type ModifyType<
    Table extends IndexedDbTable.AnyWithProps
  > =
    & (IndexedDbTable.AutoIncrement<Table> extends true ?
        & {
          [
            key in keyof Schema.Struct.MakeIn<
              Omit<
                IndexedDbTable.TableSchema<Table>["fields"],
                IndexedDbTable.KeyPath<Table>
              >
            >
          ]: key extends keyof Schema.Struct.MakeIn<
            IndexedDbTable.TableSchema<Table>["fields"]
          > ? Schema.Struct.MakeIn<
              IndexedDbTable.TableSchema<Table>["fields"]
            >[key]
            : never
        }
        & {
          [key in IndexedDbTable.KeyPath<Table>]?: number | undefined
        }
      : Schema.Struct.MakeIn<IndexedDbTable.TableSchema<Table>["fields"]>)
    & ([IndexedDbTable.KeyPath<Table>] extends [undefined] ? {
        key: IDBValidKey
      }
      : {})

  /**
   * @since 4.0.0
   * @category models
   */
  export type EqualsType<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends keyof Table["indexes"],
    KeyPath = [Index] extends [never] ? Table["keyPath"] : Table["indexes"][Index],
    Type = Table["tableSchema"]["Encoded"]
  > = KeyPath extends keyof Type ? Type[KeyPath]
    : { [I in keyof KeyPath]: KeyPath[I] extends keyof Type ? Type[KeyPath[I]] | [] : never }

  /**
   * @since 4.0.0
   * @category models
   */
  export type ExtractIndexType<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends keyof Table["indexes"],
    KeyPath = [Index] extends [never] ? Table["keyPath"] : Table["indexes"][Index],
    Type = Table["tableSchema"]["Encoded"]
  > = KeyPath extends keyof Type ? Type[KeyPath]
    : KeyPath extends readonly [infer K, ...infer Rest] ? K extends keyof Type ? [
          Type[K],
          ...{ [P in keyof Rest]?: Rest[P] extends keyof Type ? Type[Rest[P]] | [] : never }
        ] :
      never :
    never

  /**
   * @since 4.0.0
   * @category models
   */
  export type ModifyWithKey<Table extends IndexedDbTable.AnyWithProps> = ModifyType<Table>

  /**
   * @since 4.0.0
   * @category models
   */
  export interface From<Table extends IndexedDbTable.AnyWithProps> {
    readonly table: Table
    readonly database: MutableRef.MutableRef<globalThis.IDBDatabase>
    readonly IDBKeyRange: typeof globalThis.IDBKeyRange
    readonly reactivity: Reactivity.Reactivity["Service"]

    readonly clear: Effect.Effect<void, IndexedDbQueryError>

    readonly select: {
      <Index extends IndexedDbDatabase.IndexFromTable<Table>>(
        index: Index
      ): Select<Table, Index>
      (): Select<Table, never>
    }

    readonly count: {
      <Index extends IndexedDbDatabase.IndexFromTable<Table>>(
        index: Index
      ): Count<Table, Index>
      (): Count<Table, never>
    }

    readonly delete: {
      <Index extends IndexedDbDatabase.IndexFromTable<Table>>(
        index: Index
      ): DeletePartial<Table, Index>
      (): DeletePartial<Table, never>
    }

    readonly insert: (value: ModifyWithKey<Table>) => Modify<Table>
    readonly insertAll: (
      values: Array<ModifyWithKey<Table>>
    ) => ModifyAll<Table>
    readonly upsert: (value: ModifyWithKey<Table>) => Modify<Table>
    readonly upsertAll: (
      values: Array<ModifyWithKey<Table>>
    ) => ModifyAll<Table>
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Clear<
    Table extends IndexedDbTable.AnyWithProps
  > extends Pipeable.Pipeable, Effect.YieldableClass<void, IndexedDbQueryError> {
    readonly from: From<Table>
  }

  type ComparisonKeys = "equals" | "gte" | "lte" | "gt" | "lt" | "between"

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Count<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>
  > extends Pipeable.Pipeable, Effect.YieldableClass<number, IndexedDbQueryError> {
    readonly from: From<Table>
    readonly index?: Index
    readonly only?: ExtractIndexType<Table, Index>
    readonly lowerBound?: ExtractIndexType<Table, Index>
    readonly upperBound?: ExtractIndexType<Table, Index>
    readonly excludeLowerBound?: boolean
    readonly excludeUpperBound?: boolean

    readonly equals: (
      value: EqualsType<Table, Index>
    ) => Omit<Count<Table, Index>, ComparisonKeys>

    readonly gte: (
      value: ExtractIndexType<Table, Index>
    ) => Omit<Count<Table, Index>, ComparisonKeys>

    readonly lte: (
      value: ExtractIndexType<Table, Index>
    ) => Omit<Count<Table, Index>, ComparisonKeys>

    readonly gt: (
      value: ExtractIndexType<Table, Index>
    ) => Omit<Count<Table, Index>, ComparisonKeys>

    readonly lt: (
      value: ExtractIndexType<Table, Index>
    ) => Omit<Count<Table, Index>, ComparisonKeys>

    readonly between: (
      lowerBound: ExtractIndexType<Table, Index>,
      upperBound: ExtractIndexType<Table, Index>,
      options?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
    ) => Omit<Count<Table, Index>, ComparisonKeys>
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface DeletePartial<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>
  > {
    readonly from: From<Table>
    readonly index?: Index

    readonly equals: (
      value: EqualsType<Table, Index>
    ) => Delete<Table, Index>

    readonly gte: (
      value: ExtractIndexType<Table, Index>
    ) => Delete<Table, Index>

    readonly lte: (
      value: ExtractIndexType<Table, Index>
    ) => Delete<Table, Index>

    readonly gt: (
      value: ExtractIndexType<Table, Index>
    ) => Delete<Table, Index>

    readonly lt: (
      value: ExtractIndexType<Table, Index>
    ) => Delete<Table, Index>

    readonly between: (
      lowerBound: ExtractIndexType<Table, Index>,
      upperBound: ExtractIndexType<Table, Index>,
      options?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
    ) => Delete<Table, Index>

    readonly limit: (
      limit: number
    ) => DeleteWithout<Table, Index, "limit">
  }

  type DeleteWithout<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>,
    ExcludedKeys extends string
  > = Omit<Delete<Table, Index, ExcludedKeys>, ExcludedKeys>

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Delete<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>,
    ExcludedKeys extends string = never
  > extends Pipeable.Pipeable, Effect.YieldableClass<void, IndexedDbQueryError> {
    readonly delete: DeletePartial<Table, Index>
    readonly index?: Index
    readonly limitValue?: number
    readonly only?: ExtractIndexType<Table, Index>
    readonly lowerBound?: ExtractIndexType<Table, Index>
    readonly upperBound?: ExtractIndexType<Table, Index>
    readonly excludeLowerBound?: boolean
    readonly excludeUpperBound?: boolean
    readonly predicate?: (item: IndexedDbTable.Encoded<Table>) => boolean

    readonly limit: (
      limit: number
    ) => DeleteWithout<Table, Index, ExcludedKeys | "limit">

    readonly filter: (
      f: (value: IndexedDbTable.Encoded<Table>) => boolean
    ) => DeleteWithout<Table, Index, ExcludedKeys>

    /**
     * Invalidate any queries using Reactivity service with the provided keys.
     *
     * Defaults to using the table name as a key if no keys are provided.
     */
    readonly invalidate: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Effect.Effect<void, IndexedDbQueryError, IndexedDbTable.Context<Table>>
  }

  type SelectWithout<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>,
    ExcludedKeys extends string
  > = Omit<Select<Table, Index, ExcludedKeys>, ExcludedKeys>

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Select<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>,
    ExcludedKeys extends string = never
  > extends
    Pipeable.Pipeable,
    Effect.YieldableClass<
      Array<SelectType<Table>>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
  {
    readonly from: From<Table>
    readonly index?: Index
    readonly limitValue?: number
    readonly offsetValue?: number
    readonly reverseValue?: boolean
    readonly only?: ExtractIndexType<Table, Index>
    readonly lowerBound?: ExtractIndexType<Table, Index>
    readonly upperBound?: ExtractIndexType<Table, Index>
    readonly excludeLowerBound?: boolean
    readonly excludeUpperBound?: boolean
    readonly predicate?: (item: IndexedDbTable.Encoded<Table>) => boolean

    readonly equals: (
      value: EqualsType<Table, Index>
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly gte: (
      value: ExtractIndexType<Table, Index>
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly lte: (
      value: ExtractIndexType<Table, Index>
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly gt: (
      value: ExtractIndexType<Table, Index>
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly lt: (
      value: ExtractIndexType<Table, Index>
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly between: (
      lowerBound: ExtractIndexType<Table, Index>,
      upperBound: ExtractIndexType<Table, Index>,
      options?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
    ) => SelectWithout<Table, Index, ExcludedKeys | ComparisonKeys>

    readonly limit: (
      limit: number
    ) => SelectWithout<Table, Index, ExcludedKeys | "limit" | "first">

    readonly offset: (
      offset: number
    ) => SelectWithout<Table, Index, ExcludedKeys | "offset" | "first">

    readonly reverse: () => SelectWithout<Table, Index, ExcludedKeys | "reverse" | "first">

    readonly filter: (
      f: (value: IndexedDbTable.Encoded<Table>) => boolean
    ) => SelectWithout<Table, Index, ExcludedKeys | "first">

    readonly first: () => First<Table, Index>

    /**
     * Stream the selected data.
     *
     * Defaults to a chunk size of 100.
     */
    readonly stream: (options?: {
      readonly chunkSize?: number | undefined
    }) => Stream.Stream<
      SelectType<Table>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >

    /**
     * Use the Reactivity service to react to changes to the selected data.
     *
     * By default it uses the table name as a key.
     */
    readonly reactive: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Stream.Stream<
      Array<SelectType<Table>>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
    readonly reactiveQueue: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Effect.Effect<
      Queue.Dequeue<Array<SelectType<Table>>, IndexedDbQueryError>,
      never,
      Scope.Scope | IndexedDbTable.Context<Table>
    >
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface First<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>
  > extends
    Pipeable.Pipeable,
    Effect.YieldableClass<
      SelectType<Table>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
  {
    readonly select: Select<Table, Index>

    /**
     * Use the Reactivity service to react to changes to the selected data.
     *
     * By default it uses the table name as a key.
     */
    readonly reactive: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Stream.Stream<
      SelectType<Table>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >

    /**
     * Use the Reactivity service to react to changes to the selected data.
     *
     * By default it uses the table name as a key.
     */
    readonly reactiveQueue: (
      keys: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>>
    ) => Effect.Effect<
      Queue.Dequeue<SelectType<Table>, IndexedDbQueryError>,
      never,
      Scope.Scope | IndexedDbTable.Context<Table>
    >
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Filter<
    Table extends IndexedDbTable.AnyWithProps,
    Index extends IndexedDbDatabase.IndexFromTable<Table>
  > extends
    Pipeable.Pipeable,
    Effect.YieldableClass<
      Array<SelectType<Table>>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
  {
    readonly select: Select<Table, Index>
    readonly predicate: (item: IndexedDbTable.Encoded<Table>) => boolean
    readonly filter: (
      f: (value: IndexedDbTable.Encoded<Table>) => boolean
    ) => Filter<Table, Index>
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface Modify<
    Table extends IndexedDbTable.AnyWithProps
  > extends
    Pipeable.Pipeable,
    Effect.YieldableClass<
      globalThis.IDBValidKey,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
  {
    readonly operation: "add" | "put"
    readonly from: From<Table>
    readonly value: ModifyWithKey<Table>

    /**
     * Invalidate any queries using Reactivity service with the provided keys.
     *
     * Defaults to using the table name as a key if no keys are provided.
     */
    readonly invalidate: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Effect.Effect<globalThis.IDBValidKey, IndexedDbQueryError, IndexedDbTable.Context<Table>>
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export interface ModifyAll<
    Table extends IndexedDbTable.AnyWithProps
  > extends
    Pipeable.Pipeable,
    Effect.YieldableClass<
      Array<globalThis.IDBValidKey>,
      IndexedDbQueryError,
      IndexedDbTable.Context<Table>
    >
  {
    readonly operation: "add" | "put"
    readonly from: From<Table>
    readonly values: Array<ModifyWithKey<Table>>

    /**
     * Invalidate any queries using Reactivity service with the provided keys.
     *
     * Defaults to using the table name as a key if no keys are provided.
     */
    readonly invalidate: (
      keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    ) => Effect.Effect<globalThis.IDBValidKey, IndexedDbQueryError, IndexedDbTable.Context<Table>>
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export class IndexedDbTransaction extends Context.Service<IndexedDbTransaction, globalThis.IDBTransaction>()(
  "@effect/platform-browser/IndexedDbQueryBuilder/IndexedDbTransaction"
) {}

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

type IndexedDbValidKeys<TableSchema extends IndexedDbTable.AnySchemaStruct> = keyof TableSchema["Encoded"] extends
  infer K ? K extends keyof TableSchema["Encoded"] ? TableSchema["Encoded"][K] extends Readonly<IDBValidKey> ? K
    : never
  : never
  : never

type IndexedDbValidNumberKeys<
  TableSchema extends IndexedDbTable.AnySchemaStruct
> = keyof TableSchema["Encoded"] extends infer K
  ? K extends keyof TableSchema["Encoded"] ? [TableSchema["Encoded"][K]] extends [number | undefined] ? K
    : never
  : never
  : never

const applyDelete = (query: IndexedDbQuery.Delete<any, never>) =>
  Effect.callback<any, IndexedDbQueryError>((resume) => {
    const database = query.delete.from.database
    const IDBKeyRange = query.delete.from.IDBKeyRange
    const transaction = getOrCreateTransaction(database.current, [query.delete.from.table.tableName], "readwrite", {
      durability: query.delete.from.table.durability
    })
    const objectStore = transaction.objectStore(query.delete.from.table.tableName)
    const predicate = query.predicate

    let keyRange: globalThis.IDBKeyRange | undefined = undefined

    if (query.only !== undefined) {
      keyRange = IDBKeyRange.only(query.only)
    } else if (
      query.lowerBound !== undefined &&
      query.upperBound !== undefined
    ) {
      keyRange = IDBKeyRange.bound(
        query.lowerBound,
        query.upperBound,
        query.excludeLowerBound,
        query.excludeUpperBound
      )
    } else if (query.lowerBound !== undefined) {
      keyRange = IDBKeyRange.lowerBound(
        query.lowerBound,
        query.excludeLowerBound
      )
    } else if (query.upperBound !== undefined) {
      keyRange = IDBKeyRange.upperBound(
        query.upperBound,
        query.excludeUpperBound
      )
    }

    let request: globalThis.IDBRequest

    if (query.limitValue !== undefined || predicate) {
      const cursorRequest = objectStore.openCursor()
      let count = 0

      cursorRequest.onerror = () => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: cursorRequest.error
            })
          )
        )
      }

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) {
          return resume(Effect.void)
        }

        if (predicate === undefined || predicate(cursor.value)) {
          const deleteRequest = cursor.delete()
          deleteRequest.onerror = () => {
            resume(
              Effect.fail(
                new IndexedDbQueryError({
                  reason: "TransactionError",
                  cause: deleteRequest.error
                })
              )
            )
          }
          count += 1
        }

        if (query.limitValue === undefined || count < query.limitValue) {
          return cursor.continue()
        }

        resume(Effect.void)
      }
    } else if (keyRange !== undefined) {
      request = objectStore.delete(keyRange)

      request.onerror = (event) => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: event
            })
          )
        )
      }

      request.onsuccess = () => {
        resume(Effect.succeed(request.result))
      }
    } else {
      resume(
        Effect.die(new Error("No key range provided for delete operation"))
      )
    }
  })

const getReadonlyObjectStore = (
  query: IndexedDbQuery.Select<any, never> | IndexedDbQuery.Count<any, never>
) => {
  const database = query.from.database
  const IDBKeyRange = query.from.IDBKeyRange
  const transaction = getOrCreateTransaction(database.current, [query.from.table.tableName], "readonly", {
    durability: query.from.table.durability
  })
  const objectStore = transaction.objectStore(query.from.table.tableName)

  let keyRange: globalThis.IDBKeyRange | undefined = undefined
  let store: globalThis.IDBObjectStore | globalThis.IDBIndex

  if (query.only !== undefined) {
    keyRange = IDBKeyRange.only(query.only)
  } else if (query.lowerBound !== undefined && query.upperBound !== undefined) {
    keyRange = IDBKeyRange.bound(
      query.lowerBound,
      query.upperBound,
      query.excludeLowerBound,
      query.excludeUpperBound
    )
  } else if (query.lowerBound !== undefined) {
    keyRange = IDBKeyRange.lowerBound(
      query.lowerBound,
      query.excludeLowerBound
    )
  } else if (query.upperBound !== undefined) {
    keyRange = IDBKeyRange.upperBound(
      query.upperBound,
      query.excludeUpperBound
    )
  }

  if (query.index !== undefined) {
    store = objectStore.index(query.index)
  } else {
    store = objectStore
  }

  return { store, keyRange }
}

const applySelect = Effect.fnUntraced(function*(
  query: IndexedDbQuery.Select<any, never, any>
): Effect.fn.Return<Array<any>, IndexedDbQueryError, unknown> {
  const keyPath = query.from.table.keyPath
  const predicate = query.predicate

  const data = predicate || keyPath === undefined || query.offsetValue !== undefined ?
    yield* Effect.callback<Array<any>, IndexedDbQueryError>((resume) => {
      const { keyRange, store } = getReadonlyObjectStore(query)

      const cursorRequest = store.openCursor(keyRange, query.reverseValue ? "prev" : "next")
      const results: Array<any> = []
      let count = 0
      let offsetApplied = false

      cursorRequest.onerror = () => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: cursorRequest.error
            })
          )
        )
      }

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) {
          return resume(Effect.succeed(results))
        }

        if (query.offsetValue && !offsetApplied) {
          offsetApplied = true
          return cursor.advance(query.offsetValue)
        }

        if (predicate === undefined || predicate(cursor.value)) {
          results.push(
            keyPath === undefined
              ? { ...cursor.value, key: cursor.key }
              : cursor.value
          )
          count += 1
        }

        if (query.limitValue === undefined || count < query.limitValue) {
          return cursor.continue()
        }

        resume(Effect.succeed(results))
      }
    }) :
    yield* Effect.callback<Array<any>, IndexedDbQueryError>((resume) => {
      const { keyRange, store } = getReadonlyObjectStore(query)
      const request = store.getAll(keyRange, query.limitValue)
      request.onerror = (event) => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: event
            })
          )
        )
      }
      request.onsuccess = () => {
        if (query.reverseValue) {
          request.result.reverse()
        }
        resume(Effect.succeed(request.result))
      }
    })

  const tableSchema = (query.from.table as IndexedDbTable.AnyWithProps).arraySchema

  return yield* Schema.decodeUnknownEffect(tableSchema)(data).pipe(
    Effect.mapError(
      (error) =>
        new IndexedDbQueryError({
          reason: "DecodeError",
          cause: error
        })
    )
  ) as Effect.Effect<Array<any>, IndexedDbQueryError, unknown>
})

const getFirst = Effect.fnUntraced(function*(
  query: IndexedDbQuery.First<any, never>
) {
  const keyPath = query.select.from.table.keyPath

  const data = yield* Effect.callback<any, IndexedDbQueryError>((resume) => {
    const { keyRange, store } = getReadonlyObjectStore(query.select)

    if (keyRange !== undefined) {
      const request = store.get(keyRange)

      request.onerror = (event) => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: event
            })
          )
        )
      }

      request.onsuccess = () => {
        resume(Effect.succeed(request.result))
      }
    } else {
      const request = store.openCursor()

      request.onerror = (event) => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: event
            })
          )
        )
      }

      request.onsuccess = () => {
        const value = request.result?.value
        const key = request.result?.key

        if (value === undefined) {
          resume(
            Effect.fail(
              new IndexedDbQueryError({
                reason: "NotFoundError",
                cause: request.error
              })
            )
          )
        } else {
          resume(
            Effect.succeed(keyPath === undefined ? { ...value, key } : value)
          )
        }
      }
    }
  })

  return yield* Schema.decodeUnknownEffect(query.select.from.table.readSchema)(
    data
  ).pipe(
    Effect.mapError(
      (error) =>
        new IndexedDbQueryError({
          reason: "DecodeError",
          cause: error
        })
    )
  )
})

const applyModify = Effect.fnUntraced(function*({
  query,
  value
}: {
  query: IndexedDbQuery.Modify<any>
  value: any
}) {
  const autoIncrement = query.from.table.autoIncrement as boolean
  const keyPath = query.from.table.keyPath
  const table = query.from.table
  const schema = autoIncrement && value[keyPath] === undefined
    ? table.autoincrementSchema
    : table.tableSchema

  const encodedValue = yield* SchemaParser.makeEffect(
    autoIncrement && value[keyPath] === undefined
      ? table.autoincrementSchema
      : table.tableSchema
  )(value).pipe(
    Effect.flatMap(Schema.encodeUnknownEffect(schema)),
    Effect.mapError(
      (error) =>
        new IndexedDbQueryError({
          reason: "EncodeError",
          cause: error
        })
    )
  )

  return yield* Effect.callback<any, IndexedDbQueryError>((resume) => {
    const database = query.from.database
    const transaction = getOrCreateTransaction(database.current, [query.from.table.tableName], "readwrite", {
      durability: query.from.table.durability
    })
    const objectStore = transaction.objectStore(query.from.table.tableName)

    let request: globalThis.IDBRequest<IDBValidKey>

    if (query.operation === "add") {
      request = objectStore.add(
        encodedValue,
        keyPath === undefined ? value["key"] : undefined
      )
    } else if (query.operation === "put") {
      request = objectStore.put(
        encodedValue,
        keyPath === undefined ? value["key"] : undefined
      )
    } else {
      return resume(Effect.die(new Error("Invalid modify operation")))
    }

    request.onerror = (event) => {
      resume(
        Effect.fail(
          new IndexedDbQueryError({
            reason: "TransactionError",
            cause: event
          })
        )
      )
    }

    request.onsuccess = () => {
      resume(Effect.succeed(request.result))
    }
  })
})

const applyModifyAll = Effect.fnUntraced(
  function*({
    query,
    values
  }: {
    query: IndexedDbQuery.ModifyAll<any>
    values: Array<any>
  }) {
    const autoIncrement = query.from.table.autoIncrement as boolean
    const keyPath = query.from.table.keyPath
    const schema = query.from.table.tableSchema
    const encodedValues = new Array(values.length)
    const makeValue = SchemaParser.makeEffect(schema)
    const encodeValue = SchemaParser.encodeUnknownEffect(schema)
    const makeValueAutoincrement = SchemaParser.makeEffect(query.from.table.autoincrementSchema)
    const encodeValueAutoincrement = SchemaParser.encodeUnknownEffect(query.from.table.autoincrementSchema)

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (autoIncrement && value[keyPath] === undefined) {
        encodedValues[i] = yield* encodeValueAutoincrement(yield* makeValueAutoincrement(value))
      } else {
        encodedValues[i] = yield* encodeValue(yield* makeValue(value))
      }
    }

    return yield* Effect.callback<
      Array<globalThis.IDBValidKey>,
      IndexedDbQueryError
    >((resume) => {
      const database = query.from.database
      const transaction = getOrCreateTransaction(database.current, [query.from.table.tableName], "readwrite", {
        durability: query.from.table.durability
      })
      const objectStore = transaction.objectStore(query.from.table.tableName)

      const results: Array<globalThis.IDBValidKey> = []

      if (query.operation === "add") {
        for (let i = 0; i < encodedValues.length; i++) {
          const request = objectStore.add(
            encodedValues[i],
            keyPath === undefined ? values[i]["key"] : undefined
          )

          request.onerror = () => {
            resume(
              Effect.fail(
                new IndexedDbQueryError({
                  reason: "TransactionError",
                  cause: request.error
                })
              )
            )
          }

          request.onsuccess = () => {
            results.push(request.result)
          }
        }
      } else if (query.operation === "put") {
        for (let i = 0; i < encodedValues.length; i++) {
          const request = objectStore.put(
            encodedValues[i],
            keyPath === undefined ? values[i]["key"] : undefined
          )

          request.onerror = () => {
            resume(
              Effect.fail(
                new IndexedDbQueryError({
                  reason: "TransactionError",
                  cause: request.error
                })
              )
            )
          }

          request.onsuccess = () => {
            results.push(request.result)
          }
        }
      } else {
        return resume(Effect.die(new Error("Invalid modify all operation")))
      }

      objectStore.transaction.onerror = () => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: objectStore.transaction.error
            })
          )
        )
      }

      objectStore.transaction.oncomplete = () => {
        resume(Effect.succeed(results))
      }
    })
  },
  Effect.catchIf(
    SchemaIssue.isIssue,
    (issue) => Effect.fail(new IndexedDbQueryError({ reason: "EncodeError", cause: new Schema.SchemaError(issue) }))
  )
)

const applyClear = (options: {
  readonly database: globalThis.IDBDatabase
  readonly table: IndexedDbTable.AnyWithProps
}) =>
  Effect.callback<void, IndexedDbQueryError>((resume) => {
    const database = options.database
    const transaction = getOrCreateTransaction(database, [options.table.tableName], "readwrite", {
      durability: options.table.durability
    })
    const objectStore = transaction.objectStore(options.table.tableName)

    const request = objectStore.clear()

    request.onerror = (event) => {
      resume(
        Effect.fail(
          new IndexedDbQueryError({
            reason: "TransactionError",
            cause: event
          })
        )
      )
    }

    request.onsuccess = () => {
      resume(Effect.void)
    }
  })

const applyClearAll = (options: {
  readonly database: globalThis.IDBDatabase
}) =>
  Effect.callback<void, IndexedDbQueryError>((resume) => {
    const database = options.database
    const tables = database.objectStoreNames
    const transaction = getOrCreateTransaction(database, [...tables], "readwrite")

    for (let t = 0; t < tables.length; t++) {
      const objectStore = transaction.objectStore(tables[t])
      const request = objectStore.clear()

      request.onerror = () => {
        resume(
          Effect.fail(
            new IndexedDbQueryError({
              reason: "TransactionError",
              cause: request.error
            })
          )
        )
      }
    }

    transaction.onerror = () => {
      resume(
        Effect.fail(
          new IndexedDbQueryError({
            reason: "TransactionError",
            cause: transaction.error
          })
        )
      )
    }

    transaction.oncomplete = () => {
      resume(Effect.void)
    }
  })

const getCount = (query: IndexedDbQuery.Count<any, never>) =>
  Effect.callback<number, IndexedDbQueryError>((resume) => {
    const { keyRange, store } = getReadonlyObjectStore(query)

    const request = store.count(keyRange)

    request.onerror = (event) => {
      resume(
        Effect.fail(
          new IndexedDbQueryError({
            reason: "TransactionError",
            cause: event
          })
        )
      )
    }

    request.onsuccess = () => {
      resume(Effect.succeed(request.result))
    }
  })

const FromProto: Omit<
  IndexedDbQuery.From<any>,
  | "table"
  | "database"
  | "IDBKeyRange"
  | "transaction"
  | "reactivity"
> = {
  ...CommonProto,
  select<Index extends IndexedDbDatabase.IndexFromTable<any>>(
    this: IndexedDbQuery.From<any>,
    index?: Index
  ) {
    return makeSelect({
      from: this,
      index
    }) as any
  },
  count<Index extends IndexedDbDatabase.IndexFromTable<any>>(
    this: IndexedDbQuery.From<any>,
    index?: Index
  ) {
    return makeCount({
      from: this,
      index
    }) as any
  },
  delete<Index extends IndexedDbDatabase.IndexFromTable<any>>(
    this: IndexedDbQuery.From<any>,
    index?: Index
  ) {
    return makeDeletePartial({
      from: this,
      index
    }) as any
  },
  insert(this: IndexedDbQuery.From<any>, value: any) {
    return makeModify({ from: this, value, operation: "add" })
  },
  upsert(this: IndexedDbQuery.From<any>, value: any) {
    return makeModify({ from: this, value, operation: "put" })
  },
  insertAll(this: IndexedDbQuery.From<any>, values: Array<any>) {
    return makeModifyAll({ from: this, values, operation: "add" })
  },
  upsertAll(this: IndexedDbQuery.From<any>, values: Array<any>) {
    return makeModifyAll({ from: this, values, operation: "put" })
  },
  get clear() {
    const self = this as IndexedDbQuery.From<any>
    return applyClear({
      database: self.database.current,
      table: self.table
    })
  }
}

const makeFrom = <
  const Table extends IndexedDbTable.AnyWithProps
>(options: {
  readonly table: Table
  readonly database: MutableRef.MutableRef<globalThis.IDBDatabase>
  readonly IDBKeyRange: typeof globalThis.IDBKeyRange
  readonly reactivity: Reactivity.Reactivity["Service"]
}): IndexedDbQuery.From<Table> => {
  const self = Object.create(FromProto)
  self.table = options.table
  self.database = options.database
  self.IDBKeyRange = options.IDBKeyRange
  self.reactivity = options.reactivity
  return self
}

const DeletePartialProto: Omit<
  IndexedDbQuery.DeletePartial<any, never>,
  | "from"
  | "index"
> = {
  ...CommonProto,
  limit(this: IndexedDbQuery.DeletePartial<any, never>, limit: number) {
    return makeDelete({
      delete: this as any,
      limitValue: limit
    })
  },
  equals(this: IndexedDbQuery.DeletePartial<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeDelete({
      delete: this as any,
      only: value
    })
  },
  gte(this: IndexedDbQuery.DeletePartial<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeDelete({
      delete: this as any,
      lowerBound: value,
      excludeLowerBound: false
    })
  },
  lte(this: IndexedDbQuery.DeletePartial<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeDelete({
      delete: this as any,
      upperBound: value,
      excludeUpperBound: false
    })
  },
  gt(this: IndexedDbQuery.DeletePartial<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeDelete({
      delete: this as any,
      lowerBound: value,
      excludeLowerBound: true
    })
  },
  lt(this: IndexedDbQuery.DeletePartial<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeDelete({
      delete: this as any,
      upperBound: value,
      excludeUpperBound: true
    })
  },
  between(
    this: IndexedDbQuery.DeletePartial<any, never>,
    lowerBound: IndexedDbQuery.ExtractIndexType<any, never>,
    upperBound: IndexedDbQuery.ExtractIndexType<any, never>,
    queryOptions?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
  ) {
    return makeDelete({
      delete: this as any,
      lowerBound,
      upperBound,
      excludeLowerBound: queryOptions?.excludeLowerBound ?? false,
      excludeUpperBound: queryOptions?.excludeUpperBound ?? false
    })
  }
}

const makeDeletePartial = <
  Table extends IndexedDbTable.AnyWithProps,
  Index extends IndexedDbDatabase.IndexFromTable<Table>
>(options: {
  readonly from: IndexedDbQuery.From<Table>
  readonly index: Index | undefined
}): IndexedDbQuery.DeletePartial<Table, Index> => {
  const self = Object.create(DeletePartialProto)
  self.from = options.from
  self.index = options.index
  return self as any
}

const DeleteProto: Omit<
  IndexedDbQuery.Delete<any, never>,
  | "delete"
  | "limitValue"
  | "only"
  | "lowerBound"
  | "upperBound"
  | "excludeLowerBound"
  | "excludeUpperBound"
  | "predicate"
> = {
  ...CommonProto,
  asEffect(this: IndexedDbQuery.Delete<any, never>) {
    return applyDelete(this) as any
  },
  limit(this: IndexedDbQuery.Delete<any, never>, limit: number) {
    return makeDelete({
      ...this,
      limitValue: limit
    })
  },
  filter(this: IndexedDbQuery.Delete<any, never>, filter: (value: IndexedDbTable.Encoded<any>) => boolean) {
    const prev = this.predicate
    return makeDelete({
      delete: this.delete,
      predicate: prev ? (item) => prev(item) && filter(item) : filter
    })
  },
  invalidate(
    this: IndexedDbQuery.Delete<any, never>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= this.only !== undefined
      ? { [this.delete.from.table.tableName]: [this.only] }
      : [this.delete.from.table.tableName]
    return this.delete.from.reactivity.mutation(keys, this.asEffect())
  }
}

const makeDelete = <
  Table extends IndexedDbTable.AnyWithProps,
  Index extends IndexedDbDatabase.IndexFromTable<Table>
>(options: {
  readonly delete: IndexedDbQuery.DeletePartial<Table, Index>
  readonly limitValue?: number | undefined
  readonly only?: IndexedDbQuery.ExtractIndexType<Table, Index> | undefined
  readonly lowerBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly upperBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly excludeLowerBound?: boolean | undefined
  readonly excludeUpperBound?: boolean | undefined
  readonly predicate?: ((item: IndexedDbTable.Encoded<Table>) => boolean) | undefined
}): IndexedDbQuery.Delete<Table, Index> => {
  const self = Object.create(DeleteProto)
  self.delete = options.delete
  self.limitValue = options.limitValue
  self.only = options.only
  self.lowerBound = options.lowerBound
  self.upperBound = options.upperBound
  self.excludeLowerBound = options.excludeLowerBound ?? false
  self.excludeUpperBound = options.excludeUpperBound ?? false
  self.predicate = options.predicate
  return self
}

const CountProto: Omit<
  IndexedDbQuery.Count<any, never>,
  | "from"
  | "index"
  | "only"
  | "lowerBound"
  | "upperBound"
  | "excludeLowerBound"
  | "excludeUpperBound"
> = {
  ...CommonProto,
  asEffect(this: IndexedDbQuery.Count<any, never>) {
    return getCount(this) as any
  },
  equals(this: IndexedDbQuery.Count<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeCount({
      from: this.from,
      index: this.index,
      only: value
    })
  },
  gte(this: IndexedDbQuery.Count<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeCount({
      from: this.from,
      index: this.index,
      lowerBound: value,
      excludeLowerBound: false
    })
  },
  lte(this: IndexedDbQuery.Count<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeCount({
      from: this.from,
      index: this.index,
      upperBound: value,
      excludeUpperBound: false
    })
  },
  gt(this: IndexedDbQuery.Count<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeCount({
      from: this.from,
      index: this.index,
      lowerBound: value,
      excludeLowerBound: true
    })
  },
  lt(this: IndexedDbQuery.Count<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeCount({
      from: this.from,
      index: this.index,
      upperBound: value,
      excludeUpperBound: true
    })
  },
  between(
    this: IndexedDbQuery.Count<any, never>,
    lowerBound: IndexedDbQuery.ExtractIndexType<any, never>,
    upperBound: IndexedDbQuery.ExtractIndexType<any, never>,
    queryOptions?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
  ) {
    return makeCount({
      from: this.from,
      index: this.index,
      lowerBound,
      upperBound,
      excludeLowerBound: queryOptions?.excludeLowerBound ?? false,
      excludeUpperBound: queryOptions?.excludeUpperBound ?? false
    })
  }
}

const makeCount = <
  Table extends IndexedDbTable.AnyWithProps,
  Index extends IndexedDbDatabase.IndexFromTable<Table>
>(options: {
  readonly from: IndexedDbQuery.From<Table>
  readonly index: Index | undefined
  readonly only?: IndexedDbQuery.ExtractIndexType<Table, Index> | undefined
  readonly lowerBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly upperBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly excludeLowerBound?: boolean | undefined
  readonly excludeUpperBound?: boolean | undefined
}): IndexedDbQuery.Count<Table, Index> => {
  const self = Object.create(CountProto)
  self.from = options.from
  self.index = options.index
  self.only = options.only
  self.lowerBound = options.lowerBound
  self.upperBound = options.upperBound
  self.excludeLowerBound = options.excludeLowerBound
  self.excludeUpperBound = options.excludeUpperBound
  return self
}

const SelectProto: Omit<
  IndexedDbQuery.Select<any, never>,
  | "from"
  | "index"
  | "limitValue"
  | "reverseValue"
  | "only"
  | "lowerBound"
  | "upperBound"
  | "excludeLowerBound"
  | "excludeUpperBound"
> = {
  ...CommonProto,
  limit(this: IndexedDbQuery.Select<any, never>, limit: number) {
    return makeSelect({
      ...this,
      limitValue: limit
    })
  },
  offset(this: IndexedDbQuery.Select<any, never>, offset: number) {
    return makeSelect({
      ...this,
      offsetValue: offset
    })
  },
  equals(this: IndexedDbQuery.Select<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeSelect({
      ...this,
      only: value
    })
  },
  gte(this: IndexedDbQuery.Select<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeSelect({
      ...this,
      lowerBound: value,
      excludeLowerBound: false
    })
  },
  lte(this: IndexedDbQuery.Select<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeSelect({
      ...this,
      upperBound: value,
      excludeUpperBound: false
    })
  },
  gt(this: IndexedDbQuery.Select<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeSelect({
      ...this,
      lowerBound: value,
      excludeLowerBound: true
    })
  },
  lt(this: IndexedDbQuery.Select<any, never>, value: IndexedDbQuery.ExtractIndexType<any, never>) {
    return makeSelect({
      ...this,
      upperBound: value,
      excludeUpperBound: true
    })
  },
  between(
    this: IndexedDbQuery.Select<any, never>,
    lowerBound: IndexedDbQuery.ExtractIndexType<any, never>,
    upperBound: IndexedDbQuery.ExtractIndexType<any, never>,
    queryOptions?: { excludeLowerBound?: boolean; excludeUpperBound?: boolean }
  ) {
    return makeSelect({
      ...this,
      lowerBound,
      upperBound,
      excludeLowerBound: queryOptions?.excludeLowerBound ?? false,
      excludeUpperBound: queryOptions?.excludeUpperBound ?? false
    })
  },
  reverse(this: IndexedDbQuery.Select<any, never>) {
    return makeSelect({
      ...this,
      reverseValue: true
    })
  },
  first(this: IndexedDbQuery.Select<any, never>) {
    return makeFirst({ select: this })
  },
  filter(this: IndexedDbQuery.Select<any, never>, filter: (value: IndexedDbTable.Encoded<any>) => boolean) {
    const prev = this.predicate
    return makeSelect({
      ...this,
      predicate: prev ? (item) => prev(item) && filter(item) : filter
    })
  },
  asEffect(this: IndexedDbQuery.Select<any, never>) {
    return applySelect(this) as any
  },
  stream(this: IndexedDbQuery.Select<any, never>, options?: {
    readonly chunkSize?: number | undefined
  }) {
    const limit = this.limitValue
    const chunkSize = Math.min(options?.chunkSize ?? 100, limit ?? Number.MAX_SAFE_INTEGER)
    const initial = this.limit(chunkSize)
    return Stream.suspend(() => {
      let total = 0
      return Stream.paginate(initial, (select) =>
        Effect.map(
          applySelect(select as any),
          (data) => {
            total += data.length
            ;(select as any).offsetValue = total
            const reachedLimit = limit && total >= limit
            const isPartial = data.length < chunkSize
            return [data, isPartial || reachedLimit ? Option.none() : Option.some(select)] as const
          }
        ))
    })
  },
  reactive(
    this: IndexedDbQuery.Select<any, never>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= [this.from.table.tableName]
    return this.from.reactivity.stream(keys, this.asEffect())
  },
  reactiveQueue(
    this: IndexedDbQuery.Select<any, never>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= [this.from.table.tableName]
    return this.from.reactivity.query(keys, this.asEffect())
  }
}

const makeSelect = <
  Table extends IndexedDbTable.AnyWithProps,
  Index extends IndexedDbDatabase.IndexFromTable<Table>
>(options: {
  readonly from: IndexedDbQuery.From<Table>
  readonly index?: Index | undefined
  readonly limitValue?: number | undefined
  readonly offsetValue?: number | undefined
  readonly reverseValue?: boolean | undefined
  readonly only?: IndexedDbQuery.ExtractIndexType<Table, Index> | undefined
  readonly lowerBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly upperBound?:
    | IndexedDbQuery.ExtractIndexType<Table, Index>
    | undefined
  readonly excludeLowerBound?: boolean | undefined
  readonly excludeUpperBound?: boolean | undefined
  readonly predicate?: ((item: IndexedDbTable.Encoded<Table>) => boolean) | undefined
}): IndexedDbQuery.Select<Table, Index> => {
  const self = Object.create(SelectProto)
  self.from = options.from
  self.index = options.index
  self.only = options.only
  self.limitValue = options.limitValue
  self.offsetValue = options.offsetValue
  self.reverseValue = options.reverseValue
  self.lowerBound = options.lowerBound
  self.upperBound = options.upperBound
  self.excludeLowerBound = options.excludeLowerBound
  self.excludeUpperBound = options.excludeUpperBound
  self.predicate = options.predicate
  return self as any
}

const FirstProto: Omit<
  IndexedDbQuery.First<any, never>,
  "select"
> = {
  ...CommonProto,
  asEffect(this: IndexedDbQuery.First<any, never>) {
    return getFirst(this) as any
  },
  reactive(
    this: IndexedDbQuery.First<any, never>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= this.select.only !== undefined
      ? [`${this.select.from.table.tableName}:${String(this.select.only)}`]
      : [this.select.from.table.tableName]
    return this.select.from.reactivity.stream(keys, this.asEffect())
  },
  reactiveQueue(
    this: IndexedDbQuery.First<any, never>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= this.select.only !== undefined
      ? [`${this.select.from.table.tableName}:${this.select.only}`]
      : [this.select.from.table.tableName]
    return this.select.from.reactivity.query(keys, this.asEffect())
  }
}

const makeFirst = <
  Table extends IndexedDbTable.AnyWithProps,
  Index extends IndexedDbDatabase.IndexFromTable<Table>
>(options: {
  readonly select: IndexedDbQuery.Select<Table, Index>
}): IndexedDbQuery.First<Table, Index> => {
  const self = Object.create(FirstProto)
  self.select = options.select
  return self as any
}

const ModifyProto: Omit<
  IndexedDbQuery.Modify<any>,
  | "from"
  | "value"
  | "operation"
> = {
  ...CommonProto,
  asEffect(this: IndexedDbQuery.Modify<any>) {
    return applyModify({ query: this, value: this.value }) as any
  },
  invalidate(
    this: IndexedDbQuery.Modify<any>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    const keyPath = this.from.table.keyPath
    keys ??= typeof keyPath === "string" && this.value[keyPath] !== undefined
      ? { [this.from.table.tableName]: [this.value[keyPath]] }
      : [this.from.table.tableName]
    return this.from.reactivity.mutation(keys, this.asEffect())
  }
}

const makeModify = <Table extends IndexedDbTable.AnyWithProps>(options: {
  readonly from: IndexedDbQuery.From<Table>
  readonly value: IndexedDbTable.TableSchema<Table>["Type"]
  readonly operation: "add" | "put"
}): IndexedDbQuery.Modify<Table> => {
  const self = Object.create(ModifyProto)
  self.from = options.from
  self.value = options.value
  self.operation = options.operation
  return self as any
}

const ModifyAllProto: Omit<
  IndexedDbQuery.ModifyAll<any>,
  | "from"
  | "values"
  | "operation"
> = {
  ...CommonProto,
  asEffect(this: IndexedDbQuery.ModifyAll<any>) {
    return applyModifyAll({ query: this, values: this.values }) as any
  },
  invalidate(
    this: IndexedDbQuery.ModifyAll<any>,
    keys?: ReadonlyArray<unknown> | Record.ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  ) {
    keys ??= [this.from.table.tableName]
    return this.from.reactivity.mutation(keys, this.asEffect())
  }
}

const makeModifyAll = <
  Table extends IndexedDbTable.AnyWithProps
>(options: {
  readonly from: IndexedDbQuery.From<Table>
  readonly values: Array<IndexedDbTable.TableSchema<Table>["Type"]>
  readonly operation: "add" | "put"
}): IndexedDbQuery.ModifyAll<Table> => {
  const self = Object.create(ModifyAllProto)
  self.from = options.from
  self.values = options.values
  self.operation = options.operation
  return self as any
}

const QueryBuilderProto: Omit<
  IndexedDbQueryBuilder<any>,
  | "tables"
  | "database"
  | "IDBKeyRange"
  | "IDBTransaction"
  | "reactivity"
> = {
  ...CommonProto,
  use(this: IndexedDbQueryBuilder<any>, f: (database: globalThis.IDBDatabase) => any) {
    return Effect.try({
      try: () => f(this.database.current),
      catch: (error) =>
        new IndexedDbQueryError({
          reason: "UnknownError",
          cause: error
        })
    })
  },
  from(this: IndexedDbQueryBuilder<any>, table: any) {
    return makeFrom({
      database: this.database,
      IDBKeyRange: this.IDBKeyRange,
      table: this.tables.get(table)!,
      reactivity: this.reactivity
    }) as any
  },
  get clearAll() {
    const self = this as IndexedDbQueryBuilder<any>
    return applyClearAll({ database: self.database.current })
  },
  withTransaction(this: IndexedDbQueryBuilder<any>, options: {
    readonly tables: NonEmptyReadonlyArray<any>
    readonly mode: globalThis.IDBTransactionMode
    readonly durability?: IDBTransactionDurability
  }) {
    return (effect) =>
      Effect.suspend(() => {
        const transaction = this.database.current.transaction(options.tables, options.mode, options)
        return Effect.provideService(effect, IndexedDbTransaction, transaction)
      }).pipe(
        // To prevent async gaps between transaction queries
        Effect.provideService(References.PreventSchedulerYield, true)
      )
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <Source extends IndexedDbVersion.AnyWithProps>({
  IDBKeyRange,
  database,
  tables,
  reactivity
}: {
  readonly database: MutableRef.MutableRef<globalThis.IDBDatabase>
  readonly IDBKeyRange: typeof globalThis.IDBKeyRange
  readonly tables: ReadonlyMap<string, IndexedDbVersion.Tables<Source>>
  readonly reactivity: Reactivity.Reactivity["Service"]
}): IndexedDbQueryBuilder<Source> => {
  const self = Object.create(QueryBuilderProto)
  self.tables = tables
  self.database = database
  self.reactivity = reactivity
  self.IDBKeyRange = IDBKeyRange
  return self
}

const getOrCreateTransaction = (
  database: globalThis.IDBDatabase,
  tables: ReadonlyArray<string>,
  mode: globalThis.IDBTransactionMode,
  options?: IDBTransactionOptions
) => {
  const fiber = Fiber.getCurrent()!
  return Context.getOrUndefined(fiber.context, IndexedDbTransaction) ?? database.transaction(tables, mode, options)
}

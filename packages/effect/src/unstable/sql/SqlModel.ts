/**
 * @since 4.0.0
 * @category models
 */
import type * as Cause from "../../Cause.ts"
import type { Input } from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import * as RequestResolver from "../../RequestResolver.ts"
import type * as Schema from "../../Schema.ts"
import type { Scope } from "../../Scope.ts"
import type * as Model from "../schema/Model.ts"
import { SqlClient } from "./SqlClient.ts"
import type { SqlError } from "./SqlError.ts"
import * as SqlResolver from "./SqlResolver.ts"
import * as SqlSchema from "./SqlSchema.ts"

/**
 * Create a simple CRUD repository from a model.
 *
 * @since 4.0.0
 * @category repository
 */
export const makeRepository = <
  S extends Model.Any,
  Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"])
>(Model: S, options: {
  readonly tableName: string
  readonly spanPrefix: string
  readonly idColumn: Id
}): Effect.Effect<
  {
    readonly insert: (
      insert: S["insert"]["Type"]
    ) => Effect.Effect<
      S["Type"],
      Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["insert"]["EncodingServices"]
    >
    readonly insertVoid: (
      insert: S["insert"]["Type"]
    ) => Effect.Effect<void, Schema.SchemaError | SqlError, S["insert"]["EncodingServices"]>
    readonly update: (
      update: S["update"]["Type"]
    ) => Effect.Effect<
      S["Type"],
      Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["update"]["EncodingServices"]
    >
    readonly updateVoid: (
      update: S["update"]["Type"]
    ) => Effect.Effect<void, Schema.SchemaError | SqlError, S["update"]["EncodingServices"]>
    readonly findById: (
      id: S["fields"][Id]["Type"]
    ) => Effect.Effect<
      S["Type"],
      Cause.NoSuchElementError | Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["fields"][Id]["EncodingServices"]
    >
    readonly delete: (
      id: S["fields"][Id]["Type"]
    ) => Effect.Effect<void, Schema.SchemaError | SqlError, S["fields"][Id]["EncodingServices"]>
  },
  never,
  SqlClient
> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const idSchema = Model.fields[options.idColumn] as Schema.Top
    const idColumn = options.idColumn as string

    const insertSchema = SqlSchema.findOne({
      Request: Model.insert,
      Result: Model,
      execute: (request) =>
        sql.onDialectOrElse({
          mysql: () =>
            sql`insert into ${sql(options.tableName)} ${sql.insert(request as any)};
select * from ${sql(options.tableName)} where ${sql(idColumn)} = LAST_INSERT_ID();`.unprepared.pipe(
              Effect.map(([, results]) => results as any)
            ),
          orElse: () => sql`insert into ${sql(options.tableName)} ${sql.insert(request as any).returning("*")}`
        })
    })
    const insert = (
      insert: S["insert"]["Type"]
    ): Effect.Effect<
      S["Type"],
      Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["insert"]["EncodingServices"]
    > =>
      insertSchema(insert).pipe(
        Effect.catchTag("NoSuchElementError", Effect.die),
        Effect.withSpan(`${options.spanPrefix}.insert`, {}, { captureStackTrace: false })
      ) as any

    const insertVoidSchema = SqlSchema.void({
      Request: Model.insert,
      execute: (request) => sql`insert into ${sql(options.tableName)} ${sql.insert(request as any)}`
    })
    const insertVoid = (
      insert: S["insert"]["Type"]
    ): Effect.Effect<void, Schema.SchemaError | SqlError, S["insert"]["EncodingServices"]> =>
      insertVoidSchema(insert).pipe(
        Effect.withSpan(`${options.spanPrefix}.insertVoid`, {}, {
          captureStackTrace: false
        })
      ) as any

    const updateSchema = SqlSchema.findOne({
      Request: Model.update,
      Result: Model,
      execute: (request: any) =>
        sql.onDialectOrElse({
          mysql: () =>
            sql`update ${sql(options.tableName)} set ${sql.update(request, [idColumn])} where ${sql(idColumn)} = ${
              request[idColumn]
            };
select * from ${sql(options.tableName)} where ${sql(idColumn)} = ${request[idColumn]};`.unprepared.pipe(
              Effect.map(([, results]) => results as any)
            ),
          orElse: () =>
            sql`update ${sql(options.tableName)} set ${sql.update(request, [idColumn])} where ${sql(idColumn)} = ${
              request[idColumn]
            } returning *`
        })
    })
    const update = (
      update: S["update"]["Type"]
    ): Effect.Effect<
      S["Type"],
      Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["update"]["EncodingServices"]
    > =>
      updateSchema(update).pipe(
        Effect.catchTag("NoSuchElementError", Effect.die),
        Effect.withSpan(`${options.spanPrefix}.update`, {
          attributes: { id: (update as any)[idColumn] }
        }, {
          captureStackTrace: false
        })
      ) as any

    const updateVoidSchema = SqlSchema.void({
      Request: Model.update,
      execute: (request: any) =>
        sql`update ${sql(options.tableName)} set ${sql.update(request, [idColumn])} where ${sql(idColumn)} = ${
          request[idColumn]
        }`
    })
    const updateVoid = (
      update: S["update"]["Type"]
    ): Effect.Effect<void, Schema.SchemaError | SqlError, S["update"]["EncodingServices"]> =>
      updateVoidSchema(update).pipe(
        Effect.withSpan(`${options.spanPrefix}.updateVoid`, {
          attributes: { id: (update as any)[idColumn] }
        }, {
          captureStackTrace: false
        })
      ) as any

    const findByIdSchema = SqlSchema.findOne({
      Request: idSchema,
      Result: Model,
      execute: (id: any) => sql`select * from ${sql(options.tableName)} where ${sql(idColumn)} = ${id}`
    })
    const findById = (
      id: S["fields"][Id]["Type"]
    ): Effect.Effect<
      S["Type"],
      Cause.NoSuchElementError | Schema.SchemaError | SqlError,
      S["DecodingServices"] | S["fields"][Id]["EncodingServices"]
    > =>
      findByIdSchema(id).pipe(
        Effect.withSpan(`${options.spanPrefix}.findById`, { attributes: { id } }, {
          captureStackTrace: false
        })
      ) as any

    const deleteSchema = SqlSchema.void({
      Request: idSchema,
      execute: (id: any) => sql`delete from ${sql(options.tableName)} where ${sql(idColumn)} = ${id}`
    })
    const delete_ = (
      id: S["fields"][Id]["Type"]
    ): Effect.Effect<void, Schema.SchemaError | SqlError, S["fields"][Id]["EncodingServices"]> =>
      deleteSchema(id).pipe(
        Effect.withSpan(`${options.spanPrefix}.delete`, {
          attributes: { id }
        }, {
          captureStackTrace: false
        })
      ) as any

    return { insert, insertVoid, update, updateVoid, findById, delete: delete_ } as const
  })

/**
 * Create some simple data loaders from a model.
 *
 * @since 4.0.0
 * @category repository
 */
export const makeDataLoaders = <
  S extends Model.Any,
  Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"])
>(
  Model: S,
  options: {
    readonly tableName: string
    readonly spanPrefix: string
    readonly idColumn: Id
    readonly window: Input
    readonly maxBatchSize?: number | undefined
  }
): Effect.Effect<
  {
    readonly insert: (
      insert: S["insert"]["Type"]
    ) => Effect.Effect<
      S["Type"],
      SqlError | Schema.SchemaError,
      S["DecodingServices"] | S["insert"]["EncodingServices"]
    >
    readonly insertVoid: (
      insert: S["insert"]["Type"]
    ) => Effect.Effect<void, SqlError | Schema.SchemaError, S["insert"]["EncodingServices"]>
    readonly findById: (
      id: S["fields"][Id]["Type"]
    ) => Effect.Effect<
      S["Type"],
      SqlError | Schema.SchemaError | Cause.NoSuchElementError,
      S["DecodingServices"] | S["fields"][Id]["EncodingServices"]
    >
    readonly delete: (
      id: S["fields"][Id]["Type"]
    ) => Effect.Effect<void, SqlError | Schema.SchemaError, S["fields"][Id]["EncodingServices"]>
  },
  never,
  SqlClient | Scope
> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const idSchema = Model.fields[options.idColumn] as Schema.Top
    const idColumn = options.idColumn as string
    const setMaxBatchSize = options.maxBatchSize ? RequestResolver.batchN(options.maxBatchSize) : identity

    const insertResolver = SqlResolver.ordered({
      Request: Model.insert,
      Result: Model,
      execute: (request: any) =>
        sql.onDialectOrElse({
          mysql: () =>
            Effect.forEach(request, (request: any) =>
              sql`insert into ${sql(options.tableName)} ${sql.insert(request)};
select * from ${sql(options.tableName)} where ${sql(idColumn)} = LAST_INSERT_ID();`.unprepared.pipe(
                Effect.map(([, results]) => results[0] as any)
              ), { concurrency: 10 }),
          orElse: () => sql`insert into ${sql(options.tableName)} ${sql.insert(request).returning("*")}`
        })
    }).pipe(
      RequestResolver.setDelay(options.window),
      setMaxBatchSize,
      RequestResolver.withSpan(`${options.spanPrefix}.insertResolver`)
    )
    const insertExecute = SqlResolver.request(insertResolver)
    const insert = (
      insert: S["insert"]["Type"]
    ): Effect.Effect<
      S["Type"],
      SqlError | Schema.SchemaError,
      S["DecodingServices"] | S["insert"]["EncodingServices"]
    > =>
      insertExecute(insert).pipe(
        Effect.catchTag("ResultLengthMismatch", Effect.die),
        Effect.withSpan(`${options.spanPrefix}.insert`, {}, {
          captureStackTrace: false
        })
      ) as any

    const insertVoidResolver = SqlResolver.void({
      Request: Model.insert,
      execute: (request: any) => sql`insert into ${sql(options.tableName)} ${sql.insert(request)}`
    }).pipe(
      RequestResolver.setDelay(options.window),
      setMaxBatchSize,
      RequestResolver.withSpan(`${options.spanPrefix}.insertVoidResolver`)
    )
    const insertVoidExecute = SqlResolver.request(insertVoidResolver)
    const insertVoid = (
      insert: S["insert"]["Type"]
    ): Effect.Effect<void, SqlError | Schema.SchemaError, S["insert"]["EncodingServices"]> =>
      insertVoidExecute(insert).pipe(
        Effect.withSpan(`${options.spanPrefix}.insertVoid`, {}, {
          captureStackTrace: false
        })
      ) as any

    const findByIdResolver = SqlResolver.findById({
      Id: idSchema,
      Result: Model,
      ResultId(request: any) {
        return request[idColumn]
      },
      execute: (ids: any) => sql`select * from ${sql(options.tableName)} where ${sql.in(idColumn, ids)}`
    }).pipe(
      RequestResolver.setDelay(options.window),
      setMaxBatchSize,
      RequestResolver.withSpan(`${options.spanPrefix}.findByIdResolver`)
    )
    const findByIdExecute = SqlResolver.request(findByIdResolver)
    const findById = (
      id: S["fields"][Id]["Type"]
    ): Effect.Effect<
      S["Type"],
      Cause.NoSuchElementError | SqlError | Schema.SchemaError,
      S["DecodingServices"] | S["fields"][Id]["EncodingServices"]
    > =>
      findByIdExecute(id).pipe(
        Effect.withSpan(`${options.spanPrefix}.findById`, { attributes: { id } }, {
          captureStackTrace: false
        })
      ) as any

    const deleteResolver = SqlResolver.void({
      Request: idSchema,
      execute: (ids: any) => sql`delete from ${sql(options.tableName)} where ${sql.in(idColumn, ids)}`
    }).pipe(
      RequestResolver.setDelay(options.window),
      setMaxBatchSize,
      RequestResolver.withSpan(`${options.spanPrefix}.deleteResolver`)
    )
    const deleteExecute = SqlResolver.request(deleteResolver)
    const delete_ = (
      id: S["fields"][Id]["Type"]
    ): Effect.Effect<void, SqlError | Schema.SchemaError, S["fields"][Id]["EncodingServices"]> =>
      deleteExecute(id).pipe(
        Effect.withSpan(`${options.spanPrefix}.delete`, { attributes: { id } }, {
          captureStackTrace: false
        })
      ) as any

    return { insert, insertVoid, findById, delete: delete_ } as const
  })

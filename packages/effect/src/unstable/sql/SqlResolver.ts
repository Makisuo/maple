/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Exit from "../../Exit.ts"
import * as Hash from "../../Hash.ts"
import * as MutableHashMap from "../../MutableHashMap.ts"
import * as Request from "../../Request.ts"
import * as RequestResolver from "../../RequestResolver.ts"
import * as Schema from "../../Schema.ts"
import type * as Types from "../../Types.ts"
import * as SqlClient from "./SqlClient.ts"
import { ResultLengthMismatch } from "./SqlError.ts"

/**
 * @since 4.0.0
 * @category requests
 */
export interface SqlRequest<In, A, E, R> extends Request.Request<A, E | Schema.SchemaError, R> {
  readonly payload: In
}

const SqlRequestProto = {
  ...Request.Class.prototype,
  [Equal.symbol](
    this: SqlRequest<any, any, any, any>,
    that: SqlRequest<any, any, any, any>
  ): boolean {
    return Equal.equals(this.payload, that.payload)
  },
  [Hash.symbol](this: SqlRequest<any, any, any, any>): number {
    return Hash.hash(this.payload)
  }
}

/**
 * @since 4.0.0
 * @category requests
 */
export const request: {
  <In, A, E, R>(
    resolver: RequestResolver.RequestResolver<SqlRequest<In, A, E, R>>
  ): (payload: In) => Effect.Effect<A, E | Schema.SchemaError, R>
  <In, A, E, R>(
    payload: In,
    resolver: RequestResolver.RequestResolver<SqlRequest<In, A, E, R>>
  ): Effect.Effect<A, E | Schema.SchemaError, R>
} = function() {
  if (arguments.length === 1) {
    const resolver = arguments[0]
    return (payload: any) => Effect.request(SqlRequest(payload), resolver)
  }
  return Effect.request(SqlRequest(arguments[0]), arguments[1])
} as any

/**
 * @since 4.0.0
 * @category requests
 */
export const SqlRequest = <In, A, E, R>(payload: In): SqlRequest<In, A, E, R> => {
  const self = Object.create(SqlRequestProto)
  self.payload = payload
  return self
}

/**
 * Create a resolver for a sql query with a request schema and a result schema.
 *
 * The request schema is used to validate the input of the query.
 * The result schema is used to validate the output of the query.
 *
 * Results are mapped to the requests in order, so the length of the results must match the length of the requests.
 *
 * @since 4.0.0
 * @category resolvers
 */
export const ordered = <Req extends Schema.Top, Res extends Schema.Top, _, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<_>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<Req["Type"], Res["Type"], E | ResultLengthMismatch, Req["EncodingServices"] | Res["DecodingServices"] | R>
> => {
  const decodeArray = Schema.decodeUnknownEffect(Schema.Array(options.Result))
  return RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      Res["Type"],
      E | ResultLengthMismatch,
      Req["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection["Service"] | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideServices(entries[0].services)
      )
      if (results.length !== inputs.length) {
        return yield* new ResultLengthMismatch({ expected: inputs.length, actual: results.length })
      }
      const decodedResults = yield* decodeArray(results).pipe(
        Effect.provideServices(entries[0].services)
      )
      for (let i = 0; i < entries.length; i++) {
        entries[i].completeUnsafe(Exit.succeed(decodedResults[i]))
      }
    })
  })
}

/**
 * Create a resolver the can return multiple results for a single request.
 *
 * Results are grouped by a common key extracted from the request and result.
 *
 * @since 4.0.0
 * @category resolvers
 */
export const grouped = <Req extends Schema.Top, Res extends Schema.Top, K, Row, E, R>(
  options: {
    readonly Request: Req
    readonly RequestGroupKey: (request: Req["Type"]) => K
    readonly Result: Res
    readonly ResultGroupKey: (result: Res["Type"], row: Types.NoInfer<Row>) => K
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<Row>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Req["Type"],
    Arr.NonEmptyArray<Res["Type"]>,
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  >
> => {
  const decodeResults = Schema.decodeUnknownEffect(Schema.Array(options.Result))

  return RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      Arr.NonEmptyArray<Res["Type"]>,
      E | Schema.SchemaError | Cause.NoSuchElementError,
      Req["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection["Service"] | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      const resultMap = MutableHashMap.empty<K, Arr.NonEmptyArray<Res["Type"]>>()
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideServices(entries[0].services)
      )
      const decodedResults = yield* decodeResults(results).pipe(
        Effect.provideServices(entries[0].services)
      )
      for (let i = 0, len = decodedResults.length; i < len; i++) {
        const result = decodedResults[i]
        const key = options.ResultGroupKey(result, results[i])
        const group = MutableHashMap.get(resultMap, key)
        if (group._tag === "None") {
          MutableHashMap.set(resultMap, key, [result])
        } else {
          group.value.push(result)
        }
      }
      for (let i = 0, len = entries.length; i < len; i++) {
        const entry = entries[i]
        const key = options.RequestGroupKey(entry.request.payload)
        const result = MutableHashMap.get(resultMap, key)
        entry.completeUnsafe(
          result._tag === "None" ? constNoSuchElement : Exit.succeed(result.value)
        )
      }
    })
  })
}

/**
 * Create a resolver that resolves results by id.
 *
 * @since 4.0.0
 * @category resolvers
 */
export const findById = <Id extends Schema.Top, Res extends Schema.Top, Row, E, R>(
  options: {
    readonly Id: Id
    readonly Result: Res
    readonly ResultId: (result: Res["Type"], row: Types.NoInfer<Row>) => Id["Type"]
    readonly execute: (
      requests: Arr.NonEmptyArray<Id["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<Row>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Id["Type"],
    Res["Type"],
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Id["EncodingServices"] | Res["DecodingServices"] | R
  >
> => {
  const decodeResults = Schema.decodeUnknownEffect(Schema.Array(options.Result))

  return RequestResolver.makeGrouped<
    SqlRequest<
      Id["Type"],
      Res["Type"],
      E | Schema.SchemaError | Cause.NoSuchElementError,
      Id["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection["Service"] | undefined
  >({
    key(entry) {
      const conn = entry.services.mapUnsafe.get(SqlClient.TransactionConnection.key)
      if (!conn) return undefined
      return Equal.byReferenceUnsafe(conn)
    },
    resolver: Effect.fnUntraced(function*(entries) {
      const [inputs, idMap] = yield* partitionRequestsById(entries, options.Id)
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideServices(entries[0].services)
      )
      const decodedResults = yield* decodeResults(results).pipe(
        Effect.provideServices(entries[0].services)
      )
      for (let i = 0; i < decodedResults.length; i++) {
        const result = decodedResults[i]
        const id = options.ResultId(result, results[i])
        const request = MutableHashMap.get(idMap, id)
        if (request._tag === "None") {
          continue
        }
        MutableHashMap.remove(idMap, id)
        request.value.completeUnsafe(Exit.succeed(result))
      }
      if (MutableHashMap.isEmpty(idMap)) {
        return
      }
      MutableHashMap.forEach(idMap, (request) => {
        request.completeUnsafe(constNoSuchElement)
      })
    })
  })
}

const void_ = <Req extends Schema.Top, _, E, R>(
  options: {
    readonly Request: Req
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<_>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Req["Type"],
    void,
    E | Schema.SchemaError,
    Req["EncodingServices"] | R
  >
> =>
  RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      void,
      E | Schema.SchemaError,
      Req["EncodingServices"] | R
    >,
    SqlClient.TransactionConnection["Service"] | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      yield* options.execute(inputs as any).pipe(
        Effect.provideServices(entries[0].services)
      )
      for (let i = 0; i < entries.length; i++) {
        entries[i].completeUnsafe(Exit.void)
      }
    })
  })

export {
  /**
   * Create a resolver that performs side effects.
   *
   * @since 4.0.0
   * @category resolvers
   */
  void_ as void
}

const constNoSuchElement = Exit.fail(new Cause.NoSuchElementError())

const partitionRequests = function*<In, A, E, R, InE>(
  requests: Arr.NonEmptyArray<Request.Entry<SqlRequest<In, A, E, R>>>,
  schema: Schema.Codec<In, InE, R, R>
) {
  const len = requests.length
  const inputs = Arr.empty<InE>()
  let entry!: Request.Entry<SqlRequest<In, A, E, R>>
  const encode = Schema.encodeEffect(schema)
  const handle = Effect.matchCauseEager({
    onFailure(cause: Cause.Cause<Schema.SchemaError>) {
      entry.completeUnsafe(Exit.failCause(cause))
    },
    onSuccess(value: InE) {
      inputs.push(value)
    }
  })

  for (let i = 0; i < len; i++) {
    entry = requests[i]
    yield (Effect.provideServices(handle(encode(entry.request.payload)), entry.services) as Effect.Effect<void>)
  }

  return inputs
}

const partitionRequestsById = function*<In, A, E, R, InE>(
  requests: ReadonlyArray<Request.Entry<SqlRequest<In, A, E, R>>>,
  schema: Schema.Codec<In, InE, R, R>
) {
  const len = requests.length
  const inputs = Arr.empty<InE>()
  const byIdMap = MutableHashMap.empty<In, Request.Entry<SqlRequest<In, A, E, R>>>()
  let entry!: Request.Entry<SqlRequest<In, A, E, R>>
  const encode = Schema.encodeEffect(schema)
  const handle = Effect.matchCauseEager({
    onFailure(cause: Cause.Cause<Schema.SchemaError>) {
      entry.completeUnsafe(Exit.failCause(cause))
    },
    onSuccess(value: InE) {
      inputs.push(value)
    }
  })

  for (let i = 0; i < len; i++) {
    entry = requests[i]
    yield (Effect.provideServices(handle(encode(entry.request.payload)), entry.services) as Effect.Effect<void>)
    MutableHashMap.set(byIdMap, entry.request.payload, entry)
  }

  return [inputs, byIdMap] as const
}

function transactionKey<A>(entry: Request.Entry<A>): SqlClient.TransactionConnection["Service"] | undefined {
  const conn = entry.services.mapUnsafe.get(SqlClient.TransactionConnection.key)
  if (!conn) return undefined
  return Equal.byReferenceUnsafe(conn)
}

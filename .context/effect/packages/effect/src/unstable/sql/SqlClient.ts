/**
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import type * as Queue from "../../Queue.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as Tracer from "../../Tracer.ts"
import type { NoInfer } from "../../Types.ts"
import { Reactivity } from "../reactivity/Reactivity.ts"
import type * as Connection from "./SqlConnection.ts"
import type { SqlError } from "./SqlError.ts"
import type { Compiler, Constructor } from "./Statement.ts"
import * as Statement from "./Statement.ts"

const TypeId = "~effect/sql/SqlClient"

/**
 * @category models
 * @since 4.0.0
 */
export interface SqlClient extends Constructor {
  readonly [TypeId]: typeof TypeId

  /**
   * Copy of the client for safeql etc.
   */
  readonly safe: this

  /**
   * Copy of the client without transformations.
   */
  readonly withoutTransforms: () => this

  readonly reserve: Effect.Effect<Connection.Connection, SqlError, Scope.Scope>

  /**
   * With the given effect, ensure all sql queries are run in a transaction.
   */
  readonly withTransaction: <R, E, A>(
    self: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError, R>

  /**
   * Use the Reactivity service from @effect/experimental to create a reactive
   * query.
   */
  readonly reactive: <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ) => Stream.Stream<A, E, R>

  /**
   * Use the Reactivity service to create a reactive
   * query.
   */
  readonly reactiveMailbox: <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
}

/**
 * @category models
 * @since 4.0.0
 */
export const SqlClient = ServiceMap.Service<SqlClient>("effect/sql/SqlClient")

/**
 * @category models
 * @since 4.0.0
 */
export namespace SqlClient {
  /**
   * @category models
   * @since 4.0.0
   */
  export interface MakeOptions {
    readonly acquirer: Connection.Acquirer
    readonly compiler: Compiler
    readonly transactionAcquirer?: Connection.Acquirer
    readonly spanAttributes: ReadonlyArray<readonly [string, unknown]>
    readonly beginTransaction?: string | undefined
    readonly rollback?: string | undefined
    readonly commit?: string | undefined
    readonly savepoint?: ((name: string) => string) | undefined
    readonly rollbackSavepoint?: ((name: string) => string) | undefined
    readonly transformRows?: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
    readonly reactiveQueue?: <A, E, R>(
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
  }
}

/**
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(options: SqlClient.MakeOptions) {
  const getConnection = Effect.flatMap(
    Effect.serviceOption(TransactionConnection),
    Option.match({
      onNone: () => options.acquirer,
      onSome: ([conn]) => Effect.succeed(conn)
    })
  )

  const beginTransaction = options.beginTransaction ?? "BEGIN"
  const commit = options.commit ?? "COMMIT"
  const savepoint = options.savepoint ?? ((name: string) => `SAVEPOINT ${name}`)
  const rollback = options.rollback ?? "ROLLBACK"
  const rollbackSavepoint = options.rollbackSavepoint ?? ((name: string) => `ROLLBACK TO SAVEPOINT ${name}`)
  const transactionAcquirer = options.transactionAcquirer ?? options.acquirer
  const withTransaction = makeWithTransaction({
    transactionService: TransactionConnection,
    spanAttributes: options.spanAttributes,
    acquireConnection: Effect.flatMap(
      Scope.make(),
      (scope) => Effect.map(Scope.provide(transactionAcquirer!, scope), (conn) => [scope, conn] as const)
    ),
    begin: (conn) => conn.executeUnprepared(beginTransaction, [], undefined),
    savepoint: (conn, id) => conn.executeUnprepared(savepoint(`effect_sql_${id}`), [], undefined),
    commit: (conn) => conn.executeUnprepared(commit, [], undefined),
    rollback: (conn) => conn.executeUnprepared(rollback, [], undefined),
    rollbackSavepoint: (conn, id) => conn.executeUnprepared(rollbackSavepoint(`effect_sql_${id}`), [], undefined)
  })

  const reactivity = yield* Reactivity
  const client: SqlClient = Object.assign(
    Statement.make(getConnection, options.compiler, options.spanAttributes, options.transformRows),
    {
      [TypeId]: TypeId as typeof TypeId,
      safe: undefined as any,
      withTransaction,
      reserve: transactionAcquirer,
      withoutTransforms(): any {
        if (options.transformRows === undefined) {
          return this
        }
        const statement = Statement.make(
          getConnection,
          options.compiler.withoutTransform,
          options.spanAttributes,
          undefined
        )
        const client = Object.assign(statement, {
          ...this,
          ...statement
        })
        ;(client as any).safe = client
        ;(client as any).withoutTransforms = () => client
        return client
      },
      reactive: options.reactiveQueue ?
        <A, E, R>(
          keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
          effect: Effect.Effect<A, E, R>
        ) =>
          options.reactiveQueue!(keys, effect).pipe(
            Effect.map(Stream.fromQueue),
            Stream.unwrap
          ) :
        reactivity.stream,
      reactiveMailbox: options.reactiveQueue ?? reactivity.query
    }
  )
  ;(client as any).safe = client

  return client
})

/**
 * @since 4.0.0
 * @category transactions
 */
export const makeWithTransaction = <I, S>(options: {
  readonly transactionService: ServiceMap.Key<I, readonly [conn: S, counter: number]>
  readonly spanAttributes: ReadonlyArray<readonly [string, unknown]>
  readonly acquireConnection: Effect.Effect<readonly [Scope.Closeable | undefined, S], SqlError>
  readonly begin: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly savepoint: (conn: NoInfer<S>, id: number) => Effect.Effect<void, SqlError>
  readonly commit: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly rollback: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly rollbackSavepoint: (conn: NoInfer<S>, id: number) => Effect.Effect<void, SqlError>
}) =>
<R, E, A>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.useSpan(
      "sql.transaction",
      { kind: "client" },
      (span) =>
        Effect.withFiber<A, E | SqlError, R>((fiber) => {
          for (const [key, value] of options.spanAttributes) {
            span.attribute(key, value)
          }
          const services = fiber.services
          const clock = fiber.getRef(Clock)
          const connOption = ServiceMap.getOption(services, options.transactionService)
          const conn = connOption._tag === "Some"
            ? Effect.succeed([undefined, connOption.value[0]] as const)
            : options.acquireConnection
          const id = connOption._tag === "Some" ? connOption.value[1] + 1 : 0
          return Effect.flatMap(
            conn,
            (
              [scope, conn]
            ) =>
              (id === 0 ? options.begin(conn) : options.savepoint(conn, id)).pipe(
                Effect.flatMap(() =>
                  Effect.provideServices(
                    restore(effect),
                    ServiceMap.mutate(services, (services) =>
                      services.pipe(
                        ServiceMap.add(options.transactionService, [conn, id]),
                        ServiceMap.add(Tracer.ParentSpan, span)
                      ))
                  )
                ),
                Effect.exit,
                Effect.flatMap((exit) => {
                  let effect: Effect.Effect<void>
                  if (Exit.isSuccess(exit)) {
                    if (id === 0) {
                      span.event("db.transaction.commit", clock.currentTimeNanosUnsafe())
                      effect = Effect.orDie(options.commit(conn))
                    } else {
                      span.event("db.transaction.savepoint", clock.currentTimeNanosUnsafe())
                      effect = Effect.void
                    }
                  } else {
                    span.event("db.transaction.rollback", clock.currentTimeNanosUnsafe())
                    effect = Effect.orDie(
                      id > 0
                        ? options.rollbackSavepoint(conn, id)
                        : options.rollback(conn)
                    )
                  }
                  const withScope = scope !== undefined ? Effect.ensuring(effect, Scope.close(scope, exit)) : effect
                  return Effect.flatMap(withScope, () => exit)
                })
              )
          )
        })
    )
  )

/**
 * @since 4.0.0
 */
export class TransactionConnection
  extends ServiceMap.Service<TransactionConnection, readonly [conn: Connection.Connection, depth: number]>()(
    "effect/sql/SqlClient/TransactionConnection"
  )
{}

/**
 * @since 4.0.0
 */
export const SafeIntegers = ServiceMap.Reference<boolean>("effect/sql/SqlClient/SafeIntegers", {
  defaultValue: () => false
})

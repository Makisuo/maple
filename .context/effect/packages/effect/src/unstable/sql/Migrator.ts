/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import { FileSystem } from "../../FileSystem.ts"
import { pipe } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Order from "../../Order.ts"
import * as Client from "./SqlClient.ts"
import type { SqlError } from "./SqlError.ts"

/**
 * @category model
 * @since 4.0.0
 */
export interface MigratorOptions<R = never> {
  readonly loader: Loader<R>
  readonly schemaDirectory?: string
  readonly table?: string
}

/**
 * @category model
 * @since 4.0.0
 */
export type Loader<R = never> = Effect.Effect<
  ReadonlyArray<ResolvedMigration>,
  MigrationError,
  R
>

/**
 * @category model
 * @since 4.0.0
 */
export type ResolvedMigration = readonly [
  id: number,
  name: string,
  load: Effect.Effect<any, any, Client.SqlClient>
]

/**
 * @category model
 * @since 4.0.0
 */
export interface Migration {
  readonly id: number
  readonly name: string
  readonly createdAt: Date
}

/**
 * @category errors
 * @since 4.0.0
 */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly _tag: "MigrationError"
  readonly cause?: unknown
  readonly kind:
    | "BadState"
    | "ImportError"
    | "Failed"
    | "Duplicates"
    | "Locked"
  readonly message: string
}> {}

/**
 * @category constructor
 * @since 4.0.0
 */
export const make = <RD = never>({
  dumpSchema = () => Effect.void
}: {
  dumpSchema?: (
    path: string,
    migrationsTable: string
  ) => Effect.Effect<void, MigrationError, RD>
}) =>
<R2 = never>({
  loader,
  schemaDirectory,
  table = "effect_sql_migrations"
}: MigratorOptions<R2>): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  MigrationError | SqlError,
  Client.SqlClient | RD | R2
> =>
  Effect.gen(function*() {
    const sql = yield* Client.SqlClient

    const ensureMigrationsTable = sql.onDialectOrElse({
      mssql: () =>
        sql`IF OBJECT_ID(N'${sql.literal(table)}', N'U') IS NULL
  CREATE TABLE ${sql(table)} (
    migration_id INT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT GETDATE()
  )`,
      mysql: () =>
        sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
  migration_id INTEGER UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (migration_id)
)`,
      pg: () =>
        Effect.catch(
          sql`select ${table}::regclass`,
          () =>
            sql`CREATE TABLE ${sql(table)} (
  migration_id integer primary key,
  created_at timestamp with time zone not null default now(),
  name text not null
)`.asEffect()
        ),
      orElse: () =>
        sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`
    })

    const insertMigrations = (
      rows: ReadonlyArray<[id: number, name: string]>
    ) =>
      sql`INSERT INTO ${sql(table)} ${
        sql.insert(
          rows.map(([migration_id, name]) => ({ migration_id, name }))
        )
      }`.withoutTransform

    const latestMigration = Effect.map(
      sql<{ migration_id: number; name: string; created_at: Date }>`SELECT migration_id, name, created_at FROM ${
        sql(table)
      } ORDER BY migration_id DESC`.withoutTransform,
      (_) =>
        Option.map(
          Option.fromNullishOr(_[0] as any),
          ({ created_at, migration_id, name }): Migration => ({
            id: migration_id,
            name,
            createdAt: created_at
          })
        )
    )

    const loadMigration = ([id, name, load]: ResolvedMigration) =>
      Effect.catchDefect(load, (_) =>
        Effect.fail(
          new MigrationError({
            kind: "ImportError",
            message: `Could not import migration "${id}_${name}"\n\n${_}`
          })
        )).pipe(
          Effect.flatMap((_) =>
            Effect.isEffect(_)
              ? Effect.succeed(_)
              : _.default
              ? Effect.succeed(_.default?.default ?? _.default)
              : Effect.fail(
                new MigrationError({
                  kind: "ImportError",
                  message: `Default export not found for migration "${id}_${name}"`
                })
              )
          ),
          Effect.filterOrFail(
            Effect.isEffect,
            () =>
              new MigrationError({
                kind: "ImportError",
                message: `Default export was not an Effect for migration "${id}_${name}"`
              })
          )
        )

    const runMigration = (
      id: number,
      name: string,
      effect: Effect.Effect<unknown, unknown, Client.SqlClient>
    ) =>
      Effect.catch(effect, (error: unknown) =>
        Effect.die(
          new MigrationError({
            cause: error,
            kind: "Failed",
            message: `Migration "${id}_${name}" failed`
          })
        ))

    // === run

    const run = Effect.gen(function*() {
      yield* sql.onDialectOrElse({
        pg: () => sql`LOCK TABLE ${sql(table)} IN ACCESS EXCLUSIVE MODE`,
        orElse: () => Effect.void
      })

      const [latestMigrationId, current] = yield* Effect.all([
        Effect.map(
          latestMigration,
          Option.match({
            onNone: () => 0,
            onSome: (_) => _.id
          })
        ),
        loader
      ])

      if (new Set(current.map(([id]) => id)).size !== current.length) {
        return yield* new MigrationError({
          kind: "Duplicates",
          message: "Found duplicate migration id's"
        })
      }

      const required: Array<ResolvedMigration> = []

      for (const resolved of current) {
        const [currentId, currentName] = resolved
        if (currentId <= latestMigrationId) {
          continue
        }

        required.push([
          currentId,
          currentName,
          yield* loadMigration(resolved)
        ])
      }

      if (required.length > 0) {
        yield* pipe(
          insertMigrations(required.map(([id, name]) => [id, name])),
          Effect.mapError((error): MigrationError | SqlError =>
            error.reason._tag === "ConstraintError"
              ? new MigrationError({
                kind: "Locked",
                message: "Migrations already running"
              })
              : error
          )
        )
      }

      yield* Effect.forEach(
        required,
        ([id, name, effect]) =>
          Effect.logDebug(`Running migration`).pipe(
            Effect.flatMap(() => runMigration(id, name, effect)),
            Effect.annotateLogs("migration_id", String(id)),
            Effect.annotateLogs("migration_name", name),
            Effect.withSpan(`Migrator ${id}_${name}`)
          ),
        { discard: true }
      )

      yield* pipe(
        latestMigration,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.logDebug(`Migrations complete`),
            onSome: (_) =>
              Effect.logDebug(`Migrations complete`).pipe(
                Effect.annotateLogs("latest_migration_id", _.id.toString()),
                Effect.annotateLogs("latest_migration_name", _.name)
              )
          })
        )
      )

      return required.map(([id, name]) => [id, name] as const)
    })

    yield* ensureMigrationsTable

    const completed = yield* pipe(
      sql.withTransaction(run),
      Effect.catchTag("MigrationError", (_) =>
        _.kind === "Locked"
          ? Effect.as(Effect.logDebug(_.message), [])
          : Effect.fail(_))
    )

    if (schemaDirectory && completed.length > 0) {
      yield* dumpSchema(`${schemaDirectory}/_schema.sql`, table).pipe(
        Effect.catchCause((cause) => Effect.logInfo("Could not dump schema", cause))
      )
    }

    return completed
  })

const migrationOrder = Order.make<ResolvedMigration>(([a], [b]) => Order.Number(a, b))

/**
 * @since 4.0.0
 * @category loaders
 */
export const fromGlob = (
  migrations: Record<string, () => Promise<any>>
): Loader =>
  pipe(
    Object.keys(migrations),
    Arr.flatMapNullishOr((_) => _.match(/^(?:.*\/)?(\d+)_([^.]+)\.(js|ts)$/)),
    Arr.map(
      ([key, id, name]): ResolvedMigration => [
        Number(id),
        name,
        Effect.promise(() => migrations[key]())
      ]
    ),
    Arr.sort(migrationOrder),
    Effect.succeed
  )

/**
 * @since 4.0.0
 * @category loaders
 */
export const fromBabelGlob = (migrations: Record<string, any>): Loader =>
  pipe(
    Object.keys(migrations),
    Arr.flatMapNullishOr((_) => _.match(/^_(\d+)_([^.]+?)(Js|Ts)?$/)),
    Arr.map(
      ([key, id, name]): ResolvedMigration => [
        Number(id),
        name,
        Effect.succeed(migrations[key])
      ]
    ),
    Arr.sort(migrationOrder),
    Effect.succeed
  )

/**
 * @since 4.0.0
 * @category loaders
 */
export const fromRecord = (migrations: Record<string, Effect.Effect<void, unknown, Client.SqlClient>>): Loader =>
  pipe(
    Object.keys(migrations),
    Arr.flatMapNullishOr((_) => _.match(/^(\d+)_(.+)$/)),
    Arr.map(
      ([key, id, name]): ResolvedMigration => [
        Number(id),
        name,
        Effect.succeed(migrations[key])
      ]
    ),
    Arr.sort(migrationOrder),
    Effect.succeed
  )

/**
 * @since 4.0.0
 * @category loaders
 */
export const fromFileSystem: (directory: string) => Loader<FileSystem> = Effect.fnUntraced(function*(directory) {
  const Fs = yield* FileSystem
  const files = yield* Effect.mapError(
    Fs.readDirectory(directory),
    (cause) =>
      new MigrationError({
        kind: "Failed",
        cause,
        message: "Failed to read migrations directory"
      })
  )
  return files
    .map((file) => Option.fromNullishOr(file.match(/^(?:.*\/)?(\d+)_([^.]+)\.(js|ts)$/)))
    .flatMap(
      Option.match({
        onNone: () => [],
        onSome: ([basename, id, name]): ReadonlyArray<ResolvedMigration> =>
          [
            [
              Number(id),
              name,
              Effect.promise(
                () =>
                  import(
                    /* @vite-ignore */
                    /* webpackIgnore: true */
                    `${directory}/${basename}`
                  )
              )
            ]
          ] as const
      })
    )
    .sort(([a], [b]) => a - b)
})

/**
 * @since 1.0.0
 */
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import type * as Client from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * @since 1.0.0
 */
export * from "effect/unstable/sql/Migrator"

/**
 * @category constructor
 * @since 1.0.0
 */
export const run: <R2 = never>(
  { loader, schemaDirectory, table }: Migrator.MigratorOptions<R2>
) => Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R2
> = Migrator.make({
  // TODO: re-add when Command module is available
  // dumpSchema(path, table) {
  //   const mysqlDump = (args: Array<string>) =>
  //     Effect.gen(function*() {
  //       const sql = yield* MysqlClient
  //       const dump = yield* pipe(
  //         Command.make(
  //           "mysqldump",
  //           ...(sql.config.host ? ["-h", sql.config.host] : []),
  //           ...(sql.config.port ? ["-P", sql.config.port.toString()] : []),
  //           ...(sql.config.username ? ["-u", sql.config.username] : []),
  //           ...(sql.config.password ? [`-p${Redacted.value(sql.config.password)}`] : []),
  //           ...(sql.config.database ? [sql.config.database] : []),
  //           "--skip-comments",
  //           "--compact",
  //           ...args
  //         ),
  //         Command.env({
  //           PATH: (globalThis as any).process?.env.PATH
  //         }),
  //         Command.string
  //       )
  //
  //       return dump.replace(/^\/\*.*$/gm, "")
  //         .replace(/\n{2,}/gm, "\n\n")
  //         .trim()
  //     }).pipe(
  //       Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
  //     )
  //
  //   const dumpSchema = mysqlDump(["--no-data"])
  //
  //   const dumpMigrations = mysqlDump(["--no-create-info", "--tables", table])
  //
  //   const dumpAll = Effect.map(
  //     Effect.all([dumpSchema, dumpMigrations], { concurrency: 2 }),
  //     ([schema, migrations]) => schema + "\n\n" + migrations
  //   )
  //
  //   const dumpFile = (file: string) =>
  //     Effect.gen(function*() {
  //       const fs = yield* FileSystem
  //       const path = yield* Path
  //       const dump = yield* dumpAll
  //       yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  //       yield* fs.writeFileString(file, dump)
  //     }).pipe(
  //       Effect.mapError((error) => new Migrator.MigrationError({ kind: "Failed", message: error.message }))
  //     )
  //
  //   return dumpFile(path)
  // }
})

/**
 * @category layers
 * @since 1.0.0
 */
export const layer = <R>(
  options: Migrator.MigratorOptions<R>
): Layer.Layer<
  never,
  Migrator.MigrationError | SqlError,
  Client.SqlClient | R
> => Layer.effectDiscard(run(options))

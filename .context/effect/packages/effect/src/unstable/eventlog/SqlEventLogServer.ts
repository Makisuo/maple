/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as PubSub from "../../PubSub.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as SqlClient from "../sql/SqlClient.ts"
import type * as SqlError from "../sql/SqlError.ts"
import { EntryId, makeRemoteIdUnsafe, type RemoteId } from "./EventJournal.ts"
import * as EventLogEncryption from "./EventLogEncryption.ts"
import * as EventLogServer from "./EventLogServer.ts"

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeStorage = (options?: {
  readonly entryTablePrefix?: string
  readonly remoteIdTable?: string
  readonly insertBatchSize?: number
}): Effect.Effect<
  EventLogServer.Storage["Service"],
  SqlError.SqlError,
  SqlClient.SqlClient | EventLogEncryption.EventLogEncryption | Scope.Scope
> =>
  Effect.gen(function*() {
    const encryptions = yield* EventLogEncryption.EventLogEncryption
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    const tablePrefix = options?.entryTablePrefix ?? "effect_events"
    const remoteIdTable = options?.remoteIdTable ?? "effect_remote_id"
    const insertBatchSize = options?.insertBatchSize ?? 200

    const remoteIdTableSql = sql(remoteIdTable)

    yield* sql.onDialectOrElse({
      pg: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remoteIdTableSql} (
            remote_id BYTEA PRIMARY KEY
          )`,
      mysql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remoteIdTableSql} (
            remote_id BINARY(16) PRIMARY KEY
          )`,
      mssql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remoteIdTableSql} (
            remote_id VARBINARY(16) PRIMARY KEY
          )`,
      orElse: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remoteIdTableSql} (
            remote_id BLOB PRIMARY KEY
          )`
    })

    const remoteId = yield* sql<{ remote_id: Uint8Array }>`SELECT remote_id FROM ${remoteIdTableSql}`.pipe(
      Effect.flatMap((results) => {
        if (results.length > 0) {
          return Effect.succeed(results[0].remote_id as RemoteId)
        }
        const created = makeRemoteIdUnsafe()
        return Effect.as(
          sql`INSERT INTO ${remoteIdTableSql} (remote_id) VALUES (${created})`,
          created
        )
      })
    )

    const resources = yield* RcMap.make({
      lookup: Effect.fnUntraced(function*(publicKey: string) {
        const publicKeyHash = (yield* encryptions.sha256String(new TextEncoder().encode(publicKey))).slice(0, 16)
        const table = `${tablePrefix}_${publicKeyHash}`
        const tableSql = sql(table)

        yield* sql.onDialectOrElse({
          pg: () =>
            sql`
                CREATE TABLE IF NOT EXISTS ${tableSql} (
                  sequence SERIAL PRIMARY KEY,
                  iv BYTEA NOT NULL,
                  entry_id BYTEA UNIQUE NOT NULL,
                  encrypted_entry BYTEA NOT NULL
                )`,
          mysql: () =>
            sql`
                CREATE TABLE IF NOT EXISTS ${tableSql} (
                  sequence INT AUTO_INCREMENT PRIMARY KEY,
                  iv BINARY(12) NOT NULL,
                  entry_id BINARY(16) UNIQUE NOT NULL,
                  encrypted_entry BLOB NOT NULL
                )`,
          mssql: () =>
            sql`
                CREATE TABLE IF NOT EXISTS ${tableSql} (
                  sequence INT IDENTITY(1,1) PRIMARY KEY,
                  iv VARBINARY(12) NOT NULL,
                  entry_id VARBINARY(16) UNIQUE NOT NULL,
                  encrypted_entry VARBINARY(MAX) NOT NULL
                )`,
          orElse: () =>
            sql`
                CREATE TABLE IF NOT EXISTS ${tableSql} (
                  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                  iv BLOB NOT NULL,
                  entry_id BLOB UNIQUE NOT NULL,
                  encrypted_entry BLOB NOT NULL
                )`
        })

        const pubsub = yield* Effect.acquireRelease(
          PubSub.unbounded<EventLogEncryption.EncryptedRemoteEntry>(),
          PubSub.shutdown
        )
        return { pubsub, table } as const
      }),
      idleTimeToLive: "5 minutes"
    })

    return EventLogServer.Storage.of({
      getId: Effect.succeed(remoteId),
      write: Effect.fnUntraced(
        function*(publicKey, entries) {
          if (entries.length === 0) return []
          const { pubsub, table } = yield* RcMap.get(resources, publicKey)
          const forInsert: Array<{
            readonly ids: Array<EntryId>
            readonly entries: Array<{
              iv: Uint8Array
              entry_id: Uint8Array
              encrypted_entry: Uint8Array
            }>
          }> = [{ ids: [], entries: [] }]
          let currentBatch = forInsert[0]
          for (const entry of entries) {
            currentBatch.ids.push(entry.entryId)
            currentBatch.entries.push({
              iv: entry.iv,
              entry_id: entry.entryId,
              encrypted_entry: entry.encryptedEntry
            })
            if (currentBatch.entries.length === insertBatchSize) {
              currentBatch = { ids: [], entries: [] }
              forInsert.push(currentBatch)
            }
          }

          const allEntries: Array<EventLogEncryption.EncryptedRemoteEntry> = []
          for (const batch of forInsert) {
            if (batch.entries.length === 0) continue
            const encryptedEntries = yield* sql`
              INSERT INTO ${sql(table)} ${sql.insert(batch.entries)} ON CONFLICT DO NOTHING
            `.pipe(
              Effect.andThen(
                sql`SELECT * FROM ${sql(table)} WHERE ${sql.in("entry_id", batch.ids)} ORDER BY sequence ASC`
              ),
              Effect.flatMap(decodeEntries)
            )
            yield* PubSub.publishAll(pubsub, encryptedEntries)
            allEntries.push(...encryptedEntries)
          }
          return allEntries
        },
        Effect.orDie,
        Effect.scoped
      ),
      entries: Effect.fnUntraced(
        function*(publicKey, startSequence) {
          const { table } = yield* RcMap.get(resources, publicKey)
          return yield* sql`SELECT * FROM ${sql(table)} WHERE sequence >= ${startSequence} ORDER BY sequence ASC`.pipe(
            Effect.flatMap(decodeEntries)
          )
        },
        Effect.orDie,
        Effect.scoped
      ),
      changes: Effect.fnUntraced(function*(publicKey, startSequence) {
        const { pubsub, table } = yield* RcMap.get(resources, publicKey)
        const queue = yield* Queue.make<EventLogEncryption.EncryptedRemoteEntry>()
        const subscription = yield* PubSub.subscribe(pubsub)
        const initial = yield* sql`
            SELECT * FROM ${sql(table)} WHERE sequence >= ${startSequence} ORDER BY sequence ASC
          `.pipe(
          Effect.flatMap(decodeEntries)
        )
        yield* Queue.offerAll(queue, initial)
        yield* PubSub.takeAll(subscription).pipe(
          Effect.flatMap((entries) =>
            Queue.offerAll(queue, entries.filter((entry) => entry.sequence >= startSequence))
          ),
          Effect.forever,
          Effect.forkScoped
        )
        yield* Effect.addFinalizer(() => Queue.shutdown(queue))
        return Queue.asDequeue(queue)
      }, Effect.orDie)
    })
  })

const EncryptedRemoteEntrySql = Schema.Struct({
  sequence: Schema.Number,
  iv: Schema.Uint8Array,
  entry_id: EntryId,
  encrypted_entry: Schema.Uint8Array
})

type EncryptedRemoteEntrySql = Schema.Schema.Type<typeof EncryptedRemoteEntrySql>

const decodeEntryRows = Schema.decodeUnknownEffect(Schema.Array(EncryptedRemoteEntrySql))

const toEncryptedRemoteEntry = (row: EncryptedRemoteEntrySql): EventLogEncryption.EncryptedRemoteEntry => ({
  sequence: row.sequence,
  iv: row.iv,
  entryId: row.entry_id,
  encryptedEntry: row.encrypted_entry
})

const decodeEntries = (
  rows: unknown
): Effect.Effect<ReadonlyArray<EventLogEncryption.EncryptedRemoteEntry>, Schema.SchemaError> =>
  decodeEntryRows(rows).pipe(Effect.map((entries) => entries.map(toEncryptedRemoteEntry)))

/**
 * @since 4.0.0
 * @category layers
 */
export const layerStorage = (options?: {
  readonly entryTablePrefix?: string
  readonly remoteIdTable?: string
  readonly insertBatchSize?: number
}): Layer.Layer<
  EventLogServer.Storage,
  SqlError.SqlError,
  SqlClient.SqlClient | EventLogEncryption.EventLogEncryption
> => Layer.effect(EventLogServer.Storage)(makeStorage(options))

/**
 * @since 4.0.0
 * @category layers
 */
export const layerStorageSubtle = (options?: {
  readonly entryTablePrefix?: string
  readonly remoteIdTable?: string
  readonly insertBatchSize?: number
}): Layer.Layer<EventLogServer.Storage, SqlError.SqlError, SqlClient.SqlClient> =>
  layerStorage(options).pipe(
    Layer.provide(EventLogEncryption.layerSubtle)
  )

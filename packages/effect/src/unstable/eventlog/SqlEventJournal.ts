/**
 * @since 4.0.0
 */
import * as Uuid from "uuid"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as PubSub from "../../PubSub.ts"
import * as Schema from "../../Schema.ts"
import * as SqlClient from "../sql/SqlClient.ts"
import * as SqlError from "../sql/SqlError.ts"
import * as SqlSchema from "../sql/SqlSchema.ts"
import * as EventJournal from "./EventJournal.ts"

type WriteFromRemoteOptions = Parameters<EventJournal.EventJournal["Service"]["writeFromRemote"]>[0]

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (options?: {
  readonly entryTable?: string
  readonly remotesTable?: string
}): Effect.Effect<
  EventJournal.EventJournal["Service"],
  SqlError.SqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function*() {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    const entryTable = options?.entryTable ?? "effect_event_journal"
    const remotesTable = options?.remotesTable ?? "effect_event_remotes"

    const entryTableSql = sql(entryTable)
    const remotesTableSql = sql(remotesTable)

    yield* sql.onDialectOrElse({
      pg: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${entryTableSql} (
            id UUID PRIMARY KEY,
            event TEXT NOT NULL,
            primary_key TEXT NOT NULL,
            payload BYTEA NOT NULL,
            timestamp BIGINT NOT NULL
          )`,
      mysql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${entryTableSql} (
            id BINARY(16) PRIMARY KEY,
            event TEXT NOT NULL,
            primary_key TEXT NOT NULL,
            payload BLOB NOT NULL,
            timestamp BIGINT NOT NULL
          )`,
      mssql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${entryTableSql} (
            id UNIQUEIDENTIFIER PRIMARY KEY,
            event NVARCHAR(MAX) NOT NULL,
            primary_key NVARCHAR(MAX) NOT NULL,
            payload VARBINARY(MAX) NOT NULL,
            timestamp BIGINT NOT NULL
          )`,
      orElse: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${entryTableSql} (
            id BLOB PRIMARY KEY,
            event TEXT NOT NULL,
            primary_key TEXT NOT NULL,
            payload BLOB NOT NULL,
            timestamp INTEGER NOT NULL
          )`
    }).pipe(withTracerDisabled)

    yield* sql.onDialectOrElse({
      pg: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remotesTableSql} (
            remote_id UUID NOT NULL,
            entry_id UUID NOT NULL,
            sequence INT NOT NULL,
            PRIMARY KEY (remote_id, entry_id)
          )`,
      mysql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remotesTableSql} (
            remote_id BINARY(16) NOT NULL,
            entry_id BINARY(16) NOT NULL,
            sequence INT NOT NULL,
            PRIMARY KEY (remote_id, entry_id)
          )`,
      mssql: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remotesTableSql} (
            remote_id UNIQUEIDENTIFIER NOT NULL,
            entry_id UNIQUEIDENTIFIER NOT NULL,
            sequence INT NOT NULL,
            PRIMARY KEY (remote_id, entry_id)
          )`,
      orElse: () =>
        sql`
          CREATE TABLE IF NOT EXISTS ${remotesTableSql} (
            remote_id BLOB NOT NULL,
            entry_id BLOB NOT NULL,
            sequence INT NOT NULL,
            PRIMARY KEY (remote_id, entry_id)
          )`
    }).pipe(withTracerDisabled)

    const decodeEntryRows = Schema.decodeUnknownEffect(EntryRowArray)
    const toEntries = (rows: ReadonlyArray<EntryRow>): ReadonlyArray<EventJournal.Entry> => rows.map(toEntry)

    const insertEntry = SqlSchema.void({
      Request: EntryRow,
      execute: (entry) => sql`INSERT INTO ${entryTableSql} ${sql.insert(entry)} ON CONFLICT DO NOTHING`
    })
    const insertEntries = SqlSchema.void({
      Request: EntryRowArray,
      execute: (entries) => sql`INSERT INTO ${entryTableSql} ${sql.insert(entries)} ON CONFLICT DO NOTHING`
    })
    const insertRemotes = SqlSchema.void({
      Request: RemoteRowArray,
      execute: (entries) => sql`INSERT INTO ${remotesTableSql} ${sql.insert(entries)} ON CONFLICT DO NOTHING`
    })

    const pubsub = yield* PubSub.unbounded<EventJournal.Entry>()

    const writeFromRemote = Effect.fnUntraced(function*(options: WriteFromRemoteOptions): Effect.fn.Return<
      {
        readonly duplicateEntries: ReadonlyArray<EventJournal.Entry>
      },
      EventJournal.EventJournalError | Schema.SchemaError | SqlError.SqlError
    > {
      const entries = options.entries.map((remoteEntry) => remoteEntry.entry)
      const remoteRows = options.entries.map((remoteEntry) => ({
        remote_id: options.remoteId,
        entry_id: remoteEntry.entry.id,
        sequence: remoteEntry.remoteSequence
      }))

      const existingIds = new Set<string>()
      if (entries.length > 0) {
        yield* sql<{ id: Uint8Array }>`SELECT id FROM ${entryTableSql} WHERE ${
          sql.in(
            "id",
            entries.map((entry) => entry.id)
          )
        }`.pipe(
          Effect.tap((rows) =>
            Effect.sync(() => {
              for (const row of rows) {
                existingIds.add(Uuid.stringify(row.id))
              }
            })
          )
        )
      }
      if (entries.length > 0) {
        yield* insertEntries(entries.map(toEntryRow))
      }
      if (remoteRows.length > 0) {
        yield* insertRemotes(remoteRows)
      }

      const uncommitted = options.entries.filter((entry) => !existingIds.has(entry.entry.idString))
      const duplicateEntries = options.entries
        .filter((entry) => existingIds.has(entry.entry.idString))
        .map((entry) => entry.entry)
      const compacted = options.compact
        ? yield* options.compact(uncommitted)
        : uncommitted.map((remoteEntry) => remoteEntry.entry)

      for (const entry of compacted) {
        const conflicts = yield* sql`
            SELECT *
            FROM ${entryTableSql}
            WHERE event = ${entry.event} AND
                  primary_key = ${entry.primaryKey} AND
                  timestamp >= ${entry.createdAtMillis}
            ORDER BY timestamp ASC
          `.pipe(
          Effect.flatMap(decodeEntryRows),
          Effect.map(toEntries)
        )
        yield* options.effect({ entry, conflicts })
      }

      return {
        duplicateEntries
      }
    })

    return EventJournal.EventJournal.of({
      entries: sql`SELECT * FROM ${entryTableSql} ORDER BY timestamp ASC`.pipe(
        withTracerDisabled,
        Effect.flatMap(decodeEntryRows),
        Effect.map(toEntries),
        Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "entries" }))
      ),
      write: Effect.fnUntraced(
        function*({ effect, event, payload, primaryKey }) {
          const entry = new EventJournal.Entry({
            id: EventJournal.makeEntryIdUnsafe(),
            event,
            primaryKey,
            payload
          }, { disableChecks: true })
          yield* insertEntry(toEntryRow(entry))
          const value = yield* effect(entry)
          yield* PubSub.publish(pubsub, entry)
          return value
        },
        withTracerDisabled,
        Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "write" }))
      ),
      writeFromRemote: (options) =>
        writeFromRemote(options).pipe(
          withTracerDisabled,
          Effect.catchIf(
            (e) => e._tag !== "EventJournalError",
            (cause) => Effect.fail(new EventJournal.EventJournalError({ cause, method: "writeFromRemote" }))
          )
        ),
      withRemoteUncommited: Effect.fnUntraced(
        function*(remoteId, f) {
          const entries = yield* sql`
            SELECT *
            FROM ${entryTableSql}
            WHERE id NOT IN (SELECT entry_id FROM ${remotesTableSql} WHERE remote_id = ${remoteId})
            ORDER BY timestamp ASC
          `.pipe(
            Effect.flatMap(decodeEntryRows),
            Effect.map(toEntries)
          )
          return yield* f(entries)
        },
        withTracerDisabled,
        Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "withRemoteUncommited" }))
      ),
      nextRemoteSequence: (remoteId) =>
        sql<{ max: number | null }>`SELECT MAX(sequence) AS max FROM ${remotesTableSql} WHERE remote_id = ${remoteId}`
          .pipe(
            Effect.map((rows) => {
              const value = rows[0]?.max
              if (value === null || value === undefined) return 0
              return Number(value) + 1
            }),
            withTracerDisabled,
            Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "nextRemoteSequence" }))
          ),
      changes: PubSub.subscribe(pubsub),
      destroy: Effect.gen(function*() {
        yield* sql`DROP TABLE ${entryTableSql}`
        yield* sql`DROP TABLE ${remotesTableSql}`
      }).pipe(
        withTracerDisabled,
        Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "destroy" }))
      ),
      withLock(_storeId) {
        return (effect) =>
          sql.withTransaction(effect).pipe(
            Effect.catchIf(SqlError.isSqlError, Effect.die)
          )
      }
    })
  })

/**
 * @since 4.0.0
 * @category layers
 */
export const layer = (options?: {
  readonly entryTable?: string
  readonly remotesTable?: string
}): Layer.Layer<EventJournal.EventJournal, SqlError.SqlError, SqlClient.SqlClient> =>
  Layer.effect(EventJournal.EventJournal)(make(options))

const EntryRow = Schema.Struct({
  id: EventJournal.EntryId,
  event: Schema.String,
  primary_key: Schema.String,
  payload: Schema.Uint8Array,
  timestamp: Schema.Number
})

const EntryRowArray = Schema.Array(EntryRow)

type EntryRow = Schema.Schema.Type<typeof EntryRow>

const toEntry = (row: EntryRow): EventJournal.Entry =>
  new EventJournal.Entry({
    id: row.id,
    event: row.event,
    primaryKey: row.primary_key,
    payload: row.payload
  }, { disableChecks: true })

const toEntryRow = (entry: EventJournal.Entry): EntryRow => ({
  id: entry.id,
  event: entry.event,
  primary_key: entry.primaryKey,
  payload: entry.payload,
  timestamp: EventJournal.entryIdMillis(entry.id)
})

const RemoteRow = Schema.Struct({
  remote_id: EventJournal.RemoteId,
  entry_id: EventJournal.EntryId,
  sequence: Schema.Number
})

const RemoteRowArray = Schema.Array(RemoteRow)

const withTracerDisabled = Effect.withTracerEnabled(false)

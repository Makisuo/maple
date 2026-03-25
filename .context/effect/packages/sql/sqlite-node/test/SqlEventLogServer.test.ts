import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import * as EventJournal from "effect/unstable/eventlog/EventJournal"
import * as EventLog from "effect/unstable/eventlog/EventLog"
import * as EventLogEncryption from "effect/unstable/eventlog/EventLogEncryption"
import * as EventLogServer from "effect/unstable/eventlog/EventLogServer"
import * as SqlEventLogServer from "effect/unstable/eventlog/SqlEventLogServer"
import { Reactivity } from "effect/unstable/reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const makeEntry = (value: number) =>
  new EventJournal.Entry({
    id: EventJournal.makeEntryIdUnsafe(),
    event: "UserCreated",
    primaryKey: `user-${value}`,
    payload: new Uint8Array([value])
  }, { disableChecks: true })

const persistEntries = (
  encryption: EventLogEncryption.EventLogEncryption["Service"],
  identity: EventLog.Identity["Service"],
  entries: ReadonlyArray<EventJournal.Entry>
) =>
  Effect.gen(function*() {
    const encrypted = yield* encryption.encrypt(identity, entries)
    return encrypted.encryptedEntries.map((encryptedEntry, index) =>
      new EventLogServer.PersistedEntry({
        entryId: entries[index].id,
        iv: encrypted.iv,
        encryptedEntry
      })
    )
  })

describe("SqlEventLogServer", () => {
  it.effect("persists remote id across storage instances", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* SqliteClient.make({ filename: ":memory:" })
        const storageA = yield* SqlEventLogServer.makeStorage().pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
        const storageB = yield* SqlEventLogServer.makeStorage().pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
        const idA = yield* storageA.getId
        const idB = yield* storageB.getId
        assert.deepStrictEqual(idA, idB)
      })
    ).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("writes entries and streams changes", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* SqliteClient.make({ filename: ":memory:" })
        const storage = yield* SqlEventLogServer.makeStorage().pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
        const encryption = yield* EventLogEncryption.EventLogEncryption
        const identity = EventLog.makeIdentityUnsafe()
        const entries = [makeEntry(1), makeEntry(2)]
        const persisted = yield* persistEntries(encryption, identity, entries)
        const written = yield* storage.write(identity.publicKey, persisted)
        assert.deepStrictEqual(written.map((entry) => entry.sequence), [1, 2])

        const stored = yield* storage.entries(identity.publicKey, 0)
        assert.deepStrictEqual(stored.map((entry) => entry.sequence), [1, 2])

        const changes = yield* storage.changes(identity.publicKey, 0)
        const initial = yield* Queue.takeAll(changes)
        assert.deepStrictEqual(initial.map((entry) => entry.sequence), [1, 2])

        const nextEntry = makeEntry(3)
        const nextPersisted = yield* persistEntries(encryption, identity, [nextEntry])
        const updated = yield* storage.write(identity.publicKey, nextPersisted)
        assert.deepStrictEqual(updated.map((entry) => entry.sequence), [3])

        const next = yield* Queue.take(changes)
        assert.strictEqual(next.sequence, 3)
      })
    ).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))
})

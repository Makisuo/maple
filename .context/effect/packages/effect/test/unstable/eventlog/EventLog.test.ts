import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import * as EventGroup from "effect/unstable/eventlog/EventGroup"
import * as EventJournal from "effect/unstable/eventlog/EventJournal"
import * as EventLog from "effect/unstable/eventlog/EventLog"
import * as EventLogEncryption from "effect/unstable/eventlog/EventLogEncryption"

const UserPayload = Schema.Struct({
  id: Schema.String
})

const UserGroup = EventGroup.empty.add({
  tag: "UserCreated",
  primaryKey: (payload) => payload.id,
  payload: UserPayload
})

const schema = EventLog.schema(UserGroup)

const handlerLayer = (handled: Ref.Ref<ReadonlyArray<string>>) =>
  EventLog.group(
    UserGroup,
    (handlers) =>
      handlers.handle("UserCreated", ({ payload }) => Ref.update(handled, (values) => [...values, payload.id]))
  )

const logLayer = (handled: Ref.Ref<ReadonlyArray<string>>) =>
  EventLog.layer(schema).pipe(
    Layer.provideMerge(EventJournal.layerMemory),
    Layer.provideMerge(Layer.succeed(EventLog.Identity, EventLog.makeIdentityUnsafe())),
    Layer.provideMerge(handlerLayer(handled))
  )

describe("EventLog", () => {
  it.effect("writes entries and runs handlers", () =>
    Effect.gen(function*() {
      const handled = yield* Ref.make<ReadonlyArray<string>>([])
      return yield* Effect.gen(function*() {
        const log = yield* EventLog.EventLog
        yield* log.write({
          schema,
          event: "UserCreated",
          payload: { id: "user-1" }
        })
        const entries = yield* log.entries
        const seen = yield* Ref.get(handled)
        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].event, "UserCreated")
        assert.deepStrictEqual(seen, ["user-1"])
      }).pipe(Effect.provide(logLayer(handled)))
    }))

  it.effect("encrypts and decrypts entries", () =>
    Effect.gen(function*() {
      const encryption = yield* EventLogEncryption.EventLogEncryption
      const identity = EventLog.makeIdentityUnsafe()
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe(),
        event: "UserCreated",
        primaryKey: "user-1",
        payload: new Uint8Array([1, 2, 3])
      }, { disableChecks: true })
      const encrypted = yield* encryption.encrypt(identity, [entry])
      const decrypted = yield* encryption.decrypt(identity, [{
        sequence: 0,
        iv: encrypted.iv,
        entryId: entry.id,
        encryptedEntry: encrypted.encryptedEntries[0]
      }])
      assert.strictEqual(decrypted.length, 1)
      assert.strictEqual(decrypted[0].entry.idString, entry.idString)
    }).pipe(Effect.provide(EventLogEncryption.layerSubtle)))
})

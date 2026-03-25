/**
 * @since 4.0.0
 */
import * as Uuid from "uuid"
import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as FiberMap from "../../FiberMap.ts"
import * as Layer from "../../Layer.ts"
import * as PubSub from "../../PubSub.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as HttpServerError from "../http/HttpServerError.ts"
import * as HttpServerRequest from "../http/HttpServerRequest.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import type * as Socket from "../socket/Socket.ts"
import { EntryId, makeRemoteIdUnsafe, type RemoteId } from "./EventJournal.ts"
import type { EncryptedRemoteEntry } from "./EventLogEncryption.ts"
import {
  Ack,
  Changes,
  ChunkedMessage,
  decodeRequest,
  encodeResponse,
  Hello,
  Pong,
  type ProtocolRequest,
  type ProtocolResponse
} from "./EventLogRemote.ts"

const constChunkSize = 512_000

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeHandler: Effect.Effect<
  (socket: Socket.Socket) => Effect.Effect<void, Socket.SocketError>,
  never,
  Storage
> = Effect.gen(function*() {
  const storage = yield* Storage
  const remoteId = yield* storage.getId
  let chunkId = 0

  return Effect.fnUntraced(
    function*(socket: Socket.Socket) {
      const subscriptions = yield* FiberMap.make<string>()
      const writeRaw = yield* socket.writer
      const chunks = new Map<
        number,
        {
          readonly parts: Array<Uint8Array>
          count: number
          bytes: number
        }
      >()
      let latestSequence = -1

      const write = Effect.fnUntraced(function*(response: Schema.Schema.Type<typeof ProtocolResponse>) {
        const data = yield* encodeResponse(response)
        if (response._tag !== "Changes" || data.byteLength <= constChunkSize) {
          return yield* writeRaw(data)
        }
        const id = chunkId++
        for (const part of ChunkedMessage.split(id, data)) {
          yield* writeRaw(yield* encodeResponse(part))
        }
      })

      yield* Effect.forkChild(Effect.orDie(write(new Hello({ remoteId }))))

      const handleRequest = (request: Schema.Schema.Type<typeof ProtocolRequest>): Effect.Effect<void> => {
        switch (request._tag) {
          case "Ping": {
            return Effect.orDie(write(new Pong({ id: request.id })))
          }
          case "WriteEntries": {
            if (request.encryptedEntries.length === 0) {
              return Effect.orDie(
                write(
                  new Ack({
                    id: request.id,
                    sequenceNumbers: []
                  })
                )
              )
            }
            return Effect.gen(function*() {
              const entries = request.encryptedEntries.map(({ encryptedEntry, entryId }) =>
                new PersistedEntry({
                  entryId,
                  iv: request.iv,
                  encryptedEntry
                })
              )
              const encrypted = yield* storage.write(request.publicKey, entries)
              latestSequence = encrypted[encrypted.length - 1].sequence
              return yield* Effect.orDie(
                write(
                  new Ack({
                    id: request.id,
                    sequenceNumbers: encrypted.map((entry) => entry.sequence)
                  })
                )
              )
            })
          }
          case "RequestChanges": {
            return Effect.gen(function*() {
              const changes = yield* storage.changes(request.publicKey, request.startSequence)
              return yield* Queue.takeAll(changes).pipe(
                Effect.flatMap((entries) => {
                  const latestEntries: Array<EncryptedRemoteEntry> = []
                  for (const entry of entries) {
                    if (entry.sequence <= latestSequence) continue
                    latestEntries.push(entry)
                    latestSequence = entry.sequence
                  }
                  if (latestEntries.length === 0) return Effect.void
                  return Effect.orDie(
                    write(
                      new Changes({
                        publicKey: request.publicKey,
                        entries: latestEntries
                      })
                    )
                  )
                }),
                Effect.forever
              )
            }).pipe(
              Effect.scoped,
              FiberMap.run(subscriptions, request.publicKey)
            )
          }
          case "StopChanges": {
            return FiberMap.remove(subscriptions, request.publicKey)
          }
          case "ChunkedMessage": {
            const data = ChunkedMessage.join(chunks, request)
            if (!data) return Effect.void
            return Effect.flatMap(Effect.orDie(decodeRequest(data)), handleRequest)
          }
        }
      }

      yield* socket.run((data) => Effect.flatMap(Effect.orDie(decodeRequest(data)), handleRequest)).pipe(
        Effect.catchCause((cause) => Effect.logDebug(cause))
      )
    },
    Effect.scoped,
    Effect.annotateLogs({
      module: "EventLogServer"
    })
  )
})

/**
 * @since 4.0.0
 * @category websockets
 */
export const makeHandlerHttp: Effect.Effect<
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError | Socket.SocketError,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  never,
  Storage
> = Effect.gen(function*() {
  const handler = yield* makeHandler

  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const socket = yield* request.upgrade
    yield* handler(socket)
    return HttpServerResponse.empty()
  }).pipe(Effect.annotateLogs({
    module: "EventLogServer"
  }))
})

/**
 * @since 4.0.0
 * @category storage
 */
export class PersistedEntry extends Schema.Class<PersistedEntry>(
  "effect/eventlog/EventLogServer/PersistedEntry"
)({
  entryId: EntryId,
  iv: Schema.Uint8Array,
  encryptedEntry: Schema.Uint8Array
}) {
  /**
   * @since 4.0.0
   */
  get entryIdString(): string {
    return Uuid.stringify(this.entryId)
  }
}

/**
 * @since 4.0.0
 * @category storage
 */
export class Storage extends ServiceMap.Service<Storage, {
  readonly getId: Effect.Effect<RemoteId>
  readonly write: (
    publicKey: string,
    entries: ReadonlyArray<PersistedEntry>
  ) => Effect.Effect<ReadonlyArray<EncryptedRemoteEntry>>
  readonly entries: (
    publicKey: string,
    startSequence: number
  ) => Effect.Effect<ReadonlyArray<EncryptedRemoteEntry>>
  readonly changes: (
    publicKey: string,
    startSequence: number
  ) => Effect.Effect<Queue.Dequeue<EncryptedRemoteEntry, Cause.Done>, never, Scope.Scope>
}>()("effect/eventlog/EventLogServer/Storage") {}

/**
 * @since 4.0.0
 * @category storage
 */
export const makeStorageMemory: Effect.Effect<Storage["Service"], never, Scope.Scope> = Effect.gen(function*() {
  const knownIds = new Map<string, number>()
  const journals = new Map<string, Array<EncryptedRemoteEntry>>()
  const remoteId = makeRemoteIdUnsafe()
  const ensureJournal = (publicKey: string) => {
    let journal = journals.get(publicKey)
    if (journal) return journal
    journal = []
    journals.set(publicKey, journal)
    return journal
  }
  const pubsubs = yield* RcMap.make({
    lookup: (_publicKey: string) =>
      Effect.acquireRelease(
        PubSub.unbounded<EncryptedRemoteEntry>(),
        PubSub.shutdown
      ),
    idleTimeToLive: 60000
  })

  return Storage.of({
    getId: Effect.succeed(remoteId),
    write: (publicKey, entries) =>
      Effect.gen(function*() {
        const active = yield* RcMap.keys(pubsubs)
        let pubsub: PubSub.PubSub<EncryptedRemoteEntry> | undefined
        for (const key of active) {
          if (key === publicKey) {
            pubsub = yield* RcMap.get(pubsubs, publicKey)
            break
          }
        }
        const journal = ensureJournal(publicKey)
        const encryptedEntries: Array<EncryptedRemoteEntry> = []
        for (const entry of entries) {
          const idString = entry.entryIdString
          if (knownIds.has(idString)) continue
          const encrypted: EncryptedRemoteEntry = {
            sequence: journal.length,
            entryId: entry.entryId,
            iv: entry.iv,
            encryptedEntry: entry.encryptedEntry
          }
          encryptedEntries.push(encrypted)
          knownIds.set(idString, encrypted.sequence)
          journal.push(encrypted)
          if (pubsub) {
            yield* PubSub.publish(pubsub, encrypted)
          }
        }
        return encryptedEntries
      }).pipe(Effect.scoped),
    entries: (publicKey, startSequence) => Effect.sync(() => ensureJournal(publicKey).slice(startSequence)),
    changes: (publicKey, startSequence) =>
      Effect.gen(function*() {
        const queue = yield* Queue.make<EncryptedRemoteEntry>()
        const pubsub = yield* RcMap.get(pubsubs, publicKey)
        const subscription = yield* PubSub.subscribe(pubsub)
        yield* Queue.offerAll(queue, ensureJournal(publicKey).slice(startSequence))
        yield* PubSub.takeAll(subscription).pipe(
          Effect.flatMap((chunk) => Queue.offerAll(queue, chunk)),
          Effect.forever,
          Effect.forkScoped
        )
        yield* Effect.addFinalizer(() => Queue.shutdown(queue))
        return Queue.asDequeue(queue)
      })
  })
})

/**
 * @since 4.0.0
 * @category storage
 */
export const layerStorageMemory: Layer.Layer<Storage> = Layer.effect(Storage)(makeStorageMemory)

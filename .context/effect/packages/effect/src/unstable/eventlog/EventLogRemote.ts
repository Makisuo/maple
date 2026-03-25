/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Deferred from "../../Deferred.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Layer from "../../Layer.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Msgpack from "../encoding/Msgpack.ts"
import * as Socket from "../socket/Socket.ts"
import { type Entry, EntryId, RemoteEntry, RemoteId } from "./EventJournal.ts"
import type { Identity } from "./EventLog.ts"
import { EncryptedEntry, EncryptedRemoteEntry, EventLogEncryption, layerSubtle } from "./EventLogEncryption.ts"

/**
 * @since 4.0.0
 * @category models
 */
export class EventLogRemote extends ServiceMap.Service<EventLogRemote, {
  readonly id: RemoteId
  readonly changes: (
    identity: Identity["Service"],
    startSequence: number
  ) => Effect.Effect<Queue.Dequeue<RemoteEntry>, never, Scope.Scope>
  readonly write: (identity: Identity["Service"], entries: ReadonlyArray<Entry>) => Effect.Effect<void>
}>()("effect/eventlog/EventLogRemote") {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Hello extends Schema.Class<Hello>("effect/eventlog/EventLogRemote/Hello")({
  _tag: Schema.tag("Hello"),
  remoteId: RemoteId
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class ChunkedMessage extends Schema.Class<ChunkedMessage>("effect/eventlog/EventLogRemote/ChunkedMessage")({
  _tag: Schema.tag("ChunkedMessage"),
  id: Schema.Number,
  part: Schema.Tuple([Schema.Number, Schema.Number]),
  data: Schema.Uint8Array
}) {
  /**
   * @since 4.0.0
   */
  static split(id: number, data: Uint8Array): ReadonlyArray<ChunkedMessage> {
    const parts = Math.ceil(data.byteLength / constChunkSize)
    const result: Array<ChunkedMessage> = new Array(parts)
    for (let i = 0; i < parts; i++) {
      const start = i * constChunkSize
      const end = Math.min((i + 1) * constChunkSize, data.byteLength)
      result[i] = new ChunkedMessage({
        _tag: "ChunkedMessage",
        id,
        part: [i, parts],
        data: data.subarray(start, end)
      })
    }
    return result
  }

  /**
   * @since 4.0.0
   */
  static join(
    map: Map<number, {
      readonly parts: Array<Uint8Array>
      count: number
      bytes: number
    }>,
    part: ChunkedMessage
  ): Uint8Array | undefined {
    const [index, total] = part.part
    let entry = map.get(part.id)
    if (!entry) {
      entry = {
        parts: new Array(total),
        count: 0,
        bytes: 0
      }
      map.set(part.id, entry)
    }
    entry.parts[index] = part.data
    entry.count++
    entry.bytes += part.data.byteLength
    if (entry.count !== total) {
      return
    }
    const data = new Uint8Array(entry.bytes)
    let offset = 0
    for (const part of entry.parts) {
      data.set(part, offset)
      offset += part.byteLength
    }
    map.delete(part.id)
    return data
  }
}

/**
 * @since 4.0.0
 * @category protocol
 */
export class WriteEntries extends Schema.Class<WriteEntries>("effect/eventlog/EventLogRemote/WriteEntries")({
  _tag: Schema.tag("WriteEntries"),
  publicKey: Schema.String,
  id: Schema.Number,
  iv: Schema.Uint8Array,
  encryptedEntries: Schema.Array(EncryptedEntry)
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Ack extends Schema.Class<Ack>("effect/eventlog/EventLogRemote/Ack")({
  _tag: Schema.tag("Ack"),
  id: Schema.Number,
  sequenceNumbers: Schema.Array(Schema.Number)
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class RequestChanges extends Schema.Class<RequestChanges>("effect/eventlog/EventLogRemote/RequestChanges")({
  _tag: Schema.tag("RequestChanges"),
  publicKey: Schema.String,
  startSequence: Schema.Number
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Changes extends Schema.Class<Changes>("effect/eventlog/EventLogRemote/Changes")({
  _tag: Schema.tag("Changes"),
  publicKey: Schema.String,
  entries: Schema.Array(EncryptedRemoteEntry)
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class StopChanges extends Schema.Class<StopChanges>("effect/eventlog/EventLogRemote/StopChanges")({
  _tag: Schema.tag("StopChanges"),
  publicKey: Schema.String
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Ping extends Schema.Class<Ping>("effect/eventlog/EventLogRemote/Ping")({
  _tag: Schema.tag("Ping"),
  id: Schema.Number
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Pong extends Schema.Class<Pong>("effect/eventlog/EventLogRemote/Pong")({
  _tag: Schema.tag("Pong"),
  id: Schema.Number
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export const ProtocolRequest = Schema.Union([WriteEntries, RequestChanges, StopChanges, ChunkedMessage, Ping])

/**
 * @since 4.0.0
 * @category protocol
 */
export const ProtocolRequestMsgpack = Msgpack.schema(ProtocolRequest)

/**
 * @since 4.0.0
 * @category protocol
 */
export const decodeRequest = Schema.decodeUnknownEffect(ProtocolRequestMsgpack)

/**
 * @since 4.0.0
 * @category protocol
 */
export const encodeRequest = Schema.encodeUnknownEffect(ProtocolRequestMsgpack)

/**
 * @since 4.0.0
 * @category protocol
 */
export const ProtocolResponse = Schema.Union([Hello, Ack, Changes, ChunkedMessage, Pong])

/**
 * @since 4.0.0
 * @category protocol
 */
export const ProtocolResponseMsgpack = Msgpack.schema(ProtocolResponse)

/**
 * @since 4.0.0
 * @category protocol
 */
export const decodeResponse = Schema.decodeUnknownEffect(ProtocolResponseMsgpack)

/**
 * @since 4.0.0
 * @category protocol
 */
export const encodeResponse = Schema.encodeUnknownEffect(ProtocolResponseMsgpack)

/**
 * @since 4.0.0
 * @category change
 */
export class RemoteAdditions extends Schema.Class<RemoteAdditions>("effect/eventlog/EventLogRemote/RemoteAdditions")({
  _tag: Schema.tag("RemoteAdditions"),
  entries: Schema.Array(RemoteEntry)
}) {}

const constChunkSize = 512_000

/**
 * @since 4.0.0
 * @category errors
 */
export class EventLogRemoteError extends Data.TaggedError("EventLogRemoteError")<{
  readonly method: string
  readonly cause: unknown
}> {}

/**
 * @since 4.0.0
 * @category entry
 */
export const RemoteEntryChange = Schema.Tuple([RemoteId, Schema.Array(EntryId)])

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromSocket = (options?: {
  readonly disablePing?: boolean
}): Effect.Effect<EventLogRemote["Service"], never, Scope.Scope | EventLogEncryption | Socket.Socket> =>
  Effect.gen(function*() {
    const socket = yield* Socket.Socket
    const encryption = yield* EventLogEncryption
    const writeRaw = yield* socket.writer

    const writeRequest = (request: typeof ProtocolRequest.Type) =>
      Effect.gen(function*() {
        const data = yield* encodeRequest(request)
        if (request._tag !== "WriteEntries" || data.byteLength <= constChunkSize) {
          return yield* writeRaw(data)
        }
        const id = request.id
        for (const part of ChunkedMessage.split(id, data)) {
          yield* writeRaw(yield* encodeRequest(part))
        }
      })

    let pendingCounter = 0
    const pending = new Map<number, {
      readonly entries: ReadonlyArray<Entry>
      readonly deferred: Deferred.Deferred<void>
      readonly publicKey: string
    }>()
    const chunks = new Map<number, {
      readonly parts: Array<Uint8Array>
      count: number
      bytes: number
    }>()

    const subscriptions = yield* RcMap.make({
      lookup: (publicKey: string) =>
        Effect.acquireRelease(
          Queue.make<RemoteEntry>(),
          (queue) =>
            Queue.shutdown(queue).pipe(
              Effect.andThen(Effect.ignore(writeRequest(new StopChanges({ publicKey }))))
            )
        )
    })
    const identities = new Map<string, Identity["Service"]>()
    const badPing = yield* Deferred.make<never, Error>()
    const remoteId = yield* Deferred.make<RemoteId>()

    let latestPing = 0
    let latestPong = 0

    if (options?.disablePing !== true) {
      yield* Effect.suspend(() => {
        if (latestPing !== latestPong) {
          return Deferred.fail(badPing, new Error("Ping timeout"))
        }
        return writeRequest(new Ping({ id: ++latestPing }))
      }).pipe(
        Effect.delay("10 seconds"),
        Effect.ignore,
        Effect.forever,
        Effect.interruptible,
        Effect.forkScoped
      )
    }

    const handleMessage = (res: typeof ProtocolResponse.Type): Effect.Effect<void, unknown, Scope.Scope> => {
      switch (res._tag) {
        case "Hello": {
          return Deferred.succeed(remoteId, res.remoteId).pipe(Effect.asVoid)
        }
        case "Ack": {
          return Effect.gen(function*() {
            const entry = pending.get(res.id)
            if (!entry) return
            pending.delete(res.id)
            const { deferred, entries, publicKey } = entry
            const remoteEntries = res.sequenceNumbers.map((sequenceNumber, i) => {
              const entry = entries[i]
              return new RemoteEntry({
                remoteSequence: sequenceNumber,
                entry
              })
            })
            const queue = yield* RcMap.get(subscriptions, publicKey)
            yield* Queue.offerAll(queue, remoteEntries)
            yield* Deferred.done(deferred, Exit.void)
          }).pipe(Effect.scoped)
        }
        case "Pong": {
          latestPong = res.id
          if (res.id === latestPing) {
            return Effect.void
          }
          return Deferred.fail(badPing, new Error("Pong id mismatch")).pipe(
            Effect.asVoid
          )
        }
        case "Changes": {
          return Effect.gen(function*() {
            const queue = yield* RcMap.get(subscriptions, res.publicKey)
            const identity = identities.get(res.publicKey)
            if (!identity) {
              return
            }
            const entries = yield* encryption.decrypt(identity, res.entries)
            yield* Queue.offerAll(queue, entries)
          }).pipe(Effect.scoped)
        }
        case "ChunkedMessage": {
          const data = ChunkedMessage.join(chunks, res)
          if (!data) return Effect.void
          return Effect.scoped(
            Effect.flatMap(decodeResponse(data), handleMessage)
          )
        }
      }
    }

    yield* socket.run((data) => Effect.flatMap(decodeResponse(data), handleMessage)).pipe(
      Effect.raceFirst(Deferred.await(badPing)),
      Effect.tapCause(Effect.logDebug),
      Effect.retry({
        schedule: Schedule.exponential(100).pipe(
          Schedule.either(Schedule.spaced(5000))
        )
      }),
      Effect.annotateLogs({
        service: "EventLogRemote",
        method: "fromSocket"
      }),
      Effect.forkScoped,
      Effect.interruptible
    )

    const id = yield* Deferred.await(remoteId)

    return {
      id,
      write: (identity, entries) =>
        Effect.gen(function*() {
          const encrypted = yield* encryption.encrypt(identity, entries)
          const deferred = yield* Deferred.make<void>()
          const id = pendingCounter++
          pending.set(id, {
            entries,
            deferred,
            publicKey: identity.publicKey
          })
          yield* Effect.orDie(writeRequest(
            new WriteEntries({
              publicKey: identity.publicKey,
              id,
              iv: encrypted.iv,
              encryptedEntries: encrypted.encryptedEntries.map((encryptedEntry, i) => ({
                entryId: entries[i].id,
                encryptedEntry
              }))
            })
          ))
          yield* Deferred.await(deferred)
        }),
      changes: (identity, startSequence) =>
        Effect.gen(function*() {
          const queue = yield* RcMap.get(subscriptions, identity.publicKey)
          identities.set(identity.publicKey, identity)
          yield* Effect.orDie(writeRequest(
            new RequestChanges({
              publicKey: identity.publicKey,
              startSequence
            })
          ))
          return queue
        })
    }
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromWebSocket = (
  url: string,
  options?: {
    readonly disablePing?: boolean
  }
): Effect.Effect<EventLogRemote["Service"], never, Scope.Scope | EventLogEncryption | Socket.WebSocketConstructor> =>
  Effect.gen(function*() {
    const socket = yield* Socket.makeWebSocket(url)
    return yield* fromSocket(options).pipe(
      Effect.provideService(Socket.Socket, socket)
    )
  })

/**
 * @since 4.0.0
 * @category layers
 */
export const layerWebSocket = (
  url: string,
  options?: {
    readonly disablePing?: boolean
  }
): Layer.Layer<never, never, Socket.WebSocketConstructor | EventLogEncryption> =>
  Layer.effectDiscard(fromWebSocket(url, options))

/**
 * @since 4.0.0
 * @category layers
 */
export const layerWebSocketBrowser = (
  url: string,
  options?: {
    readonly disablePing?: boolean
  }
): Layer.Layer<never> =>
  layerWebSocket(url, options).pipe(
    Layer.provide([layerSubtle, Socket.layerWebSocketConstructorGlobal])
  )

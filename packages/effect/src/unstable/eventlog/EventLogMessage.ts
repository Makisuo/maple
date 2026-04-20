/**
 * @since 4.0.0
 */
import type { NonEmptyArray, NonEmptyReadonlyArray } from "../../Array.ts"
import type { Brand } from "../../Brand.ts"
import * as Schema from "../../Schema.ts"
import * as Msgpack from "../encoding/Msgpack.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcMiddleware from "../rpc/RpcMiddleware.ts"
import * as Transferable from "../workers/Transferable.ts"
import { Entry, RemoteEntry, RemoteId } from "./EventJournal.ts"
import type { Identity } from "./EventLog.ts"
import { EncryptedEntry, EncryptedRemoteEntry } from "./EventLogEncryption.ts"

/**
 * @since 4.0.0
 * @category StoreId
 */
export type StoreIdTypeId = "effect/eventlog/EventLog/StoreId"

/**
 * @since 4.0.0
 * @category StoreId
 */
export const StoreIdTypeId: StoreIdTypeId = "effect/eventlog/EventLog/StoreId"

/**
 * @since 4.0.0
 * @category StoreId
 */
export type StoreId = string & Brand<StoreIdTypeId>

/**
 * @since 4.0.0
 * @category StoreId
 */
export const StoreId = Schema.String.pipe(Schema.brand(StoreIdTypeId))

/**
 * @since 4.0.0
 * @category protocol
 */
export class EventLogProtocolError extends Schema.TaggedErrorClass<EventLogProtocolError>(
  "effect/eventlog/EventLogRemote/ProtocolError"
)("EventLogProtocolError", {
  requestTag: Schema.String,
  publicKey: Schema.optional(Schema.String),
  storeId: Schema.optional(StoreId),
  code: Schema.Literals(["Unauthorized", "Forbidden", "NotFound", "InvalidRequest", "InternalServerError"]),
  message: Schema.String
}) {}

/**
 * @since 4.0.0
 * @category Middleware
 */
export class EventLogAuthentication extends RpcMiddleware.Service<EventLogAuthentication, {
  provides: Identity
}>()("effect/eventlog/EventLogMessage/EventLogAuthentication", {
  error: EventLogProtocolError
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class HelloResponse extends Schema.Class<HelloResponse>("effect/eventlog/EventLogRemote/HelloResponse")({
  remoteId: RemoteId,
  challenge: Transferable.Uint8Array
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class HelloRpc extends Rpc.make("EventLog.Hello", {
  success: HelloResponse
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class Authenticate extends Schema.Class<Authenticate>("effect/eventlog/EventLogRemote/Authenticate")({
  publicKey: Schema.String,
  signingPublicKey: Transferable.Uint8Array,
  signature: Transferable.Uint8Array,
  algorithm: Schema.Literal("Ed25519")
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class AuthenticateRpc extends Rpc.make("EventLog.Authenticate", {
  payload: Authenticate,
  error: EventLogProtocolError
}) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class SingleMessage
  extends Schema.TaggedClass<SingleMessage>("effect/eventlog/EventLogRemote/SingleMessage")("Single", {
    data: Transferable.Uint8Array
  })
{}

/**
 * @since 4.0.0
 * @category protocol
 */
export class ChunkedMessage
  extends Schema.TaggedClass<ChunkedMessage>("effect/eventlog/EventLogRemote/ChunkedMessage")("Chunked", {
    id: Schema.Number,
    part: Schema.Tuple([Schema.Number, Schema.Number]),
    data: Transferable.Uint8Array
  })
{
  static chunkSize = 512_000

  static initialJoinState() {
    return new Map<number, {
      readonly parts: Array<Uint8Array>
      count: number
      bytes: number
    }>()
  }

  /**
   * @since 4.0.0
   */
  static split(id: number, data: Uint8Array): NonEmptyReadonlyArray<ChunkedMessage> {
    const parts = Math.ceil(data.byteLength / ChunkedMessage.chunkSize)
    const result: NonEmptyArray<ChunkedMessage> = new Array(parts) as any
    for (let i = 0; i < parts; i++) {
      const start = i * ChunkedMessage.chunkSize
      const end = Math.min((i + 1) * ChunkedMessage.chunkSize, data.byteLength)
      result[i] = new ChunkedMessage({
        id,
        part: [i, parts],
        data: data.subarray(start, end) as any
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
  ): Uint8Array<ArrayBuffer> | undefined {
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
export class WriteChunkedRpc extends Rpc.make("EventLog.WriteChunked", {
  payload: ChunkedMessage,
  error: EventLogProtocolError
}).middleware(EventLogAuthentication) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class WriteEntries extends Schema.Class<WriteEntries>("effect/eventlog/EventLogRemote/WriteEntries")({
  publicKey: Schema.String,
  storeId: StoreId,
  iv: Transferable.Uint8Array,
  encryptedEntries: Schema.Array(EncryptedEntry)
}) {
  static FromMsgpack = Msgpack.schema(WriteEntries)
  static encode = Schema.encodeEffect(this.FromMsgpack)
  static decode = Schema.decodeEffect(this.FromMsgpack)
  get encoded() {
    return WriteEntries.encode(this)
  }
}

/**
 * @since 4.0.0
 * @category protocol
 */
export class WriteEntriesUnencrypted
  extends Schema.Class<WriteEntriesUnencrypted>("effect/eventlog/EventLogRemote/WriteEntriesUnencrypted")({
    publicKey: Schema.String,
    storeId: StoreId,
    entries: Schema.Array(Entry)
  })
{
  static FromMsgpack = Msgpack.schema(WriteEntriesUnencrypted)
  static encode = Schema.encodeEffect(this.FromMsgpack)
  static decode = Schema.decodeEffect(this.FromMsgpack)
  get encoded() {
    return WriteEntriesUnencrypted.encode(this)
  }
}

/**
 * @since 4.0.0
 * @category protocol
 */
export class WriteSingleRpc extends Rpc.make("EventLog.WriteSingle", {
  payload: {
    data: Transferable.Uint8Array
  },
  error: EventLogProtocolError
}).middleware(EventLogAuthentication) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export class ChangesRpc extends Rpc.make("EventLog.Changes", {
  payload: {
    publicKey: Schema.String,
    storeId: StoreId,
    startSequence: Schema.Number
  },
  success: Schema.Union([SingleMessage, ChunkedMessage]),
  error: EventLogProtocolError,
  stream: true
}).middleware(EventLogAuthentication) {
  static EncryptedFromMsgpack = Msgpack.schema(Schema.NonEmptyArray(EncryptedRemoteEntry))
  static UnencryptedFromMsgpack = Msgpack.schema(Schema.NonEmptyArray(RemoteEntry))
  static encodeEncrypted = Schema.encodeEffect(ChangesRpc.EncryptedFromMsgpack)
  static decodeEncrypted = Schema.decodeEffect(ChangesRpc.EncryptedFromMsgpack)
  static encodeUnencrypted = Schema.encodeEffect(ChangesRpc.UnencryptedFromMsgpack)
  static decodeUnencrypted = Schema.decodeEffect(ChangesRpc.UnencryptedFromMsgpack)
}

/**
 * @since 4.0.0
 * @category protocol
 */
export class EventLogRemoteRpcs extends RpcGroup.make(
  HelloRpc,
  AuthenticateRpc,
  WriteChunkedRpc,
  WriteSingleRpc,
  ChangesRpc
) {}

/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import { Clock } from "../../Clock.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { Predicate } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import { EntityNotAssignedToRunner, MalformedMessage, type PersistenceError } from "./ClusterError.ts"
import * as DeliverAt from "./DeliverAt.ts"
import type { EntityAddress } from "./EntityAddress.ts"
import * as Envelope from "./Envelope.ts"
import * as Message from "./Message.ts"
import * as Reply from "./Reply.ts"
import { ShardId } from "./ShardId.ts"
import type { ShardingConfig } from "./ShardingConfig.ts"
import * as Snowflake from "./Snowflake.ts"

/**
 * @since 4.0.0
 * @category context
 */
export class MessageStorage extends ServiceMap.Service<MessageStorage, {
  /**
   * Save the provided message and its associated metadata.
   */
  readonly saveRequest: <R extends Rpc.Any>(
    envelope: Message.OutgoingRequest<R>
  ) => Effect.Effect<SaveResult<R>, PersistenceError | MalformedMessage>

  /**
   * Save the provided message and its associated metadata.
   */
  readonly saveEnvelope: (
    envelope: Message.OutgoingEnvelope
  ) => Effect.Effect<void, PersistenceError | MalformedMessage>

  /**
   * Save the provided `Reply` and its associated metadata.
   */
  readonly saveReply: <R extends Rpc.Any>(
    reply: Reply.ReplyWithContext<R>
  ) => Effect.Effect<void, PersistenceError | MalformedMessage>

  /**
   * Clear the `Reply`s for the given request id.
   */
  readonly clearReplies: (requestId: Snowflake.Snowflake) => Effect.Effect<void, PersistenceError>

  /**
   * Retrieves the replies for the specified requests.
   *
   * - Un-acknowledged chunk replies
   * - WithExit replies
   */
  readonly repliesFor: <R extends Rpc.Any>(
    requests: Iterable<Message.OutgoingRequest<R>>
  ) => Effect.Effect<Array<Reply.Reply<R>>, PersistenceError | MalformedMessage>

  /**
   * Retrieves the encoded replies for the specified request ids.
   */
  readonly repliesForUnfiltered: (
    requestIds: Iterable<Snowflake.Snowflake>
  ) => Effect.Effect<Array<Reply.Encoded>, PersistenceError | MalformedMessage>

  /**
   * Retrieves the request id for the specified primary key.
   */
  readonly requestIdForPrimaryKey: (
    options: {
      readonly address: EntityAddress
      readonly tag: string
      readonly id: string
    }
  ) => Effect.Effect<Option.Option<Snowflake.Snowflake>, PersistenceError>

  /**
   * For locally sent messages, register a handler to process the replies.
   */
  readonly registerReplyHandler: <R extends Rpc.Any>(
    message: Message.OutgoingRequest<R> | Message.IncomingRequest<R>
  ) => Effect.Effect<void, EntityNotAssignedToRunner>

  /**
   * Unregister the reply handler for the specified message.
   */
  readonly unregisterReplyHandler: (requestId: Snowflake.Snowflake) => Effect.Effect<void>

  /**
   * Unregister the reply handlers for the specified ShardId.
   */
  readonly unregisterShardReplyHandlers: (shardId: ShardId) => Effect.Effect<void>

  /**
   * Retrieves the unprocessed messages for the specified shards.
   *
   * A message is unprocessed when:
   *
   * - Requests that have no WithExit replies
   *   - Or they have no unacknowledged chunk replies
   * - The latest AckChunk envelope
   * - All Interrupt's for unprocessed requests
   */
  readonly unprocessedMessages: (
    shardIds: Iterable<ShardId>
  ) => Effect.Effect<Array<Message.Incoming<any>>, PersistenceError>

  /**
   * Retrieves the unprocessed messages by id.
   */
  readonly unprocessedMessagesById: <R extends Rpc.Any>(
    messageIds: Iterable<Snowflake.Snowflake>
  ) => Effect.Effect<Array<Message.Incoming<R>>, PersistenceError>

  /**
   * Reset the mailbox state for the provided shards.
   */
  readonly resetShards: (
    shardIds: Iterable<ShardId>
  ) => Effect.Effect<void, PersistenceError>

  /**
   * Reset the mailbox state for the provided address.
   */
  readonly resetAddress: (
    address: EntityAddress
  ) => Effect.Effect<void, PersistenceError>

  /**
   * Clear all messages and replies for the provided address.
   */
  readonly clearAddress: (
    address: EntityAddress
  ) => Effect.Effect<void, PersistenceError>
}>()("effect/cluster/MessageStorage") {}

/**
 * @since 4.0.0
 * @category SaveResult
 */
export type SaveResult<R extends Rpc.Any> = SaveResult.Success | SaveResult.Duplicate<R>

/**
 * @since 4.0.0
 * @category SaveResult
 */
export const SaveResult = Data.taggedEnum<SaveResult.Constructor>()

/**
 * @since 4.0.0
 * @category SaveResult
 */
export const SaveResultEncoded = Data.taggedEnum<SaveResult.Encoded>()

/**
 * @since 4.0.0
 * @category SaveResult
 */
export declare namespace SaveResult {
  /**
   * @since 4.0.0
   * @category SaveResult
   */
  export type Encoded = SaveResult.Success | SaveResult.DuplicateEncoded

  /**
   * @since 4.0.0
   * @category SaveResult
   */
  export interface Success {
    readonly _tag: "Success"
  }

  /**
   * @since 4.0.0
   * @category SaveResult
   */
  export interface Duplicate<R extends Rpc.Any> {
    readonly _tag: "Duplicate"
    readonly originalId: Snowflake.Snowflake
    readonly lastReceivedReply: Option.Option<Reply.Reply<R>>
  }

  /**
   * @since 4.0.0
   * @category SaveResult
   */
  export interface DuplicateEncoded {
    readonly _tag: "Duplicate"
    readonly originalId: Snowflake.Snowflake
    readonly lastReceivedReply: Option.Option<Reply.Encoded>
  }

  /**
   * @since 4.0.0
   * @category SaveResult
   */
  export interface Constructor extends Data.TaggedEnum.WithGenerics<1> {
    readonly taggedEnum: SaveResult<this["A"] extends Rpc.Any ? this["A"] : never>
  }
}

/**
 * @since 4.0.0
 * @category Encoded
 */
export type Encoded = {
  /**
   * Save the provided message and its associated metadata.
   */
  readonly saveEnvelope: (
    options: {
      readonly envelope: Envelope.Encoded
      readonly primaryKey: string | null
      readonly deliverAt: number | null
    }
  ) => Effect.Effect<SaveResult.Encoded, PersistenceError>

  /**
   * Save the provided `Reply` and its associated metadata.
   */
  readonly saveReply: (reply: Reply.Encoded) => Effect.Effect<void, PersistenceError>

  /**
   * Remove the replies for the specified request.
   */
  readonly clearReplies: (requestId: Snowflake.Snowflake) => Effect.Effect<void, PersistenceError>

  /**
   * Retrieves the request id for the specified primary key.
   */
  readonly requestIdForPrimaryKey: (
    primaryKey: string
  ) => Effect.Effect<Option.Option<Snowflake.Snowflake>, PersistenceError>

  /**
   * Retrieves the replies for the specified requests.
   *
   * - Un-acknowledged chunk replies
   * - WithExit replies
   */
  readonly repliesFor: (requestIds: Arr.NonEmptyArray<string>) => Effect.Effect<
    Array<Reply.Encoded>,
    PersistenceError
  >

  /**
   * Retrieves the replies for the specified request ids.
   */
  readonly repliesForUnfiltered: (requestIds: Arr.NonEmptyArray<string>) => Effect.Effect<
    Array<Reply.Encoded>,
    PersistenceError
  >

  /**
   * Retrieves the unprocessed messages for the given shards.
   *
   * A message is unprocessed when:
   *
   * - Requests that have no WithExit replies
   *   - Or they have no unacknowledged chunk replies
   * - The latest AckChunk envelope
   * - All Interrupt's for unprocessed requests
   */
  readonly unprocessedMessages: (
    shardIds: Arr.NonEmptyArray<string>,
    now: number
  ) => Effect.Effect<
    Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }>,
    PersistenceError
  >

  /**
   * Retrieves the unprocessed messages by id.
   */
  readonly unprocessedMessagesById: (
    messageIds: Arr.NonEmptyArray<Snowflake.Snowflake>,
    now: number
  ) => Effect.Effect<
    Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }>,
    PersistenceError
  >

  /**
   * Reset the mailbox state for the provided address.
   */
  readonly resetAddress: (
    address: EntityAddress
  ) => Effect.Effect<void, PersistenceError>

  /**
   * Clear all messages and replies for the provided address.
   */
  readonly clearAddress: (
    address: EntityAddress
  ) => Effect.Effect<void, PersistenceError>

  /**
   * Reset the mailbox state for the provided shards.
   */
  readonly resetShards: (
    shardIds: Arr.NonEmptyArray<string>
  ) => Effect.Effect<void, PersistenceError>
}

/**
 * @since 4.0.0
 * @category Encoded
 */
export type EncodedUnprocessedOptions<A> = {
  readonly existingShards: Array<number>
  readonly newShards: Array<number>
  readonly cursor: Option.Option<A>
}

/**
 * @since 4.0.0
 * @category Encoded
 */
export type EncodedRepliesOptions<A> = {
  readonly existingRequests: Array<string>
  readonly newRequests: Array<string>
  readonly cursor: Option.Option<A>
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (
  storage: Omit<
    MessageStorage["Service"],
    "registerReplyHandler" | "unregisterReplyHandler" | "unregisterShardReplyHandlers"
  >
): Effect.Effect<MessageStorage["Service"]> =>
  Effect.sync(() => {
    type ReplyHandler = {
      readonly message: Message.OutgoingRequest<any> | Message.IncomingRequest<any>
      readonly shardSet: Set<ReplyHandler>
      readonly respond: (reply: Reply.ReplyWithContext<any>) => Effect.Effect<void, PersistenceError | MalformedMessage>
      readonly resume: (effect: Effect.Effect<void, EntityNotAssignedToRunner>) => void
    }
    const replyHandlers = new Map<Snowflake.Snowflake, Array<ReplyHandler>>()
    const replyHandlersShard = new Map<string, Set<ReplyHandler>>()
    return MessageStorage.of({
      ...storage,
      registerReplyHandler: (message) => {
        const requestId = message.envelope.requestId
        return Effect.callback<void, EntityNotAssignedToRunner>((resume) => {
          const shardId = message.envelope.address.shardId.toString()
          let handlers = replyHandlers.get(requestId)
          if (handlers === undefined) {
            handlers = []
            replyHandlers.set(requestId, handlers)
          }
          let shardSet = replyHandlersShard.get(shardId)
          if (!shardSet) {
            shardSet = new Set()
            replyHandlersShard.set(shardId, shardSet)
          }
          const entry: ReplyHandler = {
            message,
            shardSet,
            respond: message._tag === "IncomingRequest" ? message.respond : (reply) => message.respond(reply.reply),
            resume
          }
          handlers.push(entry)
          shardSet.add(entry)
          return Effect.sync(() => {
            const index = handlers.indexOf(entry)
            handlers.splice(index, 1)
            shardSet.delete(entry)
          })
        })
      },
      unregisterReplyHandler: (requestId) =>
        Effect.sync(() => {
          const handlers = replyHandlers.get(requestId)
          if (!handlers) return
          replyHandlers.delete(requestId)
          for (let i = 0; i < handlers.length; i++) {
            const handler = handlers[i]
            handler.shardSet.delete(handler)
            handler.resume(Effect.fail(
              new EntityNotAssignedToRunner({
                address: handler.message.envelope.address
              })
            ))
          }
        }),
      unregisterShardReplyHandlers: (shardId) =>
        Effect.sync(() => {
          const id = shardId.toString()
          const shardSet = replyHandlersShard.get(id)
          if (!shardSet) return
          replyHandlersShard.delete(id)
          shardSet.forEach((handler) => {
            replyHandlers.delete(handler.message.envelope.requestId)
            handler.resume(Effect.fail(
              new EntityNotAssignedToRunner({
                address: handler.message.envelope.address
              })
            ))
          })
        }),
      saveReply(reply) {
        const requestId = reply.reply.requestId
        return Effect.flatMap(storage.saveReply(reply), () => {
          const handlers = replyHandlers.get(requestId)
          if (!handlers) {
            return Effect.void
          } else if (reply.reply._tag === "WithExit") {
            replyHandlers.delete(requestId)
            for (let i = 0; i < handlers.length; i++) {
              const handler = handlers[i]
              handler.shardSet.delete(handler)
              handler.resume(Effect.void)
            }
          }
          return handlers.length === 1
            ? handlers[0].respond(reply)
            : Effect.forEach(handlers, (handler) => handler.respond(reply))
        })
      }
    })
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeEncoded: (encoded: Encoded) => Effect.Effect<
  MessageStorage["Service"],
  never,
  Snowflake.Generator
> = Effect.fnUntraced(function*(encoded: Encoded) {
  const snowflakeGen = yield* Snowflake.Generator
  const clock = yield* Clock

  const storage: MessageStorage["Service"] = yield* make({
    saveRequest: (message) =>
      Message.serializeEnvelope(message).pipe(
        Effect.flatMap((envelope) =>
          encoded.saveEnvelope({
            envelope,
            primaryKey: Envelope.primaryKey(message.envelope),
            deliverAt: DeliverAt.toMillis(message.envelope.payload)
          })
        ),
        Effect.flatMap((result) => {
          if (result._tag === "Success" || Option.isNone(result.lastReceivedReply)) {
            return Effect.succeed(result as SaveResult<any>)
          }
          const duplicate = result
          const schema = Reply.Reply(message.rpc)
          return Schema.decodeEffect(schema)(result.lastReceivedReply.value).pipe(
            Effect.provideServices(message.services),
            MalformedMessage.refail,
            Effect.map((reply) =>
              SaveResult.Duplicate({
                originalId: duplicate.originalId,
                lastReceivedReply: Option.some(reply)
              })
            )
          )
        })
      ),
    saveEnvelope: (message) =>
      Message.serializeEnvelope(message).pipe(
        Effect.flatMap((envelope) =>
          encoded.saveEnvelope({
            envelope,
            primaryKey: null,
            deliverAt: null
          })
        ),
        Effect.asVoid
      ),
    saveReply: (reply) =>
      Effect.flatMap(
        Reply.serialize(reply),
        encoded.saveReply
      ),
    clearReplies: encoded.clearReplies,
    repliesFor: Effect.fnUntraced(function*(messages) {
      const requestIds = Arr.empty<string>()
      const map = new Map<string, Message.OutgoingRequest<any>>()
      for (const message of messages) {
        const id = String(message.envelope.requestId)
        requestIds.push(id)
        map.set(id, message)
      }
      if (!Arr.isArrayNonEmpty(requestIds)) return []
      const encodedReplies = yield* encoded.repliesFor(requestIds)
      return yield* decodeReplies(map, encodedReplies)
    }),
    repliesForUnfiltered: (ids) => {
      const arr = Array.from(ids, String)
      if (!Arr.isArrayNonEmpty(arr)) return Effect.succeed([])
      return encoded.repliesForUnfiltered(arr)
    },
    requestIdForPrimaryKey(options) {
      const primaryKey = Envelope.primaryKeyByAddress(options)
      return encoded.requestIdForPrimaryKey(primaryKey)
    },
    unprocessedMessages: (shardIds) => {
      const shards = Array.from(shardIds, (id) => id.toString())
      if (!Arr.isArrayNonEmpty(shards)) return Effect.succeed([])
      return Effect.flatMap(
        Effect.suspend(() => encoded.unprocessedMessages(shards, clock.currentTimeMillisUnsafe())),
        decodeMessages
      )
    },
    unprocessedMessagesById(messageIds) {
      const ids = Array.from(messageIds)
      if (!Arr.isArrayNonEmpty(ids)) return Effect.succeed([])
      return Effect.flatMap(
        Effect.suspend(() => encoded.unprocessedMessagesById(ids, clock.currentTimeMillisUnsafe())),
        decodeMessages
      )
    },
    resetAddress: encoded.resetAddress,
    clearAddress: encoded.clearAddress,
    resetShards: (shardIds) => {
      const shards = Array.from(shardIds, (id) => id.toString())
      if (!Arr.isArrayNonEmpty(shards)) return Effect.void
      return encoded.resetShards(shards)
    }
  })

  const decodeMessages = (
    envelopes: Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }>
  ) => {
    const messages: Array<Message.Incoming<any>> = []
    let index = 0

    // if we have a malformed message, we should not return it and update
    // the storage with a defect
    const decodeMessage = Effect.catch(
      Effect.suspend(() => {
        const envelope = envelopes[index]
        if (!envelope) return Effect.undefined
        return decodeEnvelopeWithReply(envelope)
      }),
      (error) => {
        const envelope = envelopes[index]
        return storage.saveReply(Reply.ReplyWithContext.fromDefect({
          id: snowflakeGen.nextUnsafe(),
          requestId: Snowflake.Snowflake(envelope.envelope.requestId),
          defect: error.toString()
        })).pipe(
          Effect.forkDetach,
          Effect.asVoid
        )
      }
    )
    return Effect.as(
      Effect.whileLoop({
        while: () => index < envelopes.length,
        body: () => decodeMessage,
        step: (message) => {
          const envelope = envelopes[index++]
          if (!message) return
          messages.push(
            message.envelope._tag === "Request"
              ? new Message.IncomingRequest({
                envelope: message.envelope,
                lastSentReply: envelope.lastSentReply,
                respond: storage.saveReply
              })
              : new Message.IncomingEnvelope({
                envelope: message.envelope
              })
          )
        }
      }),
      messages
    )
  }

  const decodeReplies = (
    messages: Map<string, Message.OutgoingRequest<any>>,
    encodedReplies: Array<Reply.Encoded>
  ) => {
    const replies: Array<Reply.Reply<any>> = []
    const ignoredRequests = new Set<string>()
    let index = 0

    const decodeReply: Effect.Effect<void | Reply.Reply<any>> = Effect.catch(
      Effect.suspend(() => {
        const reply = encodedReplies[index]
        if (ignoredRequests.has(reply.requestId)) return Effect.void
        const message = messages.get(reply.requestId)
        if (!message) return Effect.void
        const schema = Reply.Reply(message.rpc)
        return Schema.decodeEffect(schema)(reply).pipe(
          Effect.provideServices(message.services)
        ) as Effect.Effect<Reply.Reply<any>, Schema.SchemaError>
      }),
      (error) => {
        const reply = encodedReplies[index]
        ignoredRequests.add(reply.requestId)
        return Effect.succeed(
          new Reply.WithExit({
            id: snowflakeGen.nextUnsafe(),
            requestId: Snowflake.Snowflake(reply.requestId),
            exit: Exit.die(error)
          })
        )
      }
    )

    return Effect.as(
      Effect.whileLoop({
        while: () => index < encodedReplies.length,
        body: () => decodeReply,
        step: (reply) => {
          index++
          if (reply) replies.push(reply)
        }
      }),
      replies
    )
  }

  return storage
})

/**
 * @since 4.0.0
 * @category Constructors
 */
export const noop: MessageStorage["Service"] = Effect.runSync(make({
  saveRequest: () => Effect.succeed(SaveResult.Success()),
  saveEnvelope: () => Effect.void,
  saveReply: () => Effect.void,
  clearReplies: () => Effect.void,
  repliesFor: () => Effect.succeed([]),
  repliesForUnfiltered: () => Effect.succeed([]),
  requestIdForPrimaryKey: () => Effect.succeedNone,
  unprocessedMessages: () => Effect.succeed([]),
  unprocessedMessagesById: () => Effect.succeed([]),
  resetAddress: () => Effect.void,
  clearAddress: () => Effect.void,
  resetShards: () => Effect.void
}))

/**
 * @since 4.0.0
 * @category Memory
 */
export type MemoryEntry = {
  readonly envelope: Envelope.Encoded
  lastReceivedChunk: Reply.ChunkEncoded | undefined
  replies: Array<Reply.Encoded>
  deliverAt: number | null
}

/**
 * @since 4.0.0
 * @category Memory
 */
export class MemoryDriver extends ServiceMap.Service<MemoryDriver>()("effect/cluster/MessageStorage/MemoryDriver", {
  make: Effect.gen(function*() {
    const clock = yield* Clock
    const requests = new Map<string, MemoryEntry>()
    const requestsByPrimaryKey = new Map<string, MemoryEntry>()
    const unprocessed = new Set<Envelope.Encoded>()
    const replyIds = new Set<string>()

    const journal: Array<Envelope.Encoded> = []

    const cursors = new WeakMap<{}, number>()

    const unprocessedWith = (predicate: Predicate<Envelope.Encoded>) => {
      const messages: Array<{
        readonly envelope: Envelope.Encoded
        readonly lastSentReply: Option.Option<Reply.Encoded>
      }> = []
      const now = clock.currentTimeMillisUnsafe()
      for (const envelope of unprocessed) {
        if (!predicate(envelope)) {
          continue
        }
        if (envelope._tag === "Request") {
          const entry = requests.get(envelope.requestId)
          if (entry?.deliverAt && entry.deliverAt > now) {
            continue
          }
          messages.push({
            envelope,
            lastSentReply: Option.fromNullishOr(entry?.replies[entry.replies.length - 1])
          })
        } else {
          messages.push({
            envelope,
            lastSentReply: Option.none()
          })
        }
      }
      return messages
    }

    const replyLatch = yield* Latch.make()

    function repliesFor(requestIds: Array<string>) {
      const replies = Arr.empty<Reply.Encoded>()
      for (const requestId of requestIds) {
        const request = requests.get(requestId)
        if (!request) continue
        else if (request.lastReceivedChunk === undefined) {
          replies.push(...request.replies)
          continue
        }
        const sequence = request.lastReceivedChunk.sequence
        for (const reply of request.replies) {
          if (reply._tag === "Chunk" && reply.sequence <= sequence) {
            continue
          }
          replies.push(reply)
        }
      }
      return replies
    }

    const encoded: Encoded = {
      saveEnvelope: ({ deliverAt, envelope: envelope_, primaryKey }) =>
        Effect.sync(() => {
          const envelope = JSON.parse(JSON.stringify(envelope_)) as Envelope.Encoded
          const existing = primaryKey
            ? requestsByPrimaryKey.get(primaryKey)
            : envelope._tag === "Request" && requests.get(envelope.requestId)
          if (existing) {
            return SaveResultEncoded.Duplicate({
              originalId: Snowflake.Snowflake(existing.envelope.requestId),
              lastReceivedReply: Option.fromNullishOr(
                existing.replies.length === 1 && existing.replies[0]._tag === "WithExit"
                  ? existing.replies[0]
                  : existing.lastReceivedChunk
              )
            })
          }
          if (envelope._tag === "Request") {
            const entry: MemoryEntry = { envelope, replies: [], lastReceivedChunk: undefined, deliverAt }
            requests.set(envelope.requestId, entry)
            if (primaryKey) {
              requestsByPrimaryKey.set(primaryKey, entry)
            }
          } else if (envelope._tag === "AckChunk") {
            const entry = requests.get(envelope.requestId)
            if (entry) {
              entry.lastReceivedChunk = entry.replies.find((r): r is Reply.ChunkEncoded =>
                r._tag === "Chunk" && r.id === envelope.replyId
              ) ?? entry.lastReceivedChunk
            }
          }
          unprocessed.add(envelope)
          journal.push(envelope)
          return SaveResultEncoded.Success()
        }),
      saveReply: (reply_) =>
        Effect.sync(() => {
          const reply = JSON.parse(JSON.stringify(reply_)) as Reply.Encoded
          const entry = requests.get(reply.requestId)
          if (!entry || replyIds.has(reply.id)) return
          if (reply._tag === "WithExit") {
            unprocessed.delete(entry.envelope)
          }
          entry.replies.push(reply)
          replyIds.add(reply.id)
          replyLatch.openUnsafe()
        }),
      clearReplies: (id) =>
        Effect.sync(() => {
          const entry = requests.get(String(id))
          if (!entry) return
          entry.replies = []
          entry.lastReceivedChunk = undefined
          unprocessed.add(entry.envelope)
        }),
      requestIdForPrimaryKey: (primaryKey) =>
        Effect.sync(() => {
          const entry = requestsByPrimaryKey.get(primaryKey)
          return Option.map(Option.fromNullishOr(entry?.envelope.requestId), Snowflake.Snowflake)
        }),
      repliesFor: (requestIds) => Effect.sync(() => repliesFor(requestIds)),
      repliesForUnfiltered: (requestIds) =>
        Effect.sync(() => requestIds.flatMap((id) => requests.get(String(id))?.replies ?? [])),
      unprocessedMessages: (shardIds) =>
        Effect.sync(() => {
          if (unprocessed.size === 0) return []
          const now = clock.currentTimeMillisUnsafe()
          const messages = Arr.empty<{
            envelope: Envelope.Encoded
            lastSentReply: Option.Option<Reply.Encoded>
          }>()
          for (let index = 0; index < journal.length; index++) {
            const envelope = journal[index]
            const shardId = ShardId.makeUnsafe(envelope.address.shardId)
            if (!unprocessed.has(envelope as any) || !shardIds.includes(shardId.toString())) {
              continue
            }
            if (envelope._tag === "Request") {
              const entry = requests.get(envelope.requestId)!
              if (entry.deliverAt && entry.deliverAt > now) {
                continue
              }
              messages.push({
                envelope,
                lastSentReply: Option.fromNullishOr(entry.replies[entry.replies.length - 1])
              })
            } else {
              messages.push({
                envelope,
                lastSentReply: Option.none()
              })
              unprocessed.delete(envelope)
            }
          }
          return messages
        }),
      unprocessedMessagesById: (ids) =>
        Effect.sync(() => {
          const envelopeIds = new Set<string>()
          for (const id of ids) {
            envelopeIds.add(String(id))
          }
          return unprocessedWith((envelope) => envelopeIds.has(envelope.requestId))
        }),
      resetAddress: () => Effect.void,
      clearAddress: (address) =>
        Effect.sync(() => {
          for (let i = journal.length - 1; i >= 0; i--) {
            const envelope = journal[i]
            const sameAddress = address.entityType === envelope.address.entityType &&
              address.entityId === envelope.address.entityId
            if (!sameAddress || envelope._tag !== "Request") {
              continue
            }
            unprocessed.delete(envelope)
            requests.delete(envelope.requestId)
            journal.splice(i, 1)
          }
        }),
      resetShards: () => Effect.void
    }

    const storage = yield* makeEncoded(encoded)

    return {
      storage,
      encoded,
      requests,
      requestsByPrimaryKey,
      unprocessed,
      replyIds,
      journal,
      cursors
    } as const
  })
}) {
  /**
   * @since 4.0.0
   */
  static readonly layer: Layer.Layer<MemoryDriver> = Layer.effect(this)(this.make).pipe(
    Layer.provide(Snowflake.layerGenerator)
  )
}

/**
 * @since 4.0.0
 * @category layers
 */
export const layerNoop: Layer.Layer<MessageStorage> = Layer.succeed(MessageStorage, noop)

/**
 * @since 4.0.0
 * @category layers
 */
export const layerMemory: Layer.Layer<
  MessageStorage | MemoryDriver,
  never,
  ShardingConfig
> = Layer.effect(MessageStorage, Effect.map(MemoryDriver.asEffect(), (_) => _.storage)).pipe(
  Layer.provideMerge(MemoryDriver.layer)
)

// --- internal ---

const EnvelopeWithReply: Schema.Struct<
  {
    readonly envelope: Schema.Decoder<Envelope.PartialRequest | Envelope.AckChunk | Envelope.Interrupt>
    readonly lastSentReply: Schema.Option<Schema.Codec<Reply.Encoded>>
  }
> = Schema.Struct({
  envelope: Schema.toCodecJson(Envelope.Partial),
  lastSentReply: Schema.Option(Reply.Encoded)
})

const decodeEnvelopeWithReply = Schema.decodeEffect(EnvelopeWithReply)

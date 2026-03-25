/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import type { ServiceMap } from "../../ServiceMap.ts"
import * as Rpc from "../rpc/Rpc.ts"
import type { PersistenceError } from "./ClusterError.ts"
import { MalformedMessage } from "./ClusterError.ts"
import type { EntityAddress } from "./EntityAddress.ts"
import * as Envelope from "./Envelope.ts"
import type * as Reply from "./Reply.ts"
import type { Snowflake } from "./Snowflake.ts"

/**
 * @since 4.0.0
 * @category incoming
 */
export type Incoming<R extends Rpc.Any> = IncomingRequest<R> | IncomingEnvelope

/**
 * @since 4.0.0
 * @category incoming
 */
export type IncomingLocal<R extends Rpc.Any> = IncomingRequestLocal<R> | IncomingEnvelope

/**
 * @since 4.0.0
 * @category incoming
 */
export const incomingLocalFromOutgoing = <R extends Rpc.Any>(self: Outgoing<R>): IncomingLocal<R> => {
  if (self._tag === "OutgoingEnvelope") {
    return new IncomingEnvelope({ envelope: self.envelope })
  }
  return new IncomingRequestLocal({
    envelope: self.envelope,
    respond: self.respond,
    lastSentReply: Option.none()
  })
}

/**
 * @since 4.0.0
 * @category incoming
 */
export class IncomingRequest<R extends Rpc.Any> extends Data.TaggedClass("IncomingRequest")<{
  readonly envelope: Envelope.PartialRequest
  readonly lastSentReply: Option.Option<Reply.Encoded>
  readonly respond: (reply: Reply.ReplyWithContext<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>
}> {}

/**
 * @since 4.0.0
 * @category outgoing
 */
export class IncomingRequestLocal<R extends Rpc.Any> extends Data.TaggedClass("IncomingRequestLocal")<{
  readonly envelope: Envelope.Request<R>
  readonly lastSentReply: Option.Option<Reply.Reply<R>>
  readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>
}> {}

/**
 * @since 4.0.0
 * @category incoming
 */
export class IncomingEnvelope extends Data.TaggedClass("IncomingEnvelope")<{
  readonly _tag: "IncomingEnvelope"
  readonly envelope: Envelope.AckChunk | Envelope.Interrupt
}> {}

/**
 * @since 4.0.0
 * @category outgoing
 */
export type Outgoing<R extends Rpc.Any> = OutgoingRequest<R> | OutgoingEnvelope

/**
 * @since 4.0.0
 * @category outgoing
 */
export class OutgoingRequest<R extends Rpc.Any> extends Data.TaggedClass("OutgoingRequest")<{
  readonly envelope: Envelope.Request<R>
  readonly services: ServiceMap<Rpc.Services<R>>
  readonly lastReceivedReply: Option.Option<Reply.Reply<R>>
  readonly rpc: R
  readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void>
}> {
  /**
   * @since 4.0.0
   */
  public encodedCache?: Envelope.PartialRequest
}

/**
 * @since 4.0.0
 * @category outgoing
 */
export class OutgoingEnvelope extends Data.TaggedClass("OutgoingEnvelope")<{
  readonly envelope: Envelope.AckChunk | Envelope.Interrupt
  readonly rpc: Rpc.AnyWithProps
}> {
  /**
   * @since 4.0.0
   */
  static interrupt(options: {
    readonly address: EntityAddress
    readonly id: Snowflake
    readonly requestId: Snowflake
  }): OutgoingEnvelope {
    return new OutgoingEnvelope({
      envelope: new Envelope.Interrupt(options),
      rpc: neverRpc
    })
  }
}

const neverRpc = Rpc.make("Never", {
  success: Schema.Never as any,
  error: Schema.Never,
  payload: {}
})

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const serialize = <Rpc extends Rpc.Any>(
  message: Outgoing<Rpc>
): Effect.Effect<Envelope.Partial, MalformedMessage> => {
  if (message._tag !== "OutgoingRequest") {
    return Effect.succeed(message.envelope)
  }
  return Effect.suspend(() =>
    message.encodedCache
      ? Effect.succeed(message.encodedCache)
      : serializeRequest(message)
  )
}

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const serializeEnvelope = <Rpc extends Rpc.Any>(
  message: Outgoing<Rpc>
): Effect.Effect<Envelope.Encoded, MalformedMessage, never> =>
  Effect.flatMap(
    serialize(message),
    (envelope) => MalformedMessage.refail(Schema.encodeEffect(Envelope.PartialJson)(envelope))
  )

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const serializeRequest = <Rpc extends Rpc.Any>(
  self: OutgoingRequest<Rpc>
): Effect.Effect<Envelope.PartialRequest, MalformedMessage> => {
  const rpc = self.rpc as any as Rpc.AnyWithProps
  return Schema.encodeEffect(Schema.toCodecJson(rpc.payloadSchema))(self.envelope.payload).pipe(
    Effect.provideServices(self.services),
    MalformedMessage.refail,
    Effect.map((payload) => ({
      ...self.envelope,
      payload
    }))
  ) as any as Effect.Effect<Envelope.PartialRequest, MalformedMessage>
}

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const deserializeLocal = <Rpc extends Rpc.Any>(
  self: Outgoing<Rpc>,
  encoded: Envelope.Partial
): Effect.Effect<
  IncomingLocal<Rpc>,
  MalformedMessage
> => {
  if (encoded._tag !== "Request") {
    return Effect.succeed(new IncomingEnvelope({ envelope: encoded }))
  } else if (self._tag !== "OutgoingRequest") {
    return Effect.fail(
      new MalformedMessage({ cause: new Error("Can only deserialize a Request with an OutgoingRequest message") })
    )
  }
  const rpc = self.rpc as any as Rpc.AnyWithProps
  return Schema.decodeEffect(Schema.toCodecJson(rpc.payloadSchema))(encoded.payload).pipe(
    Effect.provideServices(self.services),
    MalformedMessage.refail,
    Effect.map((payload) =>
      new IncomingRequestLocal({
        envelope: Envelope.makeRequest({
          ...encoded,
          payload
        } as any),
        lastSentReply: Option.none(),
        respond: self.respond
      })
    )
  ) as Effect.Effect<IncomingRequestLocal<Rpc>, MalformedMessage>
}

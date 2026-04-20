/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type { Branded } from "../../Brand.ts"
import * as Schema from "../../Schema.ts"
import type { Headers } from "../http/Headers.ts"
import type * as Rpc from "./Rpc.ts"
import type { RpcClientError } from "./RpcClientError.ts"

/**
 * @since 4.0.0
 * @category request
 */
export type FromClient<A extends Rpc.Any> = Request<A> | Ack | Interrupt | Eof

/**
 * @since 4.0.0
 * @category request
 */
export type FromClientEncoded = RequestEncoded | AckEncoded | InterruptEncoded | Ping | Eof

/**
 * @since 4.0.0
 * @category request
 */
export type RequestId = Branded<bigint, "~effect/rpc/RpcMessage/RequestId">

/**
 * @since 4.0.0
 * @category request
 */
export const RequestId = (id: bigint | string): RequestId =>
  typeof id === "bigint" ? id as RequestId : BigInt(id) as RequestId

/**
 * @since 4.0.0
 * @category request
 */
export interface RequestEncoded {
  readonly _tag: "Request"
  readonly id: string
  readonly tag: string
  readonly payload: unknown
  readonly headers: ReadonlyArray<[string, string]>
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * @since 4.0.0
 * @category request
 */
export interface Request<A extends Rpc.Any> {
  readonly _tag: "Request"
  readonly id: RequestId
  readonly tag: Rpc.Tag<A>
  readonly payload: Rpc.Payload<A>
  readonly headers: Headers
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * @since 4.0.0
 * @category request
 */
export interface Ack {
  readonly _tag: "Ack"
  readonly requestId: RequestId
}

/**
 * @since 4.0.0
 * @category request
 */
export interface Interrupt {
  readonly _tag: "Interrupt"
  readonly requestId: RequestId
  readonly interruptors: ReadonlyArray<number>
}

/**
 * @since 4.0.0
 * @category request
 */
export interface AckEncoded {
  readonly _tag: "Ack"
  readonly requestId: string
}

/**
 * @since 4.0.0
 * @category request
 */
export interface InterruptEncoded {
  readonly _tag: "Interrupt"
  readonly requestId: string
}

/**
 * @since 4.0.0
 * @category request
 */
export interface Eof {
  readonly _tag: "Eof"
}

/**
 * @since 4.0.0
 * @category request
 */
export interface Ping {
  readonly _tag: "Ping"
}

/**
 * @since 4.0.0
 * @category request
 */
export const constEof: Eof = { _tag: "Eof" }

/**
 * @since 4.0.0
 * @category request
 */
export const constPing: Ping = { _tag: "Ping" }

/**
 * @since 4.0.0
 * @category response
 */
export type FromServer<A extends Rpc.Any> =
  | ResponseChunk<A>
  | ResponseExit<A>
  | ResponseDefect
  | ClientEnd

/**
 * @since 4.0.0
 * @category response
 */
export type FromServerEncoded =
  | ResponseChunkEncoded
  | ResponseExitEncoded
  | ResponseDefectEncoded
  | Pong
  | ClientProtocolError

/**
 * @since 4.0.0
 * @category response
 */
export const ResponseIdTypeId = "~effect//rpc/RpcServer/ResponseId"

/**
 * @since 4.0.0
 * @category response
 */
export type ResponseIdTypeId = typeof ResponseIdTypeId

/**
 * @since 4.0.0
 * @category response
 */
export type ResponseId = Branded<number, ResponseIdTypeId>

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseChunkEncoded {
  readonly _tag: "Chunk"
  readonly requestId: string
  readonly values: NonEmptyReadonlyArray<unknown>
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseChunk<A extends Rpc.Any> {
  readonly _tag: "Chunk"
  readonly clientId: number
  readonly requestId: RequestId
  readonly values: NonEmptyReadonlyArray<Rpc.SuccessChunk<A>>
}

/**
 * @since 4.0.0
 * @category response
 */
export type ExitEncoded<A, E> = {
  readonly _tag: "Success"
  readonly value: A
} | {
  readonly _tag: "Failure"
  readonly cause: ReadonlyArray<
    {
      readonly _tag: "Fail"
      readonly error: E
    } | {
      readonly _tag: "Die"
      readonly defect: unknown
    } | {
      readonly _tag: "Interrupt"
      readonly fiberId: number | undefined
    }
  >
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseExitEncoded {
  readonly _tag: "Exit"
  readonly requestId: string
  readonly exit: ExitEncoded<unknown, unknown>
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ClientProtocolError {
  readonly _tag: "ClientProtocolError"
  readonly error: RpcClientError
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseExit<A extends Rpc.Any> {
  readonly _tag: "Exit"
  readonly clientId: number
  readonly requestId: RequestId
  readonly exit: Rpc.Exit<A>
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseDefectEncoded {
  readonly _tag: "Defect"
  readonly defect: unknown
}

const encodeDefect = Schema.encodeSync(Schema.Defect)

/**
 * @since 4.0.0
 * @category response
 */
export const ResponseExitDieEncoded = (options: {
  readonly requestId: RequestId
  readonly defect: unknown
}): ResponseExitEncoded => ({
  _tag: "Exit",
  requestId: options.requestId.toString(),
  exit: {
    _tag: "Failure",
    cause: [{
      _tag: "Die",
      defect: encodeDefect(options.defect)
    }]
  }
})

/**
 * @since 4.0.0
 * @category response
 */
export const ResponseDefectEncoded = (input: unknown): ResponseDefectEncoded => ({
  _tag: "Defect",
  defect: encodeDefect(input)
})

/**
 * @since 4.0.0
 * @category response
 */
export interface ResponseDefect {
  readonly _tag: "Defect"
  readonly clientId: number
  readonly defect: unknown
}

/**
 * @since 4.0.0
 * @category response
 */
export interface ClientEnd {
  readonly _tag: "ClientEnd"
  readonly clientId: number
}

/**
 * @since 4.0.0
 * @category response
 */
export interface Pong {
  readonly _tag: "Pong"
}

/**
 * @since 4.0.0
 * @category response
 */
export const constPong: Pong = { _tag: "Pong" }

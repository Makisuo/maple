/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Queue from "../../Queue.ts"
import * as Schema from "../../Schema.ts"
import * as Stream from "../../Stream.ts"
import * as Ndjson from "../encoding/Ndjson.ts"
import * as Socket from "../socket/Socket.ts"
import * as SocketServer from "../socket/SocketServer.ts"
import * as DevToolsSchema from "./DevToolsSchema.ts"

const RequestSchema = Schema.toCodecJson(DevToolsSchema.Request)
const ResponseSchema = Schema.toCodecJson(DevToolsSchema.Response)

/**
 * @since 4.0.0
 * @category models
 */
export interface Client {
  readonly queue: Queue.Dequeue<DevToolsSchema.Request.WithoutPing>
  readonly send: (_: DevToolsSchema.Response.WithoutPong) => Effect.Effect<void>
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const run: <_, E, R>(
  handle: (client: Client) => Effect.Effect<_, E, R>
) => Effect.Effect<
  never,
  SocketServer.SocketServerError,
  R | SocketServer.SocketServer
> = Effect.fnUntraced(function*<R, E, _>(
  handle: (client: Client) => Effect.Effect<_, E, R>
) {
  const server = yield* SocketServer.SocketServer

  return yield* server.run(Effect.fnUntraced(function*(socket) {
    const responses = yield* Queue.unbounded<DevToolsSchema.Response>()
    const requests = yield* Queue.unbounded<DevToolsSchema.Request.WithoutPing>()

    const client: Client = {
      queue: requests,
      send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid)
    }

    yield* Stream.fromQueue(responses).pipe(
      Stream.pipeThroughChannel(
        Ndjson.duplexSchemaString(Socket.toChannelString(socket), {
          inputSchema: ResponseSchema,
          outputSchema: RequestSchema
        })
      ),
      Stream.runForEach((request) =>
        request._tag === "Ping"
          ? Queue.offer(responses, { _tag: "Pong" })
          : Queue.offer(requests, request)
      ),
      Effect.ensuring(
        Queue.shutdown(responses).pipe(
          Effect.andThen(Queue.shutdown(requests))
        )
      ),
      Effect.forkChild
    )

    return yield* handle(client)
  }))
})

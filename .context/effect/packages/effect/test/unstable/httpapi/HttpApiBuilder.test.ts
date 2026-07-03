import { assert, it } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  HttpApiTest
} from "effect/unstable/httpapi"

const textDecoder = new TextDecoder()

const StreamError = Schema.Struct({ reason: Schema.String })

const TestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

it.layer(TestServices)("HttpApiBuilder streaming success responses", (it) => {
  it.effect("emits StreamUint8Array handler responses as streamed bytes with the declared content type", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("download", "/test", {
            success: HttpApiSchema.status(206)(
              HttpApiSchema.StreamUint8Array({ contentType: "application/custom-bytes" })
            )
          })
        )
      )

      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("download", () =>
            Effect.succeed(
              Stream.make(new Uint8Array([1, 2]), new Uint8Array([3]))
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const response = yield* client.test.download({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 206)
      assert.strictEqual(response.headers["content-type"], "application/custom-bytes")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => Array.from(chunk)), [[1, 2], [3]])
    }))

  it.effect("renders successful StreamSse events incrementally with the declared content type", () =>
    Effect.gen(function*() {
      const Events = Schema.Struct({
        event: Schema.String,
        data: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("events", "/test", {
            success: HttpApiSchema.status(202)(
              HttpApiSchema.StreamSse({
                contentType: "text/event-stream; charset=utf-8",
                events: Events,
                error: StreamError
              })
            )
          })
        )
      )
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(Stream.make(
              { event: "first" as const, data: "one" },
              { event: "second" as const, data: "two" }
            )))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 202)
      assert.strictEqual(response.headers["content-type"], "text/event-stream; charset=utf-8")
      assert.deepStrictEqual(
        Array.from(chunks, (chunk) => textDecoder.decode(chunk)),
        ["event: first\ndata: one\n\n", "event: second\ndata: two\n\n"]
      )
    }))

  it.effect("renders StreamSse failures as one reserved event containing an encoded full cause", () =>
    Effect.gen(function*() {
      const Events = Schema.Struct({
        event: Schema.Literal("message"),
        data: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("events", "/test", {
            success: HttpApiSchema.StreamSse({ events: Events, error: StreamError })
          })
        )
      )

      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(
              Stream.fail({ reason: "boom" })
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)
      const rendered = Array.from(chunks, (chunk) => textDecoder.decode(chunk))

      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      assert.strictEqual(rendered.length, 1)
      assert.isTrue(rendered[0]!.startsWith("event: effect/httpapi/stream/failure\ndata: "))
      assert.isTrue(rendered[0]!.endsWith("\n\n"))

      const data = rendered[0]!.split("\n")[1]!.slice("data: ".length)
      const FailureSchema = Schema.toCodecJson(Schema.Cause(StreamError, Schema.Defect()))
      const cause = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FailureSchema))(data)
      assert.deepStrictEqual(cause, Cause.fail({ reason: "boom" }))
    }))

  it.effect("supports buffered and stream successes with the same status", () =>
    Effect.gen(function*() {
      const Buffered = Schema.Struct({ message: Schema.String })
      const EventData = Schema.Struct({
        text: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("chat", "/test", {
            query: {
              stream: Schema.String
            },
            success: [
              Buffered,
              HttpApiSchema.StreamSse({ data: EventData, error: StreamError })
            ]
          })
        )
      )

      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("chat", ({ query }) =>
            Effect.succeed(
              query.stream === "true" ?
                Stream.make({ text: "hello" }) :
                { message: "done" }
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const bufferedResponse = yield* client.test.chat({ query: { stream: "false" }, responseMode: "response-only" })
      assert.strictEqual(bufferedResponse.status, 200)
      assert.strictEqual(bufferedResponse.headers["content-type"], "application/json")

      const streamResponse = yield* client.test.chat({ query: { stream: "true" }, responseMode: "response-only" })
      const chunks = yield* Stream.runCollect(streamResponse.stream)

      assert.strictEqual(streamResponse.status, 200)
      assert.strictEqual(streamResponse.headers["content-type"], "text/event-stream")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => textDecoder.decode(chunk)), [
        `data: {"text":"hello"}\n\n`
      ])
    }))

  it.effect("does not try another security scheme after the handler fails", () =>
    Effect.gen(function*() {
      class HandlerFailure extends Schema.TaggedErrorClass<HandlerFailure>()("HandlerFailure", {
        message: Schema.String
      }, { httpApiStatus: 418 }) {}

      class M extends HttpApiMiddleware.Service<M>()("Security/HandlerFailure", {
        error: Schema.String.pipe(
          HttpApiSchema.status(401),
          HttpApiSchema.asText()
        ),
        security: {
          first: HttpApiSecurity.apiKey({
            in: "header",
            key: "x-first"
          }),
          second: HttpApiSecurity.apiKey({
            in: "header",
            key: "x-second"
          })
        }
      }) {}

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("protected", "/protected", {
            headers: {
              "x-first": Schema.String
            },
            success: Schema.String,
            error: HandlerFailure
          }).middleware(M)
        )
      )
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("protected", () => Effect.fail(new HandlerFailure({ message: "handler failed" })))
      )
      const MLive = Layer.succeed(M)({
        first: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("first unauthorized"),
        second: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("second unauthorized")
      })

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(
        Effect.provide(GroupLive),
        Effect.provide(MLive)
      )
      const error = yield* Effect.flip(client.test.protected({ headers: { "x-first": "ok" } }))

      assert.deepStrictEqual(error, new HandlerFailure({ message: "handler failed" }))
    }))
})

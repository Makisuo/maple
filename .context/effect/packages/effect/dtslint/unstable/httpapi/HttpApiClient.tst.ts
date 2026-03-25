/** @effect-diagnostics missingEffectContext:skip-file */
import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, type HttpClientResponse } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  type HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

type ResponseMode = HttpApiEndpoint.ClientResponseMode

describe("HttpApiClient", () => {
  describe("path option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                params: {
                  id: Schema.Finite
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly params: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("query option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                query: {
                  id: Schema.Finite
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly query: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("urlBuilder", () => {
    it("should mirror client shape and use schema input types", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("users")
            .add(
              HttpApiEndpoint.get("getUser", "/users/:id", {
                disableCodecs: true,
                params: {
                  id: Schema.FiniteFromString
                },
                query: {
                  page: Schema.FiniteFromString
                }
              }),
              HttpApiEndpoint.get("health", "/health", {
                disableCodecs: true
              })
            )
        )

      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      const getUserUrl = builder.users.getUser({
        params: { id: 123 },
        query: { page: 1 }
      })

      expect<typeof getUserUrl>().type.toBe<string>()

      const healthUrl = builder.users.health()

      expect<typeof healthUrl>().type.toBe<string>()

      // @ts-expect-error!
      builder.users.getUser({ params: { id: "123" }, query: { page: 1 } })

      // @ts-expect-error!
      builder.users.getUser({ params: { id: 123 }, query: { page: "1" } })

      // @ts-expect-error!
      builder.users.missing()
    })

    it("should support prefixes and top-level endpoints", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("users")
            .add(
              HttpApiEndpoint.get("getUser", "/users/:id", {
                disableCodecs: true,
                params: {
                  id: Schema.FiniteFromString
                }
              }),
              HttpApiEndpoint.get("health", "/health")
            )
        )
        .add(
          HttpApiGroup.make("top", { topLevel: true })
            .add(
              HttpApiEndpoint.get("topHealth", "/top-health")
            )
        )
        .prefix("/v1")

      const builder = HttpApiClient.urlBuilder(Api)

      const prefixedUrl = builder.users.getUser({
        params: { id: 123 }
      })

      expect<typeof prefixedUrl>().type.toBe<string>()

      const topLevelUrl = builder.topHealth()

      expect<typeof topLevelUrl>().type.toBe<string>()

      // @ts-expect-error!
      builder.users.getUser({ params: { id: "123" } })

      // @ts-expect-error!
      builder.top.topHealth()
    })
  })

  describe("headers option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                headers: {
                  id: Schema.FiniteFromString
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly headers: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("payload option", () => {
    it("should default to void", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a")
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<void | { readonly responseMode?: ResponseMode } | undefined>()
    })

    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                payload: {
                  id: Schema.FiniteFromString
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })

    it("should accept a multipart", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.post("a", "/a", {
                payload: Schema.String.pipe(HttpApiSchema.asMultipart())
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: FormData; readonly responseMode?: ResponseMode }
      >()
    })

    it("should accept a multipart stream", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.post("a", "/a", {
                payload: Schema.String.pipe(HttpApiSchema.asMultipartStream())
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: FormData; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("success option", () => {
    it("should accept a schema", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<ReturnType<typeof f>>().type.toBe<
        Effect.Effect<
          { readonly a: number },
          HttpApiError.BadRequest | HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()
    })

    it("should accept an array of schemas", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: [
                  Schema.Struct({ a: Schema.Finite }), // application/json
                  Schema.String.pipe(HttpApiSchema.asText()), // text/plain
                  Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
                ]
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<ReturnType<typeof f>>().type.toBe<
        Effect.Effect<
          | string
          | { readonly a: number }
          | Uint8Array<ArrayBufferLike>,
          HttpApiError.BadRequest | HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()
    })

    it("should infer return type from responseMode", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a

      const decodedOnly = f({ responseMode: "decoded-only" })
      expect<typeof decodedOnly>().type.toBe<
        Effect.Effect<
          { readonly a: number },
          HttpApiError.BadRequest | HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()

      const decodedAndResponse = f({ responseMode: "decoded-and-response" })
      expect<typeof decodedAndResponse>().type.toBe<
        Effect.Effect<
          [{ readonly a: number }, HttpClientResponse.HttpClientResponse],
          HttpApiError.BadRequest | HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()

      const responseOnly = f({ responseMode: "response-only" })
      expect<typeof responseOnly>().type.toBe<
        Effect.Effect<HttpClientResponse.HttpClientResponse, HttpApiError.BadRequest | HttpClientError.HttpClientError>
      >()
    })
  })

  describe("error option", () => {
    it("should default to BadRequest", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a")
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<ReturnType<typeof f>>().type.toBe<
        Effect.Effect<
          void,
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })

    it("should accept a schema", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                error: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<ReturnType<typeof f>>().type.toBe<
        Effect.Effect<
          void,
          | { readonly a: number }
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })
  })

  describe("client middleware", () => {
    it("requiredForClient requires layer and includes required client errors", () => {
      class RequiredClientError extends Schema.ErrorClass<RequiredClientError>("RequiredClientError")({
        _tag: Schema.tag("RequiredClientError")
      }) {}

      class OptionalClientError extends Schema.ErrorClass<OptionalClientError>("OptionalClientError")({
        _tag: Schema.tag("OptionalClientError")
      }) {}

      class RequiredMiddleware extends HttpApiMiddleware.Service<RequiredMiddleware, {
        clientError: RequiredClientError
      }>()("RequiredMiddleware", {
        requiredForClient: true
      }) {}

      class OptionalMiddleware extends HttpApiMiddleware.Service<OptionalMiddleware, {
        clientError: OptionalClientError
      }>()("OptionalMiddleware") {}

      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.String
              })
                .middleware(RequiredMiddleware)
                .middleware(OptionalMiddleware)
            )
        )

      // @ts-expect-error!
      Effect.runSync(HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer)))

      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(
          Effect.provide([
            FetchHttpClient.layer,
            HttpApiMiddleware.layerClient(RequiredMiddleware, ({ next, request }) => next(request))
          ])
        )
      )
      const f = client.group.a
      expect<ReturnType<typeof f>>().type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })

    it("requiredForClient is enforced for makeWith, group, and endpoint", () => {
      class RequiredClientError extends Schema.ErrorClass<RequiredClientError>("RequiredClientError")({
        _tag: Schema.tag("RequiredClientError")
      }) {}

      class RequiredMiddleware extends HttpApiMiddleware.Service<RequiredMiddleware, {
        clientError: RequiredClientError
      }>()("RequiredMiddleware", {
        requiredForClient: true
      }) {}

      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.String
              })
                .middleware(RequiredMiddleware)
            )
        )

      const TestHttpClient = HttpClient.make(() => Effect.die("not used in dtslint"))

      // @ts-expect-error!
      Effect.runSync(HttpApiClient.makeWith(Api, { httpClient: TestHttpClient }))

      // @ts-expect-error!
      Effect.runSync(HttpApiClient.group(Api, { group: "group", httpClient: TestHttpClient }))

      // @ts-expect-error!
      Effect.runSync(HttpApiClient.endpoint(Api, { group: "group", endpoint: "a", httpClient: TestHttpClient }))

      const middlewareLayer = HttpApiMiddleware.layerClient(
        RequiredMiddleware,
        ({ next, request }) => next(request)
      )

      const withClient = Effect.runSync(
        HttpApiClient.makeWith(Api, { httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )
      const fromClient = withClient.group.a

      const withGroup = Effect.runSync(
        HttpApiClient.group(Api, { group: "group", httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )
      const fromGroup = withGroup.a

      const fromEndpoint = Effect.runSync(
        HttpApiClient.endpoint(Api, { group: "group", endpoint: "a", httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )

      expect<ReturnType<typeof fromClient>>().type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()

      expect<ReturnType<typeof fromGroup>>().type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()

      expect<ReturnType<typeof fromEndpoint>>().type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpApiError.BadRequest
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })
  })
})

# AI Response HTTP Request / Response Details

## Overview

Add HTTP request and response details to the Effect AI SDK response protocol. Currently, HTTP context (request details, response status/headers) is only captured in the error path via `AiError`. This change surfaces that same information in the success path through the AI `Response` protocol, enabling consumers to inspect HTTP metadata (headers, status codes, request URLs) for successful AI requests.

## Goals

- Move `HttpRequestDetails` and `HttpResponseDetails` schemas from `AiError` to `Response`, making them part of the core response protocol.
- Add HTTP request details to `Response.ResponseMetadataPart`.
- Add HTTP response details to `Response.FinishPart`.
- Thread `includeResponse: true` through provider client methods so the `HttpClientResponse` object is available in the success path.
- Update `AiError` to import the schemas from `Response` instead of defining them locally.

## Non-Goals

- Changing how HTTP details are captured in the error path (existing `AiError` error handling remains unchanged).
- Adding response body capture to the success path (the body is already decoded into typed responses).
- Changing the `HttpClient` or `HttpClientResponse` abstractions.
- Adding timing/latency information (can be done separately).

## Current State

### HTTP Details Schemas (in `AiError`)

`HttpRequestDetails` and `HttpResponseDetails` are defined in `packages/effect/src/unstable/ai/AiError.ts`:

```ts
// AiError.ts lines 130-142
export const HttpRequestDetails = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]),
  url: Schema.String,
  urlParams: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  hash: Schema.UndefinedOr(Schema.String),
  headers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Redacted(Schema.String)]))
})

// AiError.ts lines 288-297
export const HttpResponseDetails = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Redacted(Schema.String)]))
})
```

These are currently only used in error reason classes (e.g., `NetworkError`, `RateLimitError`, `InvalidRequestError`) via the `HttpContext` schema.

### Response Parts (in `Response`)

`ResponseMetadataPart` (`Response.ts:2115-2128`) contains `id`, `modelId`, `timestamp`, and extensible `metadata`. It is emitted at the start of every response (both streaming and non-streaming).

`FinishPart` (`Response.ts:2313-2322`) contains `reason`, `usage`, and extensible `metadata`. It is emitted at the end of every response.

Neither part currently carries HTTP request/response information.

### Provider Client Methods

**OpenAI** (`OpenAiClient.ts:173-198`):

- `createResponse(payload)` calls `client.createResponse({ payload })` — returns only the decoded body.
- `createResponseStream(payload)` calls `client.createResponseSse({ payload })` — returns an SSE stream, discarding the `HttpClientResponse` at line 25578 of `Generated.ts`.

**Anthropic** (`AnthropicClient.ts:263-318`):

- `createMessage(options)` calls `client.betaMessagesPost(options)` — returns only the decoded body.
- `createMessageStream(options)` constructs an HTTP request manually and pipes through `streamRequest(SseEvent)(request)` — discards the `HttpClientResponse` at line 252 of `AnthropicClient.ts`.

### `includeResponse` Support in Generated Clients

Both `Generated.ts` files define an `OperationConfig` with `includeResponse?: boolean` and a `WithOptionalResponse` type. The `withResponse` helper in `Generated.ts` already supports returning `[decodedBody, HttpClientResponse]` when `includeResponse: true`. However, this is only wired up for non-streaming operations — the `sseRequest` function does not accept a config parameter.

### Error Path HTTP Context Builders

Both providers have identical `buildHttpRequestDetails` and `buildHttpContext` helpers in their respective `internal/errors.ts` files. These extract method, URL, params, hash, and redacted headers from `HttpClientRequest`, and status + redacted headers from `HttpClientResponse`.

## Proposed Design

### Step 1: Move HTTP Details Schemas to `Response`

Move `HttpRequestDetails` and `HttpResponseDetails` from `AiError.ts` to `Response.ts`.

In `Response.ts`, add:

```ts
export const HttpRequestDetails = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]),
  url: Schema.String,
  urlParams: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  hash: Schema.UndefinedOr(Schema.String),
  headers: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Redacted(Schema.String)])
  )
}).annotate({ identifier: "HttpRequestDetails" })

export const HttpResponseDetails = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Redacted(Schema.String)])
  )
}).annotate({ identifier: "HttpResponseDetails" })
```

In `AiError.ts`, remove the `HttpRequestDetails` and `HttpResponseDetails` schema definitions and import them from `Response` instead. Update all references within `AiError.ts` (e.g., `HttpContext`, `NetworkError`) to use the imported schemas.

### Step 2: Add `request` Field to `ResponseMetadataPart`

Add an optional `request` field to `ResponseMetadataPart`:

```ts
export interface ResponseMetadataPart extends BasePart<"response-metadata", ResponseMetadataPartMetadata> {
  readonly id: string | undefined
  readonly modelId: string | undefined
  readonly timestamp: DateTime.Utc | undefined
  readonly request: typeof HttpRequestDetails.Type | undefined // NEW
}
```

Update the schema accordingly:

```ts
export const ResponseMetadataPart = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("response-metadata"),
  id: Schema.UndefinedOr(Schema.String),
  modelId: Schema.UndefinedOr(Schema.String),
  timestamp: Schema.UndefinedOr(Schema.DateTimeUtcFromString),
  request: Schema.UndefinedOr(HttpRequestDetails) // NEW
})
```

The `ResponseMetadataPartEncoded` interface should also be updated with an optional `request` field.

### Step 3: Add `response` Field to `FinishPart`

Add an optional `response` field to `FinishPart`:

```ts
export interface FinishPart extends BasePart<"finish", FinishPartMetadata> {
  readonly reason: FinishReason
  readonly usage: Usage
  readonly response: typeof HttpResponseDetails.Type | undefined // NEW
}
```

Update the schema accordingly:

```ts
export const FinishPart = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("finish"),
  reason: FinishReason,
  usage: Usage,
  response: Schema.UndefinedOr(HttpResponseDetails) // NEW
})
```

The `FinishPartEncoded` interface should also be updated with an optional `response` field.

### Step 4: Thread `includeResponse: true` in OpenAI Provider

#### Non-Streaming Path

In `OpenAiClient.ts`, update `createResponse` to pass `config: { includeResponse: true }` and return both the decoded body and the `HttpClientResponse`:

```ts
const createResponse = (
  payload: typeof Generated.CreateResponse.Encoded
): Effect.Effect<
  [typeof Generated.Response.Type, HttpClientResponse.HttpClientResponse],
  AiError.AiError
> =>
  client.createResponse({ payload, config: { includeResponse: true } }).pipe(
    Effect.catchTags({
      HttpClientError: (error) => Errors.mapHttpClientError(error, "createResponse"),
      SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createResponse"))
    })
  )
```

In `OpenAiLanguageModel.ts`, update `generateText` to destructure the tuple and pass the `HttpClientResponse` to `makeResponse`:

```ts
const [rawResponse, response] = yield * client.createResponse(request)
return yield * makeResponse({ options, rawResponse, response, toolNameMapper })
```

Update `makeResponse` to accept `rawResponse` (the decoded API body) and `response` (the `HttpClientResponse`) and include request/response details in the emitted parts. The `HttpClientResponse` object contains a `.request` property giving access to the original `HttpClientRequest`.

#### Streaming Path

The `sseRequest` function in `Generated.ts` does not currently support `includeResponse`. Rather than modifying generated code, capture the `HttpClientResponse` at the `OpenAiClient.createResponseStream` level.

In `OpenAiClient.ts`, refactor `createResponseStream` to manually execute the HTTP request, capture the response, and then pipe it through SSE decoding. Emit the `HttpClientResponse` as a prefix element or thread it through the stream context using `Stream.mapEffect` with a `Ref`.

Alternatively, modify the stream to prepend the HTTP response details. The recommended approach is to change `createResponseStream` to return a tuple of `[HttpClientResponse, Stream]`:

```ts
const createResponseStream = (
  payload: Omit<typeof Generated.CreateResponse.Encoded, "stream">
): Effect.Effect<
  [HttpClientResponse.HttpClientResponse, Stream.Stream<ResponseStreamEvent, AiError.AiError>],
  AiError.AiError
> => ...
```

Then in `OpenAiLanguageModel.ts`, destructure into `response` (the `HttpClientResponse`) and the stream, and pass `response` to `makeStreamResponse`.

### Step 5: Thread `includeResponse: true` in Anthropic Provider

#### Non-Streaming Path

Same pattern as OpenAI. In `AnthropicClient.ts`, update `createMessage` to pass `config: { includeResponse: true }`:

```ts
const createMessage = (options: {
  readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
  readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
}): Effect.Effect<
  [typeof Generated.BetaMessage.Type, HttpClientResponse.HttpClientResponse],
  AiError.AiError
> =>
  client.betaMessagesPost({ ...options, config: { includeResponse: true } }).pipe(
    Effect.catchTags({
      BetaMessagesPost4XX: (error) => Effect.fail(Errors.mapClientError(error, "createMessage")),
      HttpClientError: (error) => Errors.mapHttpClientError(error, "createMessage"),
      SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createMessage"))
    })
  )
```

In `AnthropicLanguageModel.ts`, destructure into `rawResponse` and `response`, and pass both to `makeResponse`.

#### Streaming Path

Anthropic's `createMessageStream` constructs the HTTP request manually (line 297-318 in `AnthropicClient.ts`). The `streamRequest` helper at line 246-261 has direct access to `httpClientOk.execute(request)` and discards the response at line 252 with `Effect.map((response) => response.stream)`.

Refactor `streamRequest` / `createMessageStream` to capture and return the `HttpClientResponse` alongside the stream, following the same tuple pattern as OpenAI.

### Step 6: Populate HTTP Details in Response Parts

#### `buildHttpRequestDetails` Helper

Move the `buildHttpRequestDetails` helper from `internal/errors.ts` to a shared location (or duplicate it in the language model files). This function extracts request details from `HttpClientRequest`:

```ts
const buildHttpRequestDetails = (
  request: HttpClientRequest.HttpClientRequest
): typeof Response.HttpRequestDetails.Type => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  hash: request.hash,
  headers: Redactable.redact(request.headers) as Record<string, string>
})
```

#### `buildHttpResponseDetails` Helper

Create a corresponding helper for response details:

```ts
const buildHttpResponseDetails = (
  response: HttpClientResponse.HttpClientResponse
): typeof Response.HttpResponseDetails.Type => ({
  status: response.status,
  headers: Redactable.redact(response.headers) as Record<string, string>
})
```

#### Populate in `makeResponse` / `makeStreamResponse`

**Non-Streaming (both providers):**

- When constructing the `ResponseMetadataPart`, include `request: buildHttpRequestDetails(response.request)`.
- When constructing the `FinishPart`, include `response: buildHttpResponseDetails(response)`.

**Streaming (both providers):**

- When emitting the initial `ResponseMetadataPart` (on `response.created` / `message_start`), include `request: buildHttpRequestDetails(response.request)`.
- When emitting the final `FinishPart` (on `response.completed` / `message_delta`+`message_stop`), include `response: buildHttpResponseDetails(response)`.

### Step 7: Update Error Path Imports

Update `AiError.ts` to import `HttpRequestDetails` and `HttpResponseDetails` from `Response` and use them in `HttpContext` and error reason classes. Update `internal/errors.ts` in both OpenAI and Anthropic to import from `Response` instead of `AiError` for the HTTP details schemas. The `buildHttpRequestDetails` and `buildHttpContext` helpers reference the schema types — update their type annotations to use `Response.HttpRequestDetails.Type` and `Response.HttpResponseDetails.Type`.

## Impacted Files

### Core

- `packages/effect/src/unstable/ai/Response.ts` — Add `HttpRequestDetails`, `HttpResponseDetails` schemas; update `ResponseMetadataPart` and `FinishPart`.
- `packages/effect/src/unstable/ai/AiError.ts` — Remove local `HttpRequestDetails` and `HttpResponseDetails` definitions; import from `Response`.

### OpenAI Provider

- `packages/ai/openai/src/OpenAiClient.ts` — Update `createResponse` and `createResponseStream` to surface `HttpClientResponse`.
- `packages/ai/openai/src/OpenAiLanguageModel.ts` — Update `makeResponse` and `makeStreamResponse` to populate HTTP details in response parts.

### Anthropic Provider

- `packages/ai/anthropic/src/AnthropicClient.ts` — Update `createMessage` and `createMessageStream` to surface `HttpClientResponse`.
- `packages/ai/anthropic/src/AnthropicLanguageModel.ts` — Update `makeResponse` and `makeStreamResponse` to populate HTTP details in response parts.

### Tests

- Existing response protocol tests may need updates for the new optional fields.
- Provider-specific tests that construct response parts will need the new fields.

## Test Plan

- Verify `HttpRequestDetails` and `HttpResponseDetails` can be imported from `Response`.
- Verify `ResponseMetadataPart` schema encodes/decodes correctly with and without the `request` field.
- Verify `FinishPart` schema encodes/decodes correctly with and without the `response` field.
- Verify non-streaming requests in both providers include HTTP details in response parts.
- Verify streaming requests in both providers include HTTP details in response parts.
- Verify error path continues to work unchanged (imports updated to `Response`).
- Verify header redaction works correctly for sensitive headers in the success path.

## Validation

- `pnpm lint-fix`
- `pnpm test <affected_test_file.ts>`
- `pnpm check` (run `pnpm clean` if check fails)
- `pnpm build`
- `pnpm docgen`

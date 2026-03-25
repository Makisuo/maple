# HttpClientError Reason Pattern

## Overview

Refactor `HttpClientError` to follow the reason pattern used by `SocketError` and `AiError`. The new design introduces per-reason error classes and a top-level `HttpClientError` wrapper with a `reason` field. This provides ergonomic error handling with `Effect.catchReason`, while preserving rich request/response context.

## Goals

- Replace the string `reason` union with per-reason error classes.
- Introduce a top-level `HttpClientError` wrapper that contains a `reason` field.
- Use `Data.TaggedError` for all new error types.
- Preserve existing error messages and request/response metadata.
- Update call sites to construct the new wrapper error consistently.

## Non-Goals

- Changing HTTP client behavior beyond error modeling.
- Refactoring `HttpServerError` or other unrelated error types.
- Adding retry policy or backoff logic.
- Adding new HTTP status handling rules.

## Current State

`HttpClientError` is a type alias for `RequestError | ResponseError`, both implemented as `Data.TaggedError` with a string `reason` field. Call sites instantiate `new RequestError(...)` or `new ResponseError(...)` directly. Many APIs report `RequestError` or `ResponseError` as the error type.

## Proposed Design

### Reason Classes

Introduce per-reason classes using `Data.TaggedError`. All reason classes include the request, optional description, and optional cause. Response reason classes also include the response.

Reason class fields:

- `request: HttpClientRequest.HttpClientRequest`
- `response?: HttpClientResponse.HttpClientResponse` (response reasons only)
- `description?: string`
- `cause?: unknown`

Request reasons:

- `TransportError` (`_tag: "TransportError"`)
- `EncodeError` (`_tag: "EncodeError"`)
- `InvalidUrlError` (`_tag: "InvalidUrlError"`)

Response reasons:

- `StatusCodeError` (`_tag: "StatusCodeError"`)
- `DecodeError` (`_tag: "DecodeError"`)
- `EmptyBodyError` (`_tag: "EmptyBodyError"`)

Each reason class keeps the current `message` formatting behavior:

- Request reasons keep `"<Reason>: <description> (<METHOD> <URL>)"`
- Response reasons keep `"<Reason>: <description> (<STATUS> <METHOD> <URL>)"`

### Reason Union Types

- `HttpClientErrorReason` union of all per-reason classes.
- `RequestError` and `ResponseError` become type aliases that group request and response reasons respectively.
- Export the reason classes from the `HttpClientError` module; keep `RequestError`/`ResponseError` as type aliases only.

### HttpClientError Wrapper

Add a top-level `HttpClientError` class using `Data.TaggedError`:

```ts
export class HttpClientError extends Data.TaggedError("HttpClientError")<{
  readonly reason: HttpClientErrorReason
}> {
  readonly [TypeId] = TypeId

  override get message(): string {
    return this.reason.message
  }
}
```

Behavior:

- `message` delegates to `reason.message`.
- `isHttpClientError` guard checks only the wrapper (AiError-style).
- If the reason has a `cause`, the wrapper constructor copies it onto the wrapper (SocketError-style).
- Preserve the existing `TypeId` string (`~effect/http/HttpClientError`) for guard compatibility.

### API Surface Changes

- `HttpClientError` becomes a class instead of a union type.
- `RequestError` and `ResponseError` are no longer constructible classes.
- All APIs that previously exposed `RequestError` or `ResponseError` as error types now expose `HttpClientError`.
- Call sites must wrap reasons in `new HttpClientError({ reason })`.
- `Effect.catchTag("RequestError")`/`"ResponseError"` flows must move to `catchTag("HttpClientError")` and inspect `error.reason._tag`.

### Usage Examples

Before:

```ts
Effect.fail(
  new HttpClientError.RequestError({
    request,
    reason: "InvalidUrl",
    description: "Invalid base URL",
    cause
  })
)
```

After:

```ts
Effect.fail(
  new HttpClientError({
    reason: new HttpClientError.InvalidUrlError({
      request,
      description: "Invalid base URL",
      cause
    })
  })
)
```

Handling:

```ts
Effect.catchTag("HttpClientError", (error) => {
  if (error.reason._tag === "StatusCodeError") {
    return Effect.logError(error.message)
  }
  return Effect.fail(error)
})
```

With `Effect.catchReason`:

```ts
Effect.catchReason("HttpClientError", "StatusCodeError", (reason) => Effect.logError(reason.message))
```

## Impacted Areas

- `packages/effect/src/unstable/http/HttpClientError.ts`
- HTTP client core modules (`HttpClient.ts`, `HttpClientResponse.ts`, `FetchHttpClient.ts`, `HttpEffect.ts`)
- Platform implementations (`packages/platform-browser`, `packages/platform-node`, `packages/platform-bun`)
- Downstream usages (OpenAPI generator, AI error conversions, tests)

## Test Plan

- Add new tests for `HttpClientError` reason classes and wrapper behavior.
- Update existing tests that reference `RequestError` or `ResponseError`.
- Verify error message strings remain unchanged.

## Validation

- `pnpm lint-fix`
- `pnpm test <affected_test_file.ts>`
- `pnpm check` (run `pnpm clean` if check fails)
- `pnpm build`
- `pnpm docgen`

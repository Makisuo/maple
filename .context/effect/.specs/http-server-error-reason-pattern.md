# HttpServerError Reason Pattern

## Overview

Refactor `HttpServerError` to use the reason pattern (see `HttpClientError` and
`SocketError`). `HttpServerError` becomes a thin wrapper around a `reason` union
of semantic reason classes. The existing reason tags and response mappings stay
the same while enabling `Effect.catchReason` flows.

## Goals

- Replace the string `reason` union with per-reason classes.
- Introduce a top-level `HttpServerError` wrapper containing a `reason` field.
- Preserve existing reason tags (`RequestParseError`, `RouteNotFound`,
  `InternalError`, `ResponseError`).
- Keep the current message formatting and response status mapping.
- Update call sites to construct the wrapper with reason instances.
- Keep `isHttpServerError` aligned with the wrapper only.
- Keep `ServeError` behavior separate from `HttpServerError`.

## Non-Goals

- Changing response status behavior or routing semantics.
- Adding new error categories or altering error messages.
- Refactoring unrelated HTTP server modules.

## Current State

`HttpServerError` is a type alias of `RequestError | ResponseError`, implemented
as `Data.TaggedError` classes that store a literal `reason` field. Call sites
instantiate `new RequestError({ reason: "RouteNotFound", ... })` or
`new ResponseError({ ... })` directly, and `Respondable` handling is implemented
on these classes.

## Proposed Design

### Reason Classes

Introduce reason classes using `Data.TaggedError` with the existing tags:

- `RequestParseError`
- `RouteNotFound`
- `InternalError`
- `ResponseError`

Shared fields (all reasons):

- `request: HttpServerRequest.HttpServerRequest`
- `description?: string`
- `cause?: unknown`

Response-specific fields:

- `response: HttpServerResponse.HttpServerResponse`

Each reason implements `Respondable.Respondable` and defines
`[Respondable.TypeId]` with the same status mapping as today:

- `RequestParseError` -> 400
- `RouteNotFound` -> 404
- `InternalError` -> 500
- `ResponseError` -> 500

### Message Formatting

Reason classes preserve the existing message strings:

- Request reasons: `<Reason> (<METHOD> <URL>)`, with `: <description>` when set.
- `ResponseError`: `<Reason> (<STATUS> <METHOD> <URL>)`, with `: <description>` when set.

### Reason Union Types

- `RequestError` becomes a type alias for request reasons.
- `HttpServerErrorReason` is the union of all reason classes.

### HttpServerError Wrapper

Add a `HttpServerError` wrapper class:

```ts
export class HttpServerError extends Data.TaggedError("HttpServerError")<{
  readonly reason: HttpServerErrorReason
}> {
  readonly [TypeId] = TypeId

  override get message(): string {
    return this.reason.message
  }
}
```

Behavior:

- Copies `reason.cause` onto the wrapper when present (SocketError-style).
- Implements `Respondable.Respondable`, delegating `[Respondable.TypeId]` to the reason.
- Optional convenience getters for `request` and `response` delegate to the reason.
- `isHttpServerError` guards only the wrapper.
- Preserve the existing `stack` format (`${this.name}: ${this.message}`) on the wrapper.

### ServeError Guarding

`ServeError` continues to represent server startup failures, but
`isHttpServerError` must not match it. Implement this by tightening the guard to
check the wrapper `_tag` or by moving `ServeError` onto its own type id.

### Construction Pattern

```ts
Effect.fail(
  new HttpServerError({
    reason: new RouteNotFound({ request })
  })
)
```

Handling:

```ts
Effect.catchReason("HttpServerError", "RouteNotFound", (reason) => Effect.logWarning(reason.message))
```

## Impacted Areas

- `packages/effect/src/unstable/http/HttpServerError.ts`
- `packages/effect/src/unstable/http/HttpRouter.ts`
- `packages/effect/src/unstable/http/HttpEffect.ts`
- `packages/effect/src/unstable/http/HttpServerRequest.ts`
- `packages/effect/src/unstable/http/HttpMiddleware.ts`
- `packages/platform-node/src/NodeHttpServer.ts`
- `packages/platform-node/src/NodeClusterHttp.ts`
- `packages/platform-bun/src/BunHttpServer.ts`
- `packages/platform-bun/src/BunClusterHttp.ts`
- `packages/effect/src/unstable/eventlog/EventLogServer.ts`

## Test Plan

- Add tests for reason message formatting and status mapping.
- Verify wrapper delegates `message`, `request`, and `response`.
- Verify `isHttpServerError` only matches the wrapper.
- Verify `ServeError` is excluded from `isHttpServerError`.
- Validate `Respondable` delegation (wrapper -> reason).

Follow the `it.effect` pattern and existing Effect test conventions.

## Validation

- `pnpm lint-fix`
- `pnpm test <affected_test_file.ts>`
- `pnpm check` (run `pnpm clean` if check fails)
- `pnpm build`
- `pnpm docgen`

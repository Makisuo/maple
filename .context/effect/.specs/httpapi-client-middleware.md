# HttpApi Client Middleware

Add client-side middleware support to `HttpApi`, mirroring the pattern established by `RpcMiddleware.layerClient` in the Rpc module. This enables typed, composable middleware that intercepts outgoing HTTP requests on the client side — e.g. for injecting auth headers, logging, or request transformation.

## Motivation

The Rpc module already supports client middleware via `RpcMiddleware.layerClient`. Each Rpc middleware class can optionally declare `requiredForClient: true`, and a client-side implementation is provided through `layerClient`. The client resolves middleware at runtime by looking up `${tag.key}/Client` in the service map, forming a `next`-based chain.

`HttpApi` has no equivalent. The only client-side hooks are `transformClient` (wraps the `HttpClient` once, no endpoint metadata) and `transformResponse` (wraps decoded response effect, no endpoint metadata). There is no way to:

- Run per-endpoint middleware that has access to endpoint/group metadata
- Add typed client-specific errors to the Effect error channel
- Require client-side middleware at the type level
- Compose multiple middleware in a chain with `next` semantics

## Design

### New types in `HttpApiMiddleware`

#### `HttpApiMiddlewareClient<E, CE, R>`

The client-side middleware function signature, analogous to `RpcMiddlewareClient`:

```ts
export interface HttpApiMiddlewareClient<CE, R> {
  (options: {
    readonly endpoint: HttpApiEndpoint.AnyWithProps
    readonly group: HttpApiGroup.AnyWithProps
    readonly request: HttpClientRequest.HttpClientRequest
    readonly next: (
      request: HttpClientRequest.HttpClientRequest
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
  }): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    CE | HttpClientError.HttpClientError,
    R
  >
}
```

Key differences from `RpcMiddlewareClient`:

- `request` is an `HttpClientRequest` (not `Request<Rpc.Any>`)
- `next` returns an `HttpClientResponse` (not `SuccessValue`)
- `next` only fails with `HttpClientError.HttpClientError` (transport-level errors); server-side middleware errors arrive via the HTTP response body and are decoded after the middleware chain
- `options` includes `endpoint` and `group` metadata (not `rpc`)
- No `E` type param, because server-side errors are not surfaced in the client middleware chain's effect error channel

#### `ForClient<Id>`

Phantom type to represent the client-side layer requirement for a middleware, identical in shape to `RpcMiddleware.ForClient`:

```ts
export interface ForClient<Id> {
  readonly _: unique symbol
  readonly id: Id
}
```

### Changes to `HttpApiMiddleware.Service`

#### New config option: `clientError`

Add an optional `clientError` type parameter to the `Config` generic:

```ts
export const Service = <
  Self,
  Config extends {
    requires?: any
    provides?: any
    clientError?: any   // NEW
  } = { requires: never; provides: never; clientError: never }
>(): <
  const Id extends string,
  Error extends Schema.Top = never,
  const Security extends Record<string, HttpApiSecurity.HttpApiSecurity> = never,
  RequiredForClient extends boolean = false  // NEW
>(
  id: Id,
  options?: {
    readonly error?: Error
    readonly security?: Security
    readonly requiredForClient?: RequiredForClient  // NEW
  }
) => ServiceClass<...>
```

#### Updated `ServiceClass` type

Add `requiredForClient` and `~ClientError` fields to the service class (matching Rpc's `ServiceClass`):

```ts
export type ServiceClass<Self, Id, Config, Service> =
  & ServiceMap.Service<Self, Service>
  & {
    new(_: never): ServiceMap.ServiceClass.Shape<Id, Service> & {
      readonly [TypeId]: {
        readonly error: Config["error"]
        readonly requires: Config["requires"]
        readonly provides: Config["provides"]
        readonly clientError: Config["clientError"] // NEW - in instance brand
      }
    }
    readonly [TypeId]: typeof TypeId
    readonly error: Config["error"]
    readonly requiredForClient: boolean // NEW
    readonly "~ClientError": Config["clientError"] // NEW
  }
```

Note: `clientError` is threaded through the instance `[TypeId]` brand so that the `MiddlewareClient` and `ClientError` type helpers can extract it from the identifier type (since `HttpApiEndpoint`'s `Middleware` type parameter accumulates identifiers via `AnyId`, not service classes).

#### Updated `AnyKey` types

Add `requiredForClient` and `~ClientError` to `AnyKey` so the runtime can inspect these fields:

```ts
export interface AnyKey extends ServiceMap.Service<any, any> {
  readonly [TypeId]: typeof TypeId
  readonly provides: any
  readonly error: Schema.Top
  readonly requiredForClient: boolean // NEW
  readonly "~ClientError": any // NEW
}
```

#### Updated `AnyId` type

```ts
export interface AnyId {
  readonly [TypeId]: {
    readonly provides: any
    readonly clientError: any // NEW
    readonly requiredForClient: boolean // NEW
  }
}
```

### New function: `HttpApiMiddleware.layerClient`

Analogous to `RpcMiddleware.layerClient`. Creates a `Layer` that provides the client-side middleware implementation:

```ts
export const layerClient: <Id extends AnyId, S, R, EX = never, RX = never>(
  tag: ServiceMap.Service<Id, S>,
  service:
    | HttpApiMiddlewareClient<Id[TypeId]["error"]["Type"], Id[TypeId]["clientError"], R>
    | Effect.Effect<
      HttpApiMiddlewareClient<Id[TypeId]["error"]["Type"], Id[TypeId]["clientError"], R>,
      EX,
      RX
    >
) => Layer.Layer<ForClient<Id>, EX, R | Exclude<RX, Scope>>
```

Implementation registers the middleware under `${tag.key}/Client` in the service map (same convention as Rpc):

```ts
export const layerClient = (tag, service) =>
  Layer.effectServices(Effect.gen(function*() {
    const services = (yield* Effect.services()).pipe(ServiceMap.omit(Scope))
    const middleware = Effect.isEffect(service) ? yield* service : service
    return ServiceMap.makeUnsafe(
      new Map([[
        `${tag.key}/Client`,
        (options) =>
          Effect.updateServices(
            middleware(options),
            (requestContext) => ServiceMap.merge(services, requestContext)
          )
      ]])
    )
  }))
```

### New type helpers

#### `HttpApiMiddleware.ClientError<Middleware>`

Extracts the client error type from middleware. Only includes errors from middleware where `requiredForClient: true`, since optional middleware may not be running:

```ts
export type ClientError<A> = A extends
  { readonly [TypeId]: { readonly requiredForClient: true; readonly clientError: infer CE } } ? CE
  : never
```

Note: This extracts from the `[TypeId]` brand since `HttpApiEndpoint`'s `Middleware` type parameter accumulates identifier types, not class types.

#### `HttpApiMiddleware.MiddlewareClient<Middleware>`

Extracts the `ForClient<Id>` requirements from a middleware type. Only includes middleware where `requiredForClient: true`:

```ts
export type MiddlewareClient<A> = A extends { readonly requiredForClient: true }
  ? ForClient<ServiceMap.Service.Identifier<A>>
  : never
```

Since the `Middleware` type parameter in `HttpApiEndpoint` accumulates **identifier types** (instances of `AnyId`), not service classes, this helper must work on identifiers. The `requiredForClient` field needs to be accessible on the identifier — this is achieved by threading it through the instance `[TypeId]` brand in the `ServiceClass` type.

#### `HttpApiEndpoint.MiddlewareClient<Endpoint>`

Extracts client middleware requirements from all middleware attached to an endpoint:

```ts
export type MiddlewareClient<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _MR
> ? HttpApiMiddleware.MiddlewareClient<_Middleware>
  : never
```

### Changes to `HttpApiClient`

#### Internal: middleware chain execution in `makeClient`

Add middleware resolution and chain execution to the `makeClient` function, modeled after `RpcClient.getRpcClientMiddleware`:

1. At the top of `makeClient`'s `Effect.gen`, call `yield* Effect.services()` to capture the ambient services for middleware resolution.
2. During `onEndpoint`, collect the middleware set from `endpoint.middlewares`.
3. For each middleware tag in the set, look up `${tag.key}/Client` in the captured services.
4. Build a `next`-based chain (last-to-first iteration, same as Rpc). Middleware attached later runs first (outermost — LIFO ordering), consistent with Rpc.
5. Wrap the `httpClient.execute(httpRequest)` call with the middleware chain.

The middleware chain replaces the direct `httpClient.execute(httpRequest)` call at line 241 of `HttpApiClient.ts`. Each middleware receives `{ endpoint, group, request, next }` and can:

- Modify the `HttpClientRequest` before calling `next`
- Run effects before/after `next`
- Short-circuit by not calling `next`

If a middleware is not found in the service map (not provided via `layerClient`), it is **skipped** at runtime. Only middleware marked `requiredForClient: true` produces a type-level requirement.

Security middleware participates in client middleware identically to regular middleware — the `requiredForClient` flag applies regardless of whether the middleware uses security schemes. The client middleware function receives `endpoint` and `group` metadata but not security credentials (those are server-side concerns).

#### Type-level: `Client.Method` error and context channels

Update the `Client.Method` type to include:

- `HttpApiMiddleware.ClientError<_Middleware>` in the error channel (for typed client-side errors)

```ts
export type Method<Endpoint, E, R> = [Endpoint] extends [
  HttpApiEndpoint.HttpApiEndpoint<
    infer _Name, infer _Method, infer _Path,
    infer _Params, infer _Query, infer _Payload, infer _Headers,
    infer _Success, infer _Error, infer _Middleware, infer _MR
  >
] ? <WithResponse extends boolean = false>(
    request: Simplify<HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, WithResponse>>
  ) => Effect.Effect<
    WithResponse extends true ? [...] : _Success["Type"],
    | _Error["Type"]
    | HttpApiMiddleware.Error<_Middleware>
    | HttpApiMiddleware.ClientError<_Middleware>    // NEW
    | E
    | HttpClientError.HttpClientError
    | Schema.SchemaError,
    | R
    | _Params["EncodingServices"]
    | _Query["EncodingServices"]
    | _Payload["EncodingServices"]
    | _Headers["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  > : never
```

The `ForClient<Id>` requirement surfaces per-method-call (like schema encoding/decoding services), not at the `make`/`makeWith` level. This is consistent with how other service requirements are handled.

The constructor return types (`make`, `makeWith`, `group`, `endpoint`) need changes.

- Client middleware ids in the context channel (for required client middleware layers)

## Usage Example

### Defining middleware with client support

```ts
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable"

// Middleware that provides CurrentUser on the server and requires auth headers on the client
class AuthMiddleware extends HttpApiMiddleware.Service<AuthMiddleware, {
  provides: CurrentUser
  clientError: AuthTokenExpired
}>()("AuthMiddleware", {
  error: Unauthorized,
  security: {
    bearer: HttpApiSecurity.bearer
  },
  requiredForClient: true
}) {}
```

### Client-side implementation

```ts
import { HttpApiMiddleware } from "effect/unstable"

const AuthClient = HttpApiMiddleware.layerClient(
  AuthMiddleware,
  Effect.fnUntraced(function*({ next, request, endpoint, group }) {
    const token = yield* TokenStore
    const authedRequest = HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`)
    return yield* next(authedRequest)
  })
)
```

### Wiring it together

```ts
const ApiClient = HttpApiClient.make(Api).pipe(
  Effect.provide(AuthClient)
)
```

The type system enforces that `AuthClient` must be provided because `AuthMiddleware` has `requiredForClient: true`. If omitted, the `ForClient<AuthMiddleware>` requirement remains unsatisfied.

## Implementation Plan

### Task 1: Add client middleware types and update `HttpApiMiddleware.Service`

**Files:** `packages/effect/src/unstable/httpapi/HttpApiMiddleware.ts`

Add new type definitions:

- `ForClient<Id>` interface
- `HttpApiMiddlewareClient<E, CE, R>` interface
- `ClientError<A>` type helper (restricted to `requiredForClient: true`)
- `MiddlewareClient<A>` type helper

Update existing types:

- `AnyId`: add `requires`, `error`, `clientError` to `[TypeId]`
- `AnyKey`: add `requiredForClient: boolean` and `"~ClientError": any`
- `ServiceClass`: add `requiredForClient`, `"~ClientError"`, and `clientError` in instance `[TypeId]` brand
- `Service` function signature: add `clientError` to `Config`, add `RequiredForClient` type param
- `Service` runtime: store `requiredForClient` (default `false`) on the class

These changes must be done atomically because `AnyKey` gains `requiredForClient` and `~ClientError` — if applied without updating `Service` to set those fields, existing code casting to `AnyKey` would fail type checking.

All new public types need `@since 4.0.0` annotations.

**Validation:** `pnpm lint-fix && pnpm check`

### Task 2: Implement `HttpApiMiddleware.layerClient`

**Files:** `packages/effect/src/unstable/httpapi/HttpApiMiddleware.ts`

Add the `layerClient` function following the `RpcMiddleware.layerClient` pattern:

- Accept a middleware tag and a client middleware function (or Effect producing one)
- Register under `${tag.key}/Client` in the service map
- Return `Layer<ForClient<Id>, EX, R | Exclude<RX, Scope>>`

New imports needed: `Effect`, `Layer`, `Scope`, plus HTTP client types.

`@since 4.0.0` annotation on the export.

**Depends on:** Task 1

**Validation:** `pnpm lint-fix && pnpm check`

### Task 3: Add `MiddlewareClient` type helpers to `HttpApiEndpoint` and `HttpApiGroup`

**Files:**

- `packages/effect/src/unstable/httpapi/HttpApiEndpoint.ts`
- `packages/effect/src/unstable/httpapi/HttpApiGroup.ts`

Add type helpers:

- `HttpApiEndpoint.MiddlewareClient<Endpoint>`: extracts `ForClient<Id>` from middleware with `requiredForClient: true`
- `HttpApiGroup.MiddlewareClient<Group>`: rolls up from all endpoints

`@since 4.0.0` annotations.

**Depends on:** Task 1

**Note:** Tasks 2 and 3 are independent and can be done in parallel.

**Validation:** `pnpm lint-fix && pnpm check`

### Task 4: Integrate middleware chain into `HttpApiClient` and update `Client.Method` type

**Files:** `packages/effect/src/unstable/httpapi/HttpApiClient.ts`

Runtime changes in `makeClient`:

1. `yield* Effect.services()` at the top of `Effect.gen` to capture ambient services
2. In the `endpointFn` closure, resolve middleware by looking up `${tag.key}/Client` for each tag in `endpoint.middlewares`
3. Build a `next`-based chain (last-to-first iteration)
4. Wrap `httpClient.execute(httpRequest)` with the chain, passing `{ endpoint, group, request, next }`

Type changes:

- `Client.Method`: add `HttpApiMiddleware.ClientError<_Middleware>` to error channel
- Client constructors: `HttpApiEndpoint.MiddlewareClient<Endpoints>` to context channel

These must be done together — the runtime chain and type-level changes are co-dependent. Shipping type changes without the runtime is misleading; shipping runtime without types means incorrect error/context channels.

**Depends on:** Tasks 1, 2, 3

**Validation:** `pnpm lint-fix && pnpm check`

### Task 5: Add tests for client middleware

**Files:** `packages/platform-node/test/HttpApi.test.ts`

Add tests covering:

- Basic client middleware that modifies request headers
- Middleware chain ordering (multiple middleware, verify LIFO execution)
- `requiredForClient: true` — type-level enforcement
- Client middleware with typed `clientError`
- Optional client middleware (`requiredForClient: false`) — skipped when not provided
- Middleware receiving correct `endpoint` and `group` metadata
- `layerClient` with effectful construction
- Security middleware participating in client middleware

**Depends on:** Tasks 1-4

**Validation:** `pnpm lint-fix && pnpm check && pnpm test packages/platform-node/test/HttpApi.test.ts && pnpm build && pnpm docgen`

## Task Execution Order

```
Task 1 (types + Service update)
  ├── Task 2 (layerClient)              ← parallel
  └── Task 3 (Endpoint/Group helpers)   ← parallel
       └── Task 4 (HttpApiClient runtime + types)
            └── Task 5 (tests + full validation)
```

## Files Modified

| File                                                        | Change                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/effect/src/unstable/httpapi/HttpApiMiddleware.ts` | Add `ForClient`, `HttpApiMiddlewareClient`, `ClientError`, `MiddlewareClient` types; update `Service`, `ServiceClass`, `AnyKey`, `AnyId`; add `layerClient` function |
| `packages/effect/src/unstable/httpapi/HttpApiEndpoint.ts`   | Add `MiddlewareClient` type helper                                                                                                                                   |
| `packages/effect/src/unstable/httpapi/HttpApiGroup.ts`      | Add `MiddlewareClient` type helper                                                                                                                                   |
| `packages/effect/src/unstable/httpapi/HttpApiClient.ts`     | Integrate middleware chain in `makeClient`; update `Client.Method` type                                                                                              |
| `packages/platform-node/test/HttpApi.test.ts`               | Add client middleware tests                                                                                                                                          |

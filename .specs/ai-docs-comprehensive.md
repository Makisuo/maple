# Comprehensive AI Documentation

Add extensive AI documentation examples to `ai-docs/src/` covering running
effects, consuming streams, integrating effect in existing codebases, HTTP
servers, RPC, AI modules, cluster, workflows, observability, caching,
scheduling, batching, testing, and more.

## Context

The `ai-docs/src/` directory currently covers basics (Effect.gen, Effect.fn,
creating effects), services (ServiceMap.Service, Reference, Layer composition),
errors, resources (acquireRelease), streams (creating), HttpClient, and CLI. Many
important topics are missing.

### Conventions (from `ai-docs/README.md`)

- Section intro text goes in `index.md` files
- Examples are `.ts` files in the same folder
- Numeric filename prefixes control ordering (e.g., `10_`, `20_`)
- Each `.ts` file has a top JSDoc block with `@title` and optional description
- Code must be well-commented (how/why, not just what)
- Code must represent real-world usage and best practices
- Prefer `Effect.fn` over functions returning `Effect.gen`
- Use `ServiceMap.Service` for structuring code where possible
- Export key definitions so the TypeScript compiler can verify them
- Use `declare const` for stubs when implementation is not the focus
- Run `pnpm ai-docgen` to regenerate `LLMS.md`

### Validation steps

Every task must pass:

1. `pnpm ai-docgen` (regenerate LLMS.md)
2. `pnpm lint-fix` (formatting)
3. `pnpm check:tsgo` (type checking; run `pnpm clean` first if stuck)

No changeset needed for ai-docs-only changes.

## New sections and files

### 1. Layers with side effects — `01_effect/04_resources/`

This section already exists with `10_acquire-release.ts`. Add one new file.

#### `20_layer-side-effects.ts`

**Title:** Creating Layers that run background tasks

**Content:**

- Show a Layer that uses `Effect.forkScoped` to run a background fiber
- Real-world example: a metrics collector service that periodically flushes
  metrics to an external system
- Service definition with `ServiceMap.Service` and a `record(metric, value)`
  method
- Layer implementation using `Layer.effect` that:
  - Creates internal state (e.g., `Ref` of accumulated metrics)
  - Uses `Effect.forkScoped` to fork a background fiber that periodically
    flushes metrics (using `Effect.schedule` with `Schedule.spaced`)
  - Returns the service instance
- Demonstrate that the background fiber is automatically interrupted when the
  Layer's scope closes
- Use `Effect.fn` for the flush logic (not a function returning `Effect.gen`)

**Imports:** `Effect, Layer, Ref, Schedule, Schema, ServiceMap`

### 2. LayerMap — `01_effect/04_resources/`

#### `30_layer-map.ts`

**Title:** Dynamic resources with LayerMap

**Content:**

- Define a `DatabasePool` service using `ServiceMap.Service`
- Create a `PoolMap` using `LayerMap.Service` class syntax that creates
  per-tenant database pools keyed by tenant ID
- Show `lookup` function that returns a `Layer` for each key
- Demonstrate accessing a tenant's pool via `PoolMap.get(tenantId)` which
  returns a `Layer`
- Show `idleTimeToLive` for automatic cleanup of idle pools
- Show `PoolMap.invalidate(tenantId)` to manually force pool recreation
- Show `PoolMap.services(tenantId)` for direct scoped access

**Imports:** `Effect, Layer, LayerMap, Schema, ServiceMap`

### 3. Running effects — `01_effect/05_running/` (new section)

#### `index.md`

**Content:** Brief intro explaining the different ways to run Effect programs:
`NodeRuntime.runMain` / `BunRuntime.runMain` for standalone apps, `Layer.launch`
for layer-as-application patterns.

#### `10_run-main.ts`

**Title:** Running effects with NodeRuntime and BunRuntime

**Content:**

- Define a simple service (e.g., `AppConfig`) with `ServiceMap.Service` and a
  layer
- Build a program with `Effect.gen` that uses the service
- Provide dependencies with `Effect.provide`
- Run with `NodeRuntime.runMain(program)` (from `@effect/platform-node`)
- Comment explaining `BunRuntime.runMain` from `@effect/platform-bun` is
  identical for Bun environments
- Show the `disableErrorReporting` option
- Explain that `runMain` handles SIGINT/SIGTERM for graceful shutdown

**Imports:** `Effect, Layer, ServiceMap` + `NodeRuntime` from
`@effect/platform-node`

#### `20_layer-launch.ts`

**Title:** Using Layer.launch as the application entry point

**Content:**

- Define an HTTP server layer using `HttpRouter.serve` + `NodeHttpServer.layer`
- Add a simple health-check route via `HttpRouter.add`
- Show `Layer.launch` converting the layer into an `Effect<never>` that keeps
  the app alive
- Pipe into `NodeRuntime.runMain`
- Explain this is the idiomatic pattern when your entire app is a composition
  of layers (e.g., HTTP server + background workers)

**Imports:** `Effect, Layer` + `NodeRuntime` from `@effect/platform-node` +
`HttpRouter, HttpServerResponse` from `effect/unstable/http` + `NodeHttpServer`
from `@effect/platform-node`

### 4. Consuming streams — `02_stream/`

#### `20_consuming-streams.ts`

**Title:** Consuming and transforming streams

**Content:**

- Start with a `Stream.fromIterable` of structured data (e.g., order records)
- Demonstrate `Stream.map`, `Stream.filter`, `Stream.mapEffect` (with an
  effectful transformation like enriching data, using the concurrency option)
- Show `Stream.runCollect` to collect into a `Array`
- Show `Stream.runForEach` with an effectful consumer (e.g., logging each
  element)
- Show `Stream.runFold` to accumulate a result (e.g., sum of order totals)
- Show `Stream.run` with a `Sink` (e.g., `Sink.sum`)
- Show `Stream.runHead` and `Stream.runLast`
- Demonstrate `Stream.take`, `Stream.drop`, `Stream.takeWhile`

**Imports:** `Chunk, Effect, Sink, Stream`

### 5. Integrating Effect — `03_integration/` (new section)

#### `index.md`

**Content:** Brief intro: `ManagedRuntime` bridges Effect's world with non-Effect
code. Use it to integrate Effect services into existing web frameworks, legacy
codebases, or any environment where you need imperative access to Effect
services.

#### `10_managed-runtime.ts`

**Title:** Using ManagedRuntime with Hono

**Content:**

- Define a `TodoRepo` service with `ServiceMap.Service` (methods: `getAll`,
  `getById`, `create`)
- Create `const runtime = ManagedRuntime.make(TodoRepo.layer)` at module level
- Create a Hono app with routes:
  - `GET /todos` — calls `runtime.runPromise(TodoRepo.getAll(...))`
  - `GET /todos/:id` — calls `runtime.runPromise(TodoRepo.getById(...))`
  - `POST /todos` — calls `runtime.runPromise(TodoRepo.create(...))`
- Show cleanup with `runtime.dispose()` in a shutdown hook
- Comment explaining this pattern works with Express, Fastify, Koa, etc.
- Comment explaining `runtime.runSync` and `runtime.runCallback` as
  alternatives for synchronous or callback-based contexts

**Imports:** `Effect, Layer, ManagedRuntime, Schema, ServiceMap` + `Hono` from
`hono`

**Dependency change:** Add `hono` to `ai-docs/package.json` dependencies.

### 6. ExecutionPlan — `04_patterns/` (new section)

#### `index.md`

**Content:** Advanced Effect patterns including multi-step fallback strategies
with ExecutionPlan.

#### `10_execution-plan.ts`

**Title:** Custom fallback strategies with ExecutionPlan

**Content:**

- Use `declare` to define two `LanguageModel` provider layers (primary fast
  model, fallback reliable model) — keep focus on the ExecutionPlan pattern
- Create an `ExecutionPlan` with multiple steps:
  - Step 1: Primary model, 2 attempts, exponential backoff, `while` predicate
    checking for retryable errors
  - Step 2: Fallback model, 3 attempts, spaced schedule
  - Step 3: Final fallback, single attempt
- Use `Effect.withExecutionPlan(effect, plan)` to wire it
- Show `ExecutionPlan.CurrentMetadata` for logging which step/attempt is
  executing (access via `yield* ExecutionPlan.CurrentMetadata`)
- Show `ExecutionPlan.merge` to combine plans from different modules

**Imports:** `Effect, ExecutionPlan, Layer, Schedule` + `LanguageModel` from
`effect/unstable/ai`

### 7. Batching and RequestResolver — `05_batching/` (new section)

#### `index.md`

**Content:** Brief intro: Effect's batching system automatically deduplicates
and batches requests to external services. Define requests with `Request`,
resolve them with `RequestResolver`, and use `Effect.request` to issue them.

#### `10_request-resolver.ts`

**Title:** Batching requests with RequestResolver

**Content:**

- Define a `GetUserById` request class using `Request.Class`
- Define a `UserResolver` using `RequestResolver.make` that batches
  user-by-id lookups into a single batch call
- Show a service that uses `Effect.request(new GetUserById({ id }), resolver)`
- Demonstrate automatic batching by running multiple requests concurrently
  with `Effect.forEach(..., { concurrency: "unbounded" })`

**Imports:** `Effect, Request, RequestResolver, Schema`

### 8. Schedule — `06_schedule/` (new section)

#### `index.md`

**Content:** Brief intro: Schedules define recurring patterns for retries,
repeats, and polling. Compose simple schedules into complex strategies.

#### `10_schedules.ts`

**Title:** Working with the Schedule module

**Content:**

- Show basic schedules: `Schedule.recurs(n)`, `Schedule.spaced(duration)`,
  `Schedule.exponential(base)`
- Show composition: `Schedule.both` (both must continue),
  `Schedule.either` (either continues)
- Show `Schedule.while` for conditional continuation
- Demonstrate `Effect.retry(effect, { schedule })` for retrying failures
- Demonstrate `Effect.repeat(effect, { schedule })` for repeating successes
- Show `Schedule.jittered` for adding randomness to backoff
- Show `Schedule.tapInput` / `Schedule.tapOutput` for logging/metrics
- Real-world example: exponential backoff with jitter, capped at max delay,
  limited to N attempts — a production-grade retry schedule

**Imports:** `Effect, Schedule`

### 9. Cache — `07_cache/` (new section)

#### `index.md`

**Content:** Brief intro: Cache effects to avoid redundant computation. `Cache`
for in-memory caching, `PersistedCache` for caching across application restarts.

#### `10_cache.ts`

**Title:** Caching effects with Cache

**Content:**

- Define a service that makes expensive calls (e.g., `UserService` with HTTP
  lookups)
- Create a `Cache.make({ lookup: (id) => getUser(id), capacity:
  1000, timeToLive: "5 minutes" })` inside the service layer
- Show `Cache.get(cache, userId)` which deduplicates concurrent lookups for the
  same key
- Show `Cache.set(cache, key, value)` for manual population
- Show `Cache.invalidate(cache, key)` for removing entries
- Show `Cache.makeWith` for dynamic TTL based on the result
  (`(exit, key) => Duration`)

**Imports:** `Cache, Duration, Effect, Schema, ServiceMap`

#### `20_persisted-cache.ts`

**Title:** Persisting cached values across restarts with PersistedCache

**Content:**

- Define a config lookup that's expensive (e.g., fetching remote config)
- Show that the key type must implement `Persistable` (with `Schema` for
  serialization) — the `storeId` and `schema` fields define how keys and values
  are stored
- Create `PersistedCache.make({ storeId, lookup, timeToLive })` where
  `timeToLive` is a function `(key) => Duration`
- Show it requires `Persistence` service in context
- Explain the two-tier caching: in-memory Cache + Persistence backend
- Show `cache.get(key)` and `cache.invalidate(key)`
- Comment about available persistence backends (KeyValueStore, SQL, Redis)

**Imports:** `Effect, Schema` + `PersistedCache, Persistence` from
`effect/unstable/persistence`

### 10. Observability — `08_observability/` (new section)

#### `index.md`

**Content:** Brief intro: Effect has built-in support for structured logging,
distributed tracing, and metrics. Two approaches for export: the built-in Otlp
modules (recommended for new projects, zero external dependencies) and
`@effect/opentelemetry` NodeSdk (for integration with existing OpenTelemetry
setups).

#### `10_logging.ts`

**Title:** Customizing logging

**Content:**

- Show `Effect.log`, `Effect.logDebug`, `Effect.logWarning`, `Effect.logError`
  with structured annotations via `Effect.annotateLogs`
- Show `Logger.consoleJson` for production (structured JSON output)
- Show `Effect.provideService(MinimumLogLevel, ...)` to filter log levels
- Show `Effect.withLogSpan` for timing spans in logs
- Show a custom logger layer using `Logger.make` & `Logger.layer` for application-specific
  formatting

**Imports:** `Effect, Layer, Logger, LogLevel`

#### `20_otlp-tracing.ts`

**Title:** Setting up tracing with Otlp modules

**Content:**

- Import from `effect/unstable/observability`
- Configure `OtlpTracer.layer({ url: "http://localhost:4318/v1/traces" })`
- Configure `OtlpLogger.layer({ url: "http://localhost:4318/v1/logs" })`
- Compose with `FetchHttpClient.layer` (required by Otlp exporter)
- Show `Effect.withSpan("operation")` for custom spans
- Show span attributes via `Effect.annotateSpans`
- Compose the observability layer as a reusable `ObservabilityLive` layer

**Imports:** `Effect, Layer` + `OtlpTracer, OtlpLogger` from
`effect/unstable/observability` + `FetchHttpClient` from `effect/unstable/http`

#### `30_node-sdk-tracing.ts`

**Title:** Setting up tracing with @effect/opentelemetry NodeSdk

**Content:**

- Import `NodeSdk` from `@effect/opentelemetry`
- Configure with OpenTelemetry JS span processor (e.g., OTLP exporter) + metric
  reader
- Show `NodeSdk.layer(config)` composed into the application layer
- Explain when to use NodeSdk vs Otlp modules: NodeSdk when you already have an
  OpenTelemetry setup or need to use OTel ecosystem exporters (Jaeger, Zipkin,
  Datadog); Otlp modules for new projects or when you want zero external
  dependencies
- Update ai-docs/package.json with opentelemetry dependencies if not already
  present

**Imports:** `Effect, Layer` + `NodeSdk` from `@effect/opentelemetry`

### 11. Testing — `09_testing/` (new section)

#### `index.md`

**Content:** Brief intro: `@effect/vitest` provides Effect-aware test utilities.
Use `it.effect` for Effect-based tests, `layer` for shared service layers across
tests, and `assert` utilities instead of vitest's `expect`.

#### `10_effect-tests.ts`

**Title:** Writing tests with @effect/vitest

**Content:**

- Show `it.effect("name", () => Effect.gen(function*() { ... }))`
- Use `assert.deepStrictEqual`, `assert.assertTrue`, `assert.strictEqual`
- Show `it.effect.each([...])` for parameterized tests
- Show `it.live` for tests that need the real clock (no TestClock)
- Show `TestClock.adjust` for time-dependent tests within `it.effect`
- Briefly mention `it.effect.prop` for property-based testing

**Imports:** `assert, describe, it` from `@effect/vitest` + `Effect` + `Fiber`

- `TestClock` from `effect/testing`

#### `20_layer-tests.ts`

**Title:** Testing services with shared layers

**Content:**

- Define a `TodoRepo` service with `ServiceMap.Service`
- Define a test implementation `TestTodoRepo` using an in-memory `Ref` store
- Use `layer(TestTodoRepo.layer)((it) => { ... })` to share the layer across
  tests — layer is built once in `beforeAll`, torn down in `afterAll`
- Show nested `it.layer(...)` for composing additional test layers
- Demonstrate testing a `TodoService` that depends on `TodoRepo` by providing
  the test layer

**Imports:** `assert, describe, it, layer` from `@effect/vitest` + `Effect,
Layer, Ref, ServiceMap`

**Dependency change:** Add `@effect/vitest` to `ai-docs/package.json`
dependencies.

### 12. Http servers — `51_http-server/` (new section)

#### `index.md`

**Content:** Brief intro: Two approaches for HTTP servers. `HttpApi` (recommended
for most users) provides a schema-first, type-safe API with automatic validation,
error handling, OpenAPI generation, and client derivation. Plain `HttpEffect`
servers offer lower-level control for simple use cases.

#### `10_http-api.ts`

**Title:** Creating HttpApi servers

**Content:**

- Define a `User` response schema with `Schema.Class`
- Define error schemas with `Schema.TaggedErrorClass` (e.g., `UserNotFound`)
- Define endpoints:
  - `HttpApiEndpoint.get("getUser", "/:id", { params: { id:
    Schema.FiniteFromString }, success: User, error: UserNotFound })`
  - `HttpApiEndpoint.post("createUser", "/", { payload: Schema.Struct({ name:
    Schema.String }), success: User })`
- Group endpoints: `class UsersApi extends HttpApiGroup.make("users").add(...) {}`
- Create API: `class Api extends HttpApi.make("myapp").add(UsersApi.prefix("/users")) {}`
- Implement handlers with `HttpApiBuilder.group(Api, "users", handlers =>
  handlers.handle("getUser", ...).handle("createUser", ...))`
- Wire with `HttpApiBuilder.layer(Api)` piped through `Layer.provide` with
  group layers
- Serve with `HttpRouter.serve(apiLayer)` + `NodeHttpServer.layer`
- Show auth middleware: define `CurrentUser` service, `Authorization` extending
  `HttpApiMiddleware.Service` with `provides: CurrentUser` and `security: {
  bearer: HttpApiSecurity.bearer }`, implement it as a Layer
- Show `HttpApiSwagger.layer(Api, { path: "/docs" })` for Swagger UI

**Imports:** `Effect, Layer, Schema, ServiceMap` + `HttpApi, HttpApiBuilder,
HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity,
HttpApiSwagger, HttpApiSchema` from `effect/unstable/httpapi` + `HttpRouter`
from `effect/unstable/http` + `NodeHttpServer` from `@effect/platform-node`

#### `20_http-effect.ts`

**Title:** Creating plain HttpEffect servers

**Content:**

- Create routes with `HttpRouter.use(Effect.fn(...))`
- Compose multiple route layers via `Layer.merge`
- Serve with `HttpRouter.serve(routeLayers)` + `NodeHttpServer.layer`
- Show `HttpRouter.toWebHandler(routeLayers)` for serverless/testing
  deployment (returns `{ handler: (Request) => Promise<Response>, dispose }`)

**Imports:** `Effect, Layer, Schema` + `HttpRouter, HttpServerResponse` from
`effect/unstable/http` + `NodeHttpServer` from `@effect/platform-node`

### 13. RPC — `60_rpc/` (new section)

#### `index.md`

**Content:** Brief intro: The Rpc module provides type-safe, schema-validated
remote procedure calls. Define RPCs with schemas, group them, implement handlers,
and generate type-safe clients. Supports request-response and streaming patterns.

#### `10_rpc-basics.ts`

**Title:** Defining and serving RPCs

**Content:**

- Define RPCs with `Rpc.make("GetUser", { payload: Schema.Struct({ id:
  Schema.Number }), success: UserSchema, error: UserNotFound })`
- Define a streaming RPC with `Rpc.make("StreamLogs", { payload:
  Schema.Struct({ level: Schema.String }), success: LogEntry, stream: true })`
- Group with `const MyGroup = RpcGroup.make(GetUser, StreamLogs)`
- Implement handlers with `MyGroup.toLayer(Effect.gen(function*() { return
  MyGroup.of({ GetUser: (payload) => ..., StreamLogs: (payload) => Stream.from(...)
  }) }))` — request-response handlers return `Effect`, streaming handlers return
  `Stream`
- Serve over HTTP with `RpcServer.layerHttp({ group: MyGroup, path: "/rpc" })`
- Show client creation: the client requires `RpcClient.Protocol` in context.
  Use `RpcClient.layerProtocolHttp({ url: "..." })` to provide the HTTP
  protocol, then `RpcClient.make(MyGroup)` to get a typed client object where
  each RPC name becomes a method

**Imports:** `Effect, Layer, Schema, Stream` + `Rpc, RpcClient, RpcGroup,
RpcServer` from `effect/unstable/rpc` + `HttpRouter` from `effect/unstable/http`

- `NodeHttpServer` from `@effect/platform-node`

#### `20_rpc-middleware.ts`

**Title:** RPC middleware and testing

**Content:**

- Define `CurrentUser` service with `ServiceMap.Service`
- Define server middleware with `RpcMiddleware.Service` that `provides:
  CurrentUser` — the handler receives the wrapped effect and credentials,
  validates them, and provides `CurrentUser` to the effect
- Apply to group with `MyGroup.middleware(AuthMiddleware)`
- Show `RpcTest.makeClient(MyGroup)` for in-process testing: no HTTP, no
  serialization, directly wires client to server handlers
- Show client middleware with `RpcMiddleware.layerClient(AuthMiddleware, ...)` to
  inject auth headers on the client side

**Imports:** `Effect, Layer, ServiceMap` + `Rpc, RpcClient, RpcGroup,
RpcMiddleware, RpcServer, RpcTest` from `effect/unstable/rpc`

### 14. AI modules — `71_ai/` (new section)

#### `index.md`

**Content:** Brief intro: Effect's AI modules provide a provider-agnostic
interface for language models. Define tools, create chat sessions, and swap
providers without changing application code. Providers include OpenAI
(`@effect/ai-openai`), Anthropic (`@effect/ai-anthropic`), and any
OpenAI-compatible API (`@effect/ai-openai-compat`).

#### `10_language-model.ts`

**Title:** Using LanguageModel for text generation

**Content:**

- Set up an OpenAI provider:
  - `OpenAiClient.layerConfig({ apiKey: Config.redacted("OPENAI_API_KEY") })`
  - `OpenAiLanguageModel.model("gpt-5.2")`
- Show `LanguageModel.generateText({ prompt: "..." })` with response access
  (`.text`, `.usage`, `.finishReason`) inside of a custom service.
- Show `LanguageModel.generateObject({ prompt, schema })` with an Effect Schema
  for structured output (`.value` for the decoded object)
- Show `LanguageModel.streamText({ prompt })` returning a Stream of response
  parts
- Demonstrate provider swapping: same application code, different layer
  (comment showing Anthropic alternative)

**Imports:** `Effect, Layer, Schema` + `LanguageModel` from
`effect/unstable/ai` + `OpenAiClient, OpenAiLanguageModel` from
`@effect/ai-openai` + `FetchHttpClient` from `effect/unstable/http`

#### `20_tools.ts`

**Title:** Defining and using AI tools

**Content:**

- Define a tool with `Tool.make("searchDatabase", { description, parameters:
  Schema.Struct({ query: Schema.String }), success: Schema.Array(Schema.Struct(
  { ... })) })`
- Create a toolkit: `const MyToolkit = Toolkit.make(searchDatabase, getWeather)`
- Implement handlers: `MyToolkit.toLayer({ searchDatabase: (params) =>
  Effect.succeed([...]), getWeather: (params) => ... })`
- Pass to generation: `LanguageModel.generateText({ prompt, toolkit: MyToolkit
  })`
- Access results: `response.toolCalls`, `response.toolResults`
- Show `Tool.providerDefined("web_search", { description })` for provider-native
  tools

**Imports:** `Effect, Layer, Schema` + `LanguageModel, Tool, Toolkit` from
`effect/unstable/ai`

#### `30_chat.ts`

**Title:** Stateful chat sessions

**Content:**

- Create a chat with `Chat.empty` — internally maintains a `Ref` of
  conversation history (as `Prompt`)
- Show `chat.generateText({ prompt: "Hello" })` which appends user message,
  calls model, appends assistant response
- Show follow-up: `chat.generateText({ prompt: "Tell me more" })` which
  includes full history
- Show `Chat.fromPrompt(Prompt.make([systemMessage, ...]))` for initializing
  with a system message
- Show export/import: `chat.exportJson()` returns a JSON string,
  `Chat.fromExportedJson(json)` restores the chat

**Imports:** `Effect` + `Chat, LanguageModel, Prompt` from `effect/unstable/ai`

### 15. Cluster — `80_cluster/` (new section)

#### `index.md`

**Content:** Brief intro: The cluster modules provide distributed entity
management with sharding. Define entities as RPC services, distribute them across
runners, and communicate via entity proxies. Use `SingleRunner` for local
development and testing.

#### `10_entities.ts`

**Title:** Defining and running cluster entities

**Content:**

- Define entity RPCs: `const Increment = Rpc.make("Increment", { success:
  Schema.Number })` and `const GetCount = Rpc.make("GetCount", { success:
  Schema.Number })`
- Create entity: `const Counter = Entity.make("Counter", [Increment,
  GetCount])` — note: `Entity.make` takes an array of individual `Rpc`
  definitions, not an `RpcGroup`
- Implement handlers with `Counter.toLayer(Effect.gen(function*() { const count
  = yield* Ref.make(0); return Counter.of({ Increment: () => Ref.updateAndGet(
  count, (n) => n + 1), GetCount: () => Ref.get(count) }) }), { maxIdleTime:
  "5 minutes" })`
- Show client: `const client = yield* Counter.client` then
  `client("entity-123").Increment()` and `client("entity-123").GetCount()`
- Show `SingleRunner.layer` for local development (single-node sharding)
- Explain `maxIdleTime` for entity passivation

**Imports:** `Effect, Layer, Ref, Schema` + `Entity, SingleRunner` from
`effect/unstable/cluster` + `Rpc` from `effect/unstable/rpc`

#### `20_singletons.ts`

**Title:** Cluster singletons

**Content:**

- Define a singleton with `Singleton.make("cron-scheduler", Effect.gen(
  function*() { ... }))` — the effect runs as long as this runner owns the
  singleton's shard
- Explain that exactly one instance runs across the entire cluster
- Show composition: the singleton returns a `Layer` that must be provided to
  the sharding layer
- Mention `Sharding` service requirement

**Imports:** `Effect, Layer, Schedule` + `Singleton, Sharding` from
`effect/unstable/cluster`

### 16. Workflows — `81_workflow/` (new section)

#### `index.md`

**Content:** Brief intro: Durable workflows execute multi-step processes with
automatic persistence and resumption. Activities represent individual steps that
are retried and tracked independently. Requires a `WorkflowEngine` service.

#### `10_workflows.ts`

**Title:** Defining durable workflows

**Content:**

- Define activities with `Activity.make({ name: "chargePayment", success:
  Schema.Struct({ transactionId: Schema.String }), error:
  PaymentError, execute: Effect.gen(function*() { ... }) })` — note:
  `execute` is an `Effect`, not a handler function
- Define a workflow with `Workflow.make({ name: "order-processing", payload:
  OrderPayload, success: OrderResult, idempotencyKey: (payload) =>
  payload.orderId })` — note: `idempotencyKey` is required and maps payload to
  a deterministic string for deduplication
- Implement with `workflow.toLayer(function*(payload) { const payment =
  yield* chargePayment; const shipping = yield* shipOrder; return { ... } })`
  — activities implement `Effect.Yieldable` so they can be yielded directly
- Show `Activity.retry({ ...activity, times: 3 })` for configurable retry
- Show `workflow.execute(payload)` (returns execution result) and
  `workflow.poll(executionId)` (checks status without blocking)
- Mention `WorkflowEngine` and `ClusterWorkflowEngine` requirements

**Imports:** `Effect, Layer, Schema` + `Activity, Workflow` from
`effect/unstable/workflow`

## Dependency changes

Add to `ai-docs/package.json`:

- `"hono": "^4.0.0"` (for the ManagedRuntime + Hono integration example, Task
  5)
- `"@effect/vitest": "workspace:*"` (for the testing examples, Task 11)

## Implementation plan

Each task produces one or more files, passes all validation checks
independently, and can be merged on its own. Tasks are ordered so that
section-creating tasks come before tasks that add files to those sections, but
each task is independently shippable regardless of order.

### Task 1: Layers with side effects

**Files:**

- Create `ai-docs/src/01_effect/04_resources/20_layer-side-effects.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 2: LayerMap

**Files:**

- Create `ai-docs/src/01_effect/04_resources/30_layer-map.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 3: Running effects

**Files:**

- Create `ai-docs/src/01_effect/05_running/index.md`
- Create `ai-docs/src/01_effect/05_running/10_run-main.ts`
- Create `ai-docs/src/01_effect/05_running/20_layer-launch.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 4: Consuming streams

**Files:**

- Create `ai-docs/src/02_stream/20_consuming-streams.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 5: Integrating Effect (ManagedRuntime + Hono)

**Files:**

- Update `ai-docs/package.json` to add `"hono": "^4.0.0"` dependency
- Run `pnpm install`
- Create `ai-docs/src/03_integration/index.md`
- Create `ai-docs/src/03_integration/10_managed-runtime.ts`

**Validation:** `pnpm install && pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 6: ExecutionPlan

**Files:**

- Create `ai-docs/src/04_patterns/index.md`
- Create `ai-docs/src/04_patterns/10_execution-plan.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 7: Batching and RequestResolver

**Files:**

- Create `ai-docs/src/05_batching/index.md`
- Create `ai-docs/src/05_batching/10_request-resolver.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 8: Schedule

**Files:**

- Create `ai-docs/src/06_schedule/index.md`
- Create `ai-docs/src/06_schedule/10_schedules.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 9: Cache + PersistedCache

**Files:**

- Create `ai-docs/src/07_cache/index.md`
- Create `ai-docs/src/07_cache/10_cache.ts`
- Create `ai-docs/src/07_cache/20_persisted-cache.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 10: Observability — Logging + Otlp tracing

**Files:**

- Create `ai-docs/src/08_observability/index.md`
- Create `ai-docs/src/08_observability/10_logging.ts`
- Create `ai-docs/src/08_observability/20_otlp-tracing.ts`

**Note:** Combined into one task to ensure the section exists before adding both
files.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 11: Testing (all files)

**Files:**

- Update `ai-docs/package.json` to add `"@effect/vitest": "workspace:*"`
  dependency
- Run `pnpm install`
- Create `ai-docs/src/09_testing/index.md`
- Create `ai-docs/src/09_testing/10_effect-tests.ts`
- Create `ai-docs/src/09_testing/20_layer-tests.ts`

**Note:** Combined into one task because both `.ts` files require the
`@effect/vitest` dependency to be added first.

**Validation:** `pnpm install && pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 12: Observability — NodeSdk tracing

**Files:**

- Create `ai-docs/src/08_observability/30_node-sdk-tracing.ts`

**Note:** If Task 10 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 13: HttpApi servers

**Files:**

- Create `ai-docs/src/51_http-server/index.md`
- Create `ai-docs/src/51_http-server/10_http-api.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 14: Plain HttpEffect servers

**Files:**

- Create `ai-docs/src/51_http-server/20_http-effect.ts`

**Note:** If Task 13 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 15: RPC basics

**Files:**

- Create `ai-docs/src/60_rpc/index.md`
- Create `ai-docs/src/60_rpc/10_rpc-basics.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 16: RPC middleware and testing

**Files:**

- Create `ai-docs/src/60_rpc/20_rpc-middleware.ts`

**Note:** If Task 15 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 17: AI — LanguageModel

**Files:**

- Create `ai-docs/src/71_ai/index.md`
- Create `ai-docs/src/71_ai/10_language-model.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 18: AI — Tools and Toolkits

**Files:**

- Create `ai-docs/src/71_ai/20_tools.ts`

**Note:** If Task 17 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 19: AI — Chat sessions

**Files:**

- Create `ai-docs/src/71_ai/30_chat.ts`

**Note:** If Task 17 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 20: Cluster — Entities

**Files:**

- Create `ai-docs/src/80_cluster/index.md`
- Create `ai-docs/src/80_cluster/10_entities.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 21: Cluster — Singletons

**Files:**

- Create `ai-docs/src/80_cluster/20_singletons.ts`

**Note:** If Task 20 hasn't landed yet, also create `index.md` for the section.

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

### Task 22: Workflows

**Files:**

- Create `ai-docs/src/81_workflow/index.md`
- Create `ai-docs/src/81_workflow/10_workflows.ts`

**Validation:** `pnpm ai-docgen && pnpm lint-fix && pnpm check:tsgo`

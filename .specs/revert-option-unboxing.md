# Revert Option Unboxing

Revert APIs that currently return `A | undefined` back to `Option<A>`. The original
changes were introduced across four commits:

- `4257d918` - Unbox Option (#450)
- `e5588978` - unbox cluster (#468)
- `54514dfa` - unbox cli Options (#674)
- `07799bfe` - unbox Terminal.UserInput (#675)

## Scope

### In Scope

- Revert all public API return types from `A | undefined` back to `Option<A>`
- Revert interface/class fields from `A | undefined` back to `Option<A>`
- Revert function parameters from `A | undefined` back to `Option<A>` where they
  were part of the public API contract
- Revert `Schema.UndefinedOr(X)` back to `Schema.Option(X)` in cluster wire formats
- Revert `Effect.undefined` usages back to `Effect.succeedNone` where introduced
  by these commits
- Keep `CronParseError` as a `Data.TaggedError` class
- Restore `Number.divideUnsafe`
- Update all internal implementations to work with Option types
- Update all tests to use Option types
- Update all platform packages (platform-bun, platform-node, platform-node-shared)
- New functions added by the commits (`Array.findFirstWithIndex`, `Array.countBy`,
  `Iterable.countBy`, `Record.findFirst`) should also use `Option<A>` return types

### Out of Scope

- **Keep current function names** - Do NOT restore old dual-name APIs (e.g., keep
  `modify` instead of restoring `modify` + `modifyOption`; keep `Duration.fromInput`
  instead of restoring `decode` + `decodeUnknown`)
- **Keep `UndefinedOr.ts` module** - Do not remove or deprecate it
- **Keep semantic undefined References** - `UnhandledLogLevel`, `MaxBodySize`,
  `MaxParts`, `MaxFileSize`, `CurrentStackFrame`, `PreResponseHandlers` stay as
  `A | undefined`
- **Keep `Array.allocate`** - `Array<A | undefined>` return is intentional
- **Keep `Multipart.limitsServices` parameter types** as `| undefined` since the
  underlying References are staying as `| undefined`
- **Keep `Hash.combine` dual change** - unrelated to Option unboxing
- **Internal-only types** in cluster modules (`MessageStorage.ts` MemoryEntry, etc.)
  should be updated as needed to support the public API changes, but rewriting all
  internals to use Option is not required. Prefer minimal changes to internals - use
  `Option.getOrUndefined` or `Option.fromNullishOr` at boundaries between internal
  `| undefined` code and the public `Option` API where practical.
- **ServiceMap.ts** - The commit only reordered code; no `| undefined` return types
  were introduced. No revert needed.
- **Pool.ts** - Consumer of `UnhandledLogLevel` (which stays as `| undefined`). No
  revert needed.

## Transformation Patterns

When reverting, apply these patterns consistently:

### Type Signatures

| Current                     | Reverted                      |
| --------------------------- | ----------------------------- |
| `A \| undefined`            | `Option.Option<A>`            |
| `Effect<A \| undefined>`    | `Effect<Option.Option<A>>`    |
| `Effect<A \| undefined, E>` | `Effect<Option.Option<A>, E>` |

### Constructors

| Current                | Reverted             |
| ---------------------- | -------------------- |
| `undefined` (as value) | `Option.none()`      |
| `value` (direct)       | `Option.some(value)` |

### Checks

| Current                   | Reverted           |
| ------------------------- | ------------------ |
| `x === undefined`         | `Option.isNone(x)` |
| `x !== undefined`         | `Option.isSome(x)` |
| truthiness check `if (x)` | `Option.isSome(x)` |

### Access

| Current                    | Reverted                             |
| -------------------------- | ------------------------------------ |
| `x` (direct value)         | `x.value`                            |
| `x ?? default`             | `Option.getOrElse(x, () => default)` |
| `x ?? y` (fallback option) | `Option.orElse(x, () => y)`          |

### Combinators

| Current                                            | Reverted                              |
| -------------------------------------------------- | ------------------------------------- |
| `UndefinedOr.map(x, f)`                            | `Option.map(x, f)`                    |
| `UndefinedOr.match(x, { onUndefined, onDefined })` | `Option.match(x, { onNone, onSome })` |
| `UndefinedOr.liftThrowable(fn)`                    | `Option.liftThrowable(fn)`            |
| `UndefinedOr.getOrThrowWith(x, f)`                 | `Option.getOrThrowWith(x, f)`         |
| `arr.at(-1)`                                       | `Arr.last(arr)`                       |
| `arr.find(pred)`                                   | `Arr.findFirst(arr, pred)`            |

### Effect Combinators

| Current                                                     | Reverted                |
| ----------------------------------------------------------- | ----------------------- |
| `Effect.undefined`                                          | `Effect.succeedNone`    |
| `Effect.succeed(value)` (where it replaces `Effect.asSome`) | `Effect.asSome(effect)` |

### Schema

| Current                 | Reverted           |
| ----------------------- | ------------------ |
| `Schema.UndefinedOr(X)` | `Schema.Option(X)` |

### Regex/String

| Current                    | Reverted                          |
| -------------------------- | --------------------------------- |
| `RegExpMatchArray \| null` | `Option.Option<RegExpMatchArray>` |

## Affected Files

All paths are relative to `packages/effect/src/` unless otherwise noted. Files
that were in subdirectories at commit time have since been flattened to the
top-level `src/` directory.

### Core Effect Package (`packages/effect/src/`)

#### Collections

| File          | APIs to Revert                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Array.ts`    | `tail`, `init`, `findFirstIndex`, `findLastIndex`, `findFirstWithIndex` (new), `insertAt`, `replace`, `modify`, `unfold` callback |
| `Chunk.ts`    | `tail`, `modify`, `replace`, `findFirstIndex`, `findLastIndex`                                                                    |
| `HashMap.ts`  | `findFirst`                                                                                                                       |
| `Trie.ts`     | `longestPrefixOf`                                                                                                                 |
| `Graph.ts`    | `isAcyclic` field, `findNode`, `findEdge`, `getEdge`, `dijkstra`, `astar`, `bellmanFord`                                          |
| `Iterable.ts` | `unfold` callback, `countBy` (new)                                                                                                |
| `Record.ts`   | `modify`, `replace`, `pop`, `findFirst` (new)                                                                                     |

#### Primitives

| File            | APIs to Revert                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `Number.ts`     | `divide`, `parse`; restore `divideUnsafe`                                                |
| `BigInt.ts`     | `divide`, `sqrt`, `toNumber`, `fromString`, `fromNumber`                                 |
| `BigDecimal.ts` | `divide`, `remainder`, `fromNumber`, `fromString`                                        |
| `String.ts`     | `charCodeAt`, `at`, `charAt`, `codePointAt`, `indexOf`, `lastIndexOf`, `match`, `search` |

#### Time

| File          | APIs to Revert                                                                                |
| ------------- | --------------------------------------------------------------------------------------------- |
| `Duration.ts` | `fromInput` (currently returns `Duration \| undefined`), `toNanos`, `divide`                  |
| `DateTime.ts` | `makeZoned`, `make`, `makeZonedFromString`, `zoneMakeNamed`, `zoneFromString`, `setZoneNamed` |
| `Cron.ts`     | `tz` field                                                                                    |

#### Core Modules

| File             | APIs to Revert                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Deferred.ts`    | `poll`                                                                                                                               |
| `FiberHandle.ts` | `getUnsafe`, `get`                                                                                                                   |
| `FiberMap.ts`    | `getUnsafe`, `get`                                                                                                                   |
| `PubSub.ts`      | `remainingUnsafe`                                                                                                                    |
| `Tracer.ts`      | `Tracer.span` parent param, `Span.parent` field, `NativeSpan.parent`                                                                 |
| `Terminal.ts`    | `UserInput.input`                                                                                                                    |
| `FileSystem.ts`  | `File.readAlloc`, `File.Info` fields (mtime, atime, birthtime, ino, nlink, uid, gid, rdev, blksize, blocks), `WatchBackend.register` |
| `TxHashMap.ts`   | `findFirst`                                                                                                                          |

#### Explicitly No Change Needed

| File                | Reason                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `References.ts`     | `UnhandledLogLevel` stays as `A \| undefined` (semantic)                       |
| `ServiceMap.ts`     | No `\| undefined` return types introduced; only code reordering                |
| `Pool.ts`           | Consumer of `UnhandledLogLevel` which stays as `\| undefined`                  |
| `Cache.ts`          | Internal-only changes (`Duration.fromInputUnsafe` calls); no public API revert |
| `ScopedCache.ts`    | Internal-only changes; no public API revert                                    |
| `Schedule.ts`       | Internal-only changes (`Duration.fromInputUnsafe` calls); no public API revert |
| `Config.ts`         | Internal-only changes; no public API revert                                    |
| `Metric.ts`         | no public API revert                                                           |
| `DevToolsSchema.ts` | keep schemas aligned to Metric snapshots                                       |

#### Schema Consumers (updated as part of other tasks)

| File                      | Changes Needed                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SchemaTransformation.ts` | Consumer of `BigDecimal.fromString`, `Duration.toNanos`, `DateTime.zoneMakeNamed`, `DateTime.zoneFromString`, `DateTime.make`, `DateTime.makeZonedFromString` |
| `SchemaGetter.ts`         | Consumer of `DateTime.make`                                                                                                                                   |

#### HTTP Modules (`unstable/http/`)

| File                     | APIs to Revert                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| `Headers.ts`             | `get`                                                                  |
| `Cookies.ts`             | `get`, `getValue`                                                      |
| `UrlParams.ts`           | `getFirst`, `getLast`                                                  |
| `HttpClientRequest.ts`   | `hash` field, `toUrl`                                                  |
| `HttpClientResponse.ts`  | `remoteAddress`                                                        |
| `HttpIncomingMessage.ts` | `remoteAddress`; **KEEP** `MaxBodySize` as undefined                   |
| `HttpServerRequest.ts`   | `remoteAddress`, `toURL`                                               |
| `HttpServerError.ts`     | `causeResponseStripped` second tuple element                           |
| `HttpRouter.ts`          | `Route.prefix`                                                         |
| `HttpTraceContext.ts`    | Internal span parent handling                                          |
| `HttpMiddleware.ts`      | Internal consumer changes (TraceContext, Request.toURL, remoteAddress) |
| `HttpPlatform.ts`        | Internal consumer (FileSystem.File.Info.mtime)                         |
| `Etag.ts`                | Internal consumer (FileSystem.File.Info.mtime)                         |

#### Explicitly No HTTP Change Needed

| File            | Reason                                                        |
| --------------- | ------------------------------------------------------------- |
| `HttpEffect.ts` | `PreResponseHandlers` has been refactored; no longer relevant |
| `Multipart.ts`  | `MaxParts`, `MaxFileSize` stay as `\| undefined` (semantic)   |

#### HTTP API Modules (`unstable/httpapi/`)

| File                 | APIs to Revert                                                                   |
| -------------------- | -------------------------------------------------------------------------------- |
| `HttpApiEndpoint.ts` | `params`, `query`, `headers` fields                                              |
| `HttpApi.ts`         | `reflect` callback `successes`/`errors` map entries: `ast`, `description` fields |
| `HttpApiSchema.ts`   | Multipart/MultipartStream options                                                |
| `HttpApiBuilder.ts`  | Internal consumer changes                                                        |
| `HttpApiClient.ts`   | Internal consumer changes                                                        |
| `OpenApi.ts`         | Internal consumer changes                                                        |

#### RPC Modules (`unstable/rpc/`)

| File           | APIs to Revert                           |
| -------------- | ---------------------------------------- |
| `RpcSchema.ts` | `getStreamSchemas` (internal)            |
| `Rpc.ts`       | Internal changes                         |
| `RpcClient.ts` | Internal changes                         |
| `RpcServer.ts` | Internal changes (parent option passing) |

#### CLI Modules (`unstable/cli/`)

| File                                        | APIs to Revert                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Param.ts`                                  | `Single.description` field (renamed to just `description` on the `Param` interface), `Variadic.min`/`max` fields                                         |
| `Command.ts`                                | `withSubcommands` return type (subcommand field)                                                                                                         |
| `HelpDoc.ts`                                | description fields                                                                                                                                       |
| `Prompt.ts`                                 | `DatePart.nextPart`/`previousPart` return types, state error fields, `FileSelectState.startingPath`, `FileSelectState.path`, `UserInput.input` consumers |
| `internal/parser.ts`                        | `extractBuiltInOptions` return fields (`logLevel`, `completions`, `dynamicCompletions`)                                                                  |
| `internal/help.ts` (was `HelpFormatter.ts`) | Internal consumer changes                                                                                                                                |
| `Argument.ts`                               | Internal consumer changes                                                                                                                                |

Note: `internal/completions/shared.ts` no longer exists. The completion code was
refactored into `internal/completions/CommandDescriptor.ts`, `Completions.ts`,
`bash.ts`, `zsh.ts`, `fish.ts`. Check if any of these files still have
`| undefined` patterns from the original commit.

#### Cluster Modules (`unstable/cluster/`)

Note: `ShardManager.ts`, `ShardStorage.ts`, and `internal/shardManager.ts` were
**deleted** in a later commit. `ShardStorage.ts` was renamed to `RunnerStorage.ts`.

| File                                       | APIs to Revert                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Entity.ts`                                | `Request.lastSentChunk`, `Request.lastSentChunkValue`                                                                                                                                                    |
| `Message.ts`                               | `IncomingRequest.lastSentReply`, `IncomingRequestLocal.lastSentReply`, `OutgoingRequest.lastReceivedReply`                                                                                               |
| `MessageStorage.ts`                        | `requestIdForPrimaryKey` return, `SaveResult.Duplicate.lastReceivedReply`, `SaveResult.DuplicateEncoded.lastReceivedReply`, unprocessedMessages `lastSentReply`, `Schema.UndefinedOr` -> `Schema.Option` |
| `Reply.ts`                                 | `serializeLastReceived` return                                                                                                                                                                           |
| `Runners.ts`                               | `notify` address param                                                                                                                                                                                   |
| `ShardingConfig.ts`                        | `runnerAddress`, `runnerListenAddress`                                                                                                                                                                   |
| `RunnerStorage.ts` (was `ShardStorage.ts`) | Check for `getAssignments`, `saveAssignments` if applicable                                                                                                                                              |
| `Sharding.ts`                              | Internal consumer changes; also absorbed some ShardManager Rpcs (`Schema.UndefinedOr` -> `Schema.Option`)                                                                                                |
| `RunnerServer.ts`                          | Internal consumer changes                                                                                                                                                                                |
| `SqlMessageStorage.ts`                     | Internal consumer changes                                                                                                                                                                                |
| `ClusterWorkflowEngine.ts`                 | Internal consumer changes; implements WorkflowEngine interface                                                                                                                                           |
| `internal/entityManager.ts`                | Internal consumer changes                                                                                                                                                                                |

#### Workflow Modules (`unstable/workflow/`)

| File                 | APIs to Revert                         |
| -------------------- | -------------------------------------- |
| `WorkflowEngine.ts`  | `deferredResult` return, `poll` return |
| `DurableDeferred.ts` | Internal consumer changes              |
| `DurableClock.ts`    | Internal consumer changes              |

#### Observability (`unstable/observability/`)

| File                                                       | APIs to Revert                                         |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `OtlpTracer.ts`                                            | `makeSpan` parent param                                |
| `OtlpExporter.ts` (was `internal/tracing/otlpExporter.ts`) | Internal consumer (`Number.parse`, `Duration.toNanos`) |

#### Explicitly No Observability Change Needed

| File                   | Reason                                               |
| ---------------------- | ---------------------------------------------------- |
| `OtlpMetrics.ts`       | Consumer of SummaryState.quantiles which stays as-is |
| `PrometheusMetrics.ts` | Consumer of SummaryState.quantiles which stays as-is |

#### DevTools (`unstable/devtools/`)

| File                | Changes Needed                          |
| ------------------- | --------------------------------------- |
| `DevToolsClient.ts` | Internal consumer of Tracer.span parent |

#### AI Modules (`unstable/ai/`)

| File      | Changes Needed                   |
| --------- | -------------------------------- |
| `Chat.ts` | Consumer of `Duration.fromInput` |

#### Internal Files

| File                   | Changes Needed                                  |
| ---------------------- | ----------------------------------------------- |
| `internal/effect.ts`   | Consumer changes for poll, span parent handling |
| `internal/dateTime.ts` | Consumer changes                                |
| `internal/hashMap.ts`  | Consumer changes                                |
| `internal/trie.ts`     | Consumer changes                                |
| `internal/rcRef.ts`    | Consumer changes                                |

### Platform Packages

| File                                            | APIs to Revert              |
| ----------------------------------------------- | --------------------------- |
| `platform-bun/src/BunHttpServer.ts`             | `remoteAddress`             |
| `platform-bun/src/BunClusterHttp.ts`            | Config address handling     |
| `platform-node/src/NodeHttpClient.ts`           | `remoteAddress`             |
| `platform-node/src/NodeHttpIncomingMessage.ts`  | `remoteAddress`             |
| `platform-node/src/NodeClusterHttp.ts`          | Config address handling     |
| `platform-node-shared/src/NodeFileSystem.ts`    | File.Info fields, readAlloc |
| `platform-node-shared/src/NodeClusterSocket.ts` | Config address handling     |
| `platform-node-shared/src/NodeSocketServer.ts`  | Internal changes            |

### Other Packages

| File                           | Changes Needed                                                              |
| ------------------------------ | --------------------------------------------------------------------------- |
| `sql/mssql/src/MssqlClient.ts` | Consumer of `Duration.fromInputUnsafe` (no revert needed if name unchanged) |

### Test Files

All corresponding test files need updating. Key test files (verify paths exist
before editing):

- `packages/effect/test/Array.test.ts`
- `packages/effect/test/BigDecimal.test.ts`
- `packages/effect/test/BigInt.test.ts`
- `packages/effect/test/Chunk.test.ts`
- `packages/effect/test/DateTime.test.ts`
- `packages/effect/test/Deferred.test.ts`
- `packages/effect/test/Duration.test.ts`
- `packages/effect/test/Graph.test.ts`
- `packages/effect/test/HashMap.test.ts`
- `packages/effect/test/Number.test.ts`
- `packages/effect/test/Record.test.ts`
- `packages/effect/test/String.test.ts`
- `packages/effect/test/Tracer.test.ts`
- `packages/effect/test/TxHashMap.test.ts`
- `packages/effect/test/Cache.test.ts`
- `packages/effect/test/cluster/` - Entity, MessageStorage, Sharding, TestEntity
- `packages/effect/test/unstable/cli/` - Command, Prompt, Param, etc.
- `packages/effect/test/unstable/http/` - Cookies, Headers, HttpClient, etc.
- `packages/effect/test/unstable/observability/` - OtlpTracer, OtlpExporter
- `packages/effect/test/unstable/workflow/` - WorkflowEngine
- `packages/effect/test/rpc/` - Rpc tests
- `packages/effect/test/unstable/cli/services/MockTerminal.ts`
- `packages/platform-node/test/cluster/` - SqlRunnerStorage, SqlMessageStorage
- `packages/platform-node-shared/test/` - NodeFileSystem tests

Note: Test files that use `assertDefined`/`assertUndefined` should be updated to
use `assertSome`/`assertNone` (both already exist in `packages/vitest/src/utils.ts`).

## Implementation Plan

Each task must be independently shippable and pass all validation checks (typecheck,
lint, tests). Tasks are designed to minimize cross-task dependencies by including
all callers of changed APIs within the same task.

### Task 1: Core Primitives - Number, BigInt, BigDecimal + Schema Consumer

**Files:** `Number.ts`, `BigInt.ts`, `BigDecimal.ts`, `SchemaTransformation.ts`
(BigDecimal.fromString consumer) + test files

**Changes:**

- `Number.divide`: `number | undefined` -> `Option<number>`
- `Number.parse`: `number | undefined` -> `Option<number>`
- Restore `Number.divideUnsafe` (calls `divide` and unwraps with `Option.getOrThrow`)
- `BigInt.divide`: `bigint | undefined` -> `Option<bigint>`
- `BigInt.sqrt`: `bigint | undefined` -> `Option<bigint>`
- `BigInt.toNumber`: `number | undefined` -> `Option<number>`
- `BigInt.fromString`: `bigint | undefined` -> `Option<bigint>`
- `BigInt.fromNumber`: `bigint | undefined` -> `Option<bigint>`
- `BigDecimal.divide`: `BigDecimal | undefined` -> `Option<BigDecimal>`
- `BigDecimal.remainder`: `BigDecimal | undefined` -> `Option<BigDecimal>`
- `BigDecimal.fromNumber`: `BigDecimal | undefined` -> `Option<BigDecimal>`
- `BigDecimal.fromString`: `BigDecimal | undefined` -> `Option<BigDecimal>`
- Update `SchemaTransformation.ts` where it calls `BigDecimal.fromString` and
  checks `=== undefined`
- Update `OtlpExporter.ts` where it calls `Num.parse`
- Update all other callers of these functions within the same package
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Number.test && pnpm test BigInt.test && pnpm test BigDecimal.test`

### Task 2: String Module

**Files:** `String.ts` + test files

**Changes:**

- `charCodeAt`, `at`, `charAt`, `codePointAt`, `indexOf`, `lastIndexOf`, `search`:
  `X | undefined` -> `Option<X>`
- `match`: `RegExpMatchArray | null` -> `Option<RegExpMatchArray>`
- Update internal implementations
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test String.test`

### Task 3: Duration Module + All Callers

**Files:** `Duration.ts`, `internal/dateTime.ts`, `SchemaTransformation.ts`
(Duration.toNanos consumer), `Chat.ts` (Duration.fromInput consumer),
`RcMap.ts`, `ClusterCron.ts`, `DurableClock.ts`, `Cache.ts`, `ScopedCache.ts`,
`Schedule.ts`, `Config.ts` + test files

**Changes:**

- `Duration.fromInput`: `Duration | undefined` -> `Option<Duration>`
- `Duration.toNanos`: `bigint | undefined` -> `Option<bigint>`
- `Duration.divide`: `Duration | undefined` -> `Option<Duration>`
- Update `SchemaTransformation.ts` where it calls `Duration.toNanos` and checks
  `Predicate.isUndefined(nanos)`
- Update `Chat.ts` where it calls `Duration.fromInput(ttl)` and uses the
  `| undefined` result
- Update `RcMap.ts`, `ClusterCron.ts`, `DurableClock.ts` where they call
  `Duration.fromInputUnsafe`
- Update `Cache.ts`, `ScopedCache.ts`, `Schedule.ts`, `Config.ts` internal
  consumer changes
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Duration.test`

### Task 4: DateTime and Cron Modules + Schema Consumers

**Files:** `DateTime.ts`, `Cron.ts`, `internal/dateTime.ts`,
`SchemaTransformation.ts` (DateTime.* consumers), `SchemaGetter.ts`
(DateTime.make consumer) + test files

**Changes:**

- DateTime: `makeZoned`, `make`, `makeZonedFromString`, `zoneMakeNamed`,
  `zoneFromString`, `setZoneNamed` all from `X | undefined` -> `Option<X>`
- Cron `tz` field: `TimeZone | undefined` -> `Option<TimeZone>`
- Keep `CronParseError` as a `Data.TaggedError` class
- Update `SchemaTransformation.ts` where it calls `DateTime.zoneMakeNamed`,
  `zoneFromString`, `make`, `makeZonedFromString` and checks `=== undefined`
- Update `SchemaGetter.ts` where it calls `DateTime.make`
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test DateTime.test && pnpm test Cron.test`

### Task 5: Array, Iterable, and CLI Prompt Array Consumers

**Files:** `Array.ts`, `Iterable.ts`, `unstable/cli/Prompt.ts` (Array.findFirstIndex
consumer) + test files

**Changes:**

- Array: `tail`, `init`, `findFirstIndex`, `findLastIndex`, `findFirstWithIndex`,
  `insertAt`, `replace`, `modify` all from `X | undefined` -> `Option<X>`
- Array: `unfold` callback from `[A,B] | undefined` -> `Option<[A,B]>`
- Array: `countBy` (new) - returns `number`, not optional; no Option change needed
- Iterable: `unfold` callback from `[A,B] | undefined` -> `Option<[A,B]>`
- Iterable: `countBy` (new) - same as above
- Update `Prompt.ts` where it calls `Arr.findFirstIndex(...)` and uses `?? 0`
  pattern; change to `Option.getOrElse(..., () => 0)`
- Update test files

Note: Prompt.ts is also modified in Tasks 13/14 for CLI-specific changes. The
Array consumer changes here are limited to `findFirstIndex` call site updates.

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Array.test && pnpm test Iterable.test`

### Task 6: Chunk, HashMap, Trie, Graph, Record Modules

**Files:** `Chunk.ts`, `HashMap.ts`, `Trie.ts`, `Graph.ts`, `Record.ts`,
`internal/hashMap.ts`, `internal/trie.ts` + test files

**Changes:**

- Chunk: `tail`, `modify`, `replace`, `findFirstIndex`, `findLastIndex`
- HashMap: `findFirst`
- Trie: `longestPrefixOf`
- Graph: `isAcyclic` field, `findNode`, `findEdge`, `getEdge`, `dijkstra`, `astar`,
  `bellmanFord`
- Record: `modify`, `replace`, `pop`, `findFirst`
- Update internal implementations
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Chunk.test && pnpm test HashMap.test && pnpm test Trie.test && pnpm test Graph.test && pnpm test Record.test`

### Task 7: Core Effect Modules (Deferred, FiberHandle, FiberMap, PubSub, TxHashMap)

**Files:** `Deferred.ts`, `FiberHandle.ts`, `FiberMap.ts`, `PubSub.ts`,
`TxHashMap.ts`, `internal/effect.ts` + test files

**Changes:**

- Deferred: `poll` from `Effect<Effect<A,E> | undefined>` ->
  `Effect<Option<Effect<A,E>>>`
- FiberHandle: `getUnsafe`, `get`
- FiberMap: `getUnsafe`, `get`
- PubSub: `remainingUnsafe`
- TxHashMap: `findFirst` from `Effect<[K,V] | undefined>` ->
  `Effect<Option<[K,V]>>`
- Revert `Effect.undefined` usages to `Effect.succeedNone` in these files
- Update `internal/effect.ts` consumer code (poll implementation)
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Deferred.test && pnpm test FiberHandle.test && pnpm test FiberMap.test && pnpm test PubSub.test && pnpm test TxHashMap.test`

### Task 8: Tracer + All Span Consumers

This is a large cross-cutting task because `Span.parent` is used across many
modules. All consumers must be updated together.

**Files:** `Tracer.ts`, `internal/effect.ts` (span parent handling),
`unstable/http/HttpTraceContext.ts`, `unstable/http/HttpMiddleware.ts`,
`unstable/observability/OtlpTracer.ts`, `unstable/devtools/DevToolsClient.ts`,
`unstable/rpc/RpcServer.ts` (parent option passing) + test files

**Changes:**

- Tracer: `span` parent param, `Span.parent` field, `NativeSpan.parent`:
  `AnySpan | undefined` -> `Option<AnySpan>`
- Update `internal/effect.ts` span creation and `filterDisablePropagation`
- Update `HttpTraceContext.ts` where it accesses `span.parent`
- Update `HttpMiddleware.ts` where it passes parent to `withSpan`
- Update `OtlpTracer.ts` which implements the Tracer interface
- Update `DevToolsClient.ts` Tracer.span parent wrapping
- Update `RpcServer.ts` parent option passing
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Tracer.test`

### Task 9: FileSystem, Terminal + Platform Packages

**Files:** `FileSystem.ts`, `Terminal.ts`, `unstable/http/Etag.ts` (mtime consumer),
`unstable/http/HttpPlatform.ts` (mtime consumer),
`platform-node-shared/src/NodeFileSystem.ts`,
`platform-bun/src/BunHttpServer.ts`,
`platform-node/src/NodeHttpClient.ts`,
`platform-node/src/NodeHttpIncomingMessage.ts`,
`platform-node-shared/src/NodeSocketServer.ts` + test files

**Changes:**

- FileSystem: `File.readAlloc`, `File.Info` fields (mtime, atime, birthtime, ino,
  nlink, uid, gid, rdev, blksize, blocks), `WatchBackend.register`
- Terminal: `UserInput.input`
- Update `Etag.ts` and `HttpPlatform.ts` where they access `info.mtime`
- Update `NodeFileSystem.ts` File.Info fields wrapping
- Update `BunHttpServer.ts` remoteAddress
- Update `NodeHttpClient.ts`, `NodeHttpIncomingMessage.ts` remoteAddress
- Update `NodeSocketServer.ts` internal changes
- Update test files (MockTerminal.ts, platform test files)

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test FileSystem && pnpm test Prompt.test`

### Task 10: HTTP Modules

Depends on: Task 8 (Tracer.Span.parent), Task 9 (FileSystem.File.Info, Terminal)

**Files:** `unstable/http/Headers.ts`, `Cookies.ts`, `UrlParams.ts`,
`HttpClientRequest.ts`, `HttpClientResponse.ts`, `HttpIncomingMessage.ts`,
`HttpServerRequest.ts`, `HttpServerError.ts`, `HttpRouter.ts` + test files

**Changes:**

- Headers.get: `string | undefined` -> `Option<string>`
- Cookies.get/getValue: `X | undefined` -> `Option<X>`
- UrlParams.getFirst/getLast: `string | undefined` -> `Option<string>`
- HttpClientRequest.hash: `string | undefined` -> `Option<string>`
- HttpClientRequest.toUrl: `URL | undefined` -> `Option<URL>`
- HttpClientResponse.remoteAddress: `string | undefined` -> `Option<string>`
- HttpIncomingMessage.remoteAddress: `string | undefined` -> `Option<string>`
  (KEEP MaxBodySize as undefined)
- HttpServerRequest.remoteAddress, toURL
- HttpServerError.causeResponseStripped second tuple element
- HttpRouter.Route.prefix: `string | undefined` -> `Option<string>`
- Update HttpMiddleware.ts consumer changes (already partially done in Task 8)
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test unstable/http`

### Task 11: HTTP API Modules

Depends on: Task 10 (HTTP types)

**Files:** `unstable/httpapi/HttpApiEndpoint.ts`, `HttpApi.ts`, `HttpApiSchema.ts`,
`HttpApiBuilder.ts`, `HttpApiClient.ts`, `OpenApi.ts` + test files

**Changes:**

- HttpApiEndpoint: `params`, `query`, `headers` fields
- HttpApi: `reflect` callback types
- HttpApiSchema: Multipart options
- Update all internal consumers
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test HttpApi`

### Task 12: RPC Modules

Depends on: Task 8 (Tracer.Span.parent already done)

**Files:** `unstable/rpc/RpcSchema.ts`, `Rpc.ts`, `RpcClient.ts` + test files

**Changes:**

- RpcSchema: `getStreamSchemas` return type
- Internal consumer changes in Rpc, RpcClient
- Update test files

Note: `RpcServer.ts` parent handling already done in Task 8.

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Rpc`

### Task 13: CLI Modules + Terminal.UserInput Consumers

Combined from original Tasks 13+14. `Prompt.ts` is shared, and Terminal.UserInput
changes affect Prompt.ts directly.

**Files:** `unstable/cli/Param.ts`, `Command.ts`, `HelpDoc.ts`, `Prompt.ts`,
`Argument.ts`, `internal/parser.ts`, `internal/help.ts` (was HelpFormatter.ts),
`Terminal.ts` (UserInput only, if not done in Task 9) + test files

**Changes:**

- Param: `Param.description` field, `Variadic.min`/`max`
- Command: `withSubcommands` subcommand field in return type
- HelpDoc: description fields
- Prompt: DatePart return types, state error fields, file path fields, all
  `input.input ?? ""` -> `Option.getOrElse(input.input, () => "")`
- Internal parser: extractBuiltInOptions fields
- internal/help.ts: consumer changes
- Update MockTerminal in tests
- Update test files

Note: `Terminal.UserInput.input` type change is done in Task 9. This task handles
all the CLI consumer code that uses it.

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Prompt.test && pnpm test Command.test`

### Task 14: Cluster + Workflow Modules (Combined)

Combined because `ClusterWorkflowEngine.ts` implements `WorkflowEngine` interface.
Changing `poll`/`deferredResult` return types requires updating the implementation
simultaneously.

**Files:**

- Cluster: `Entity.ts`, `Message.ts`, `MessageStorage.ts`, `Reply.ts`, `Runners.ts`,
  `ShardingConfig.ts`, `RunnerStorage.ts`, `Sharding.ts`, `RunnerServer.ts`,
  `SqlMessageStorage.ts`, `ClusterWorkflowEngine.ts`, `internal/entityManager.ts`
- Workflow: `WorkflowEngine.ts`, `DurableDeferred.ts`, `DurableClock.ts`
- Platform: `platform-bun/src/BunClusterHttp.ts`,
  `platform-node/src/NodeClusterHttp.ts`,
  `platform-node-shared/src/NodeClusterSocket.ts`
- Test files

**Changes:**

- All cluster public API types (see Affected Files section)
- Schema.UndefinedOr -> Schema.Option for wire formats
- WorkflowEngine: `deferredResult`, `poll` return types
- DurableDeferred, DurableClock: internal consumer changes
- Platform cluster config: `config.runnerListenAddress.pipe(Option.orElse(...))`
  instead of `??`
- Update all internal consumer code
- Update test files

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test cluster && pnpm test Workflow`

### Task 15: Observability Module Consumers

Depends on: Task 8 (Tracer already done)

**Files:** `unstable/observability/OtlpExporter.ts` + test files

**Changes:**

- Update `OtlpExporter.ts` where it consumes `Number.parse` (already done in
  Task 1 if needed), `Duration.toNanos`, and uses `UndefinedOr.map`
- Update test files if any

Note: `OtlpTracer.ts` is already handled in Task 8. `OtlpMetrics.ts` and
`PrometheusMetrics.ts` have no changes needed (Metric snapshots stay as-is).

**Validation:** `pnpm check:tsgo && pnpm lint-fix && pnpm test Otlp`

### Task 16: JSDoc Updates and Codegen

**Files:** All files modified in previous tasks

**Changes:**

- Update JSDoc examples that show `| undefined` patterns to use Option patterns
- Run `pnpm docgen` to verify all JSDoc examples compile
- Run `pnpm codegen` to regenerate barrel files if needed
- Create changeset entries

**Validation:** `pnpm docgen && pnpm codegen && pnpm check:tsgo && pnpm lint-fix`

## Validation Checklist

After all tasks are complete:

1. `pnpm lint-fix` - all files formatted
2. `pnpm check:tsgo` - type checking passes (run `pnpm clean` first if needed)
3. `pnpm test` - all tests pass
4. `pnpm docgen` - JSDoc examples compile
5. `pnpm codegen` - barrel files up to date

## Notes

- File paths in the commits used subdirectory structure (e.g.,
  `src/collections/Array.ts`, `src/primitives/Number.ts`, `src/time/Duration.ts`,
  `src/data/Record.ts`, `src/caching/Cache.ts`, `src/platform/Terminal.ts`,
  `src/platform/FileSystem.ts`). These have since been flattened to
  `src/Array.ts`, `src/Number.ts`, `src/Duration.ts`, `src/Record.ts`,
  `src/Cache.ts`, `src/Terminal.ts`, `src/FileSystem.ts` etc.
- The `unstable/` subdirectories remain at their original paths.
- **Deleted files**: `ShardManager.ts`, `ShardStorage.ts` (now `RunnerStorage.ts`),
  and `internal/shardManager.ts` were deleted in a later commit. Do not attempt
  to modify them.
- **Renamed files**: `HelpFormatter.ts` -> `internal/help.ts`;
  `internal/completions/shared.ts` was refactored into multiple completion files;
  `BunClusterRunnerHttp.ts` -> `BunClusterHttp.ts`;
  `NodeClusterRunnerHttp.ts` -> `NodeClusterHttp.ts`;
  `NodeClusterRunnerSocket.ts` -> `NodeClusterSocket.ts`;
  `internal/tracing/otlpExporter.ts` -> `unstable/observability/OtlpExporter.ts`
- Do NOT use the previous PRs as reference - they were done incorrectly.
- When in doubt about whether a specific `| undefined` was introduced by these
  commits, check `git blame` or the commit diffs.
- `Duration.fromInput` is the current name (was `decodeUnknown` before rename in
  the Unbox commit, then renamed again later). `Duration.fromInputUnsafe` is the
  throwing variant (was `decode` before the Unbox commit).

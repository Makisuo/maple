# Filter: Separate APIs Instead of Overloaded Functions

## Summary

Reverse the overloaded-function consolidation from PR #1253 (Phase 4/5 of
`.specs/filter-refactor.md`). Instead of a single `filter` function accepting
both predicates and `Filter.Filter`, provide **separate named functions** for
each. Remove `Filter.apply` and its type helpers since they only existed to
normalize boolean/Result returns in the overloaded implementations. Convert all
remaining Option-based `filterMap` APIs to use `Filter.Filter`.

Update (EFF-594): partition APIs are now Filter-only. `partitionFilter`,
`partitionFilterEffect`, and `partitionQueueFilter` are renamed to
`partition`, `partitionEffect`, and `partitionQueue`, and predicate/refinement
partition variants are removed.

## Motivation

The overloaded approach has drawbacks:

1. **Type inference** — TypeScript struggles with overload resolution when the
   callback could be a predicate or a Filter, requiring `as any` casts at
   internal call sites.
2. **Discoverability** — separate named functions are easier to find in docs and
   autocomplete.
3. **Simplicity** — each function has one clear purpose instead of branching on
   return type at runtime.
4. **Consistency** — all `filterMap` APIs should uniformly accept `Filter.Filter`
   instead of a mix of `Option` and `Filter`.

## Goals

- Split every overloaded API that accepts both predicates and `Filter` into two
  separate functions.
- For partition APIs (`Array.partition`, `Stream.partition`,
  `Stream.partitionEffect`, `Stream.partitionQueue`), remove predicate-only
  variants and require `Filter` / `FilterEffect`.
- Add back `catchFilter`, `catchCauseFilter`, `tapCauseFilter`, `onExitFilter`,
  `onErrorFilter` as standalone Filter-accepting APIs.
- Remove `Filter.apply`, `OrPredicate`, `ResultOrBool`, `Pass`, `Fail`,
  `ApplyResult` from `Filter.ts`.
- Convert all Option-based `filterMap` functions to accept `Filter.Filter`
  instead of `(a) => Option<B>`.

## Non-goals

- No changes to `Filter` constructors or combinators (`make`, `fromPredicate`,
  `compose`, `zip`, etc.).
- No changes to `Filter.FilterEffect` beyond removing it from overloaded APIs.
- No renaming of existing predicate-only APIs outside the partition family.
- Graph APIs (`filterMapNodes`, `filterMapEdges`) — out of scope.
- CLI module APIs (`Param.filterMap`, `Argument.filterMap`, `Flag.filterMap`) —
  different pattern with `onNone` error handler, out of scope.

## Naming Convention

- **`filterMap`** — standalone filter-and-map operations (well-known FP name).
- **`*Filter` suffix** — alternative to an existing predicate API, except for
  the partition family (which uses base names and is Filter-only).

## API Changes

### APIs to Add / Finalize

| Module  | New API                 | Accepts                              | Returns (simplified)                             |
| ------- | ----------------------- | ------------------------------------ | ------------------------------------------------ |
| Array   | `filterMap`             | `Filter<A, B, X, [i: number]>`       | `Array<B>`                                       |
| Array   | `partition`             | `Filter<A, Pass, Fail, [i: number]>` | `[Array<Fail>, Array<Pass>]`                     |
| Array   | `takeWhileFilter`       | `Filter<A, B, X, [i: number]>`       | `Array<B>`                                       |
| Array   | `dropWhileFilter`       | `Filter<A, B, X, [i: number]>`       | `Array<A>`                                       |
| Effect  | `filterMap`             | `Filter<A, B, X>`                    | `Effect<Array<B>>`                               |
| Effect  | `filterMapEffect`       | `FilterEffect<A, B, …>`              | `Effect<Array<B>, E, R>`                         |
| Effect  | `filterMapOrElse`       | `Filter<A, B, X>`                    | `Effect<B \| C, …>`                              |
| Effect  | `filterMapOrFail`       | `Filter<A, B, X>`                    | `Effect<B, E2 \| E, R>`                          |
| Effect  | `catchFilter`           | `Filter<E, Pass, Fail>`              | `Effect<A \| A2, …>`                             |
| Effect  | `catchCauseFilter`      | `Filter<Cause, Pass, …>`             | `Effect<A \| B, …>`                              |
| Effect  | `tapCauseFilter`        | `Filter<Cause, Pass, …>`             | `Effect<A, E, R>`                                |
| Effect  | `onExitFilter`          | `Filter<Exit, Pass, …>`              | `Effect<A, E, R>`                                |
| Effect  | `onErrorFilter`         | `Filter<Cause, Pass, …>`             | `Effect<A, E, R>`                                |
| Stream  | `filterMap`             | `Filter<A, B, X>`                    | `Stream<B, E, R>`                                |
| Stream  | `filterMapEffect`       | `FilterEffect<A, B, …>`              | `Stream<B, E \| E2, R \| R2>`                    |
| Stream  | `partition`             | `Filter<A, Pass, Fail>`              | `Effect<[Stream<Fail>, Stream<Pass>], …, Scope>` |
| Stream  | `partitionEffect`       | `FilterEffect<A, P, F, …>`           | `Effect<[Stream<F>, Stream<P>], …, Scope>`       |
| Stream  | `partitionQueue`        | `Filter<A, Pass, Fail>`              | scoped queue-based partition                     |
| Stream  | `takeWhileFilter`       | `Filter<A, B, X>`                    | `Stream<B, E, R>`                                |
| Stream  | `dropWhileFilter`       | `Filter<A, B, X>`                    | `Stream<A, E, R>`                                |
| Stream  | `catchFilter`           | `Filter<E, Pass, Fail>`              | `Stream<A \| A2, …>`                             |
| Stream  | `catchCauseFilter`      | `Filter<Cause, Pass, …>`             | `Stream<A \| B, …>`                              |
| Channel | `filterMap`             | `Filter<Elem, B, X>`                 | `Channel<B, …>`                                  |
| Channel | `filterMapEffect`       | `FilterEffect<Elem, …>`              | `Channel<B, …>`                                  |
| Channel | `filterMapArray`        | `Filter<A, B, X>`                    | `Channel<B, …>`                                  |
| Channel | `filterMapArrayEffect`  | `FilterEffect<A, B, …>`              | `Channel<B, …>`                                  |
| Channel | `catchFilter`           | `Filter<E, Pass, Fail>`              | `Channel<…>`                                     |
| Channel | `catchCauseFilter`      | `Filter<Cause, Pass, …>`             | `Channel<…>`                                     |
| Sink    | `takeWhileFilter`       | `Filter<A, B, X>`                    | `Sink<Chunk<B>, …>`                              |
| Sink    | `takeWhileFilterEffect` | `FilterEffect<A, B, …>`              | `Sink<Chunk<B>, …>`                              |

All new APIs support both data-first and data-last (dual) where the original
overloaded API did.

### Overloads to Remove

Remove the `Filter`/`OrPredicate`/`FilterEffect` overloads from predicate-first
functions. For the partition family (`Array.partition`, `Stream.partition`,
`Stream.partitionEffect`, `Stream.partitionQueue`), remove predicate/refinement
variants and keep only Filter-based signatures:

| Module  | Function            | Remove overload accepting                         |
| ------- | ------------------- | ------------------------------------------------- |
| Array   | `filter`            | `Filter.Filter<A, B, X>`                          |
| Array   | `partition`         | `Predicate`, `Refinement`                         |
| Array   | `takeWhile`         | `Filter.Filter<A, B, X>`                          |
| Array   | `dropWhile`         | `Filter.Filter<A, B, X>`                          |
| Effect  | `filter`            | `Filter.Filter`, `Filter.FilterEffect`            |
| Effect  | `filterOrElse`      | `Filter.OrPredicate`                              |
| Effect  | `filterOrFail`      | `Filter.Filter`                                   |
| Effect  | `catchIf`           | `Filter.OrPredicate`                              |
| Effect  | `catchCauseIf`      | `Filter.OrPredicate`                              |
| Effect  | `tapCauseIf`        | `Filter.OrPredicate`                              |
| Effect  | `onExitIf`          | `Filter.OrPredicate`                              |
| Effect  | `onErrorIf`         | `Filter.OrPredicate`                              |
| Stream  | `filter`            | `Filter.OrPredicate`                              |
| Stream  | `filterEffect`      | `Filter.FilterEffect`                             |
| Stream  | `partition`         | `Predicate`, `Refinement`                         |
| Stream  | `partitionEffect`   | effectful predicate `(a) => Effect<boolean, ...>` |
| Stream  | `partitionQueue`    | `Predicate`, `Refinement`                         |
| Stream  | `takeWhile`         | `Filter.Filter`                                   |
| Stream  | `dropWhile`         | `Filter.Filter`                                   |
| Stream  | `catchIf`           | `Filter.OrPredicate`                              |
| Stream  | `catchCauseIf`      | `Filter.OrPredicate`                              |
| Channel | `filter`            | `Filter.OrPredicate`                              |
| Channel | `filterEffect`      | `Filter.FilterEffect`                             |
| Channel | `filterArray`       | `Filter.OrPredicate`                              |
| Channel | `filterArrayEffect` | `Filter.FilterEffect`                             |
| Channel | `catchIf`           | `Filter.OrPredicate`                              |
| Channel | `catchCauseIf`      | `Filter.OrPredicate`                              |
| Sink    | `takeWhile`         | `Filter.Filter`                                   |
| Sink    | `takeWhileEffect`   | `Filter.FilterEffect`                             |

### Filter.ts Removals

Remove the following exports:

- `apply` — function
- `OrPredicate` — type alias
- `ResultOrBool` — type alias
- `Pass` — type helper
- `Fail` — type helper
- `ApplyResult` — type helper

These only exist to normalize boolean/Result returns in the overloaded
implementations. With separate APIs, each implementation directly handles its
expected input type.

### Option-based filterMap Conversions

Convert all `filterMap` APIs that currently accept `(a) => Option<B>` to accept
`Filter.Filter<A, B, X>` instead. The function returns `Result.Result<B, X>`
where `Result.succeed` = keep (equivalent to `Some`) and `Result.failVoid` =
discard (equivalent to `None`).

| Module    | Function         | Old signature                    | New signature                    |
| --------- | ---------------- | -------------------------------- | -------------------------------- |
| Chunk     | `filterMap`      | `(a: A, i: number) => Option<B>` | `Filter<A, B, X, [i: number]>`   |
| Chunk     | `filterMapWhile` | `(a: A) => Option<B>`            | `Filter<A, B, X>`                |
| Iterable  | `filterMap`      | `(a: A, i: number) => Option<B>` | `Filter<A, B, X, [i: number]>`   |
| Iterable  | `filterMapWhile` | `(a: A, i: number) => Option<B>` | `Filter<A, B, X, [i: number]>`   |
| HashMap   | `filterMap`      | `(v: A, k: K) => Option<B>`      | `Filter<A, B, X, [key: K]>`      |
| Record    | `filterMap`      | `(a: A, k: K) => Option<B>`      | `Filter<A, B, X, [key: K]>`      |
| Trie      | `filterMap`      | `(v: A, k: string) => Option<B>` | `Filter<A, B, X, [key: string]>` |
| Option    | `filterMap`      | `(a: A) => Option<B>`            | `Filter<A, B, X>`                |
| TxHashMap | `filterMap`      | `(v: A, k: K) => Option<A>`      | `Filter<A, B, X, [key: K]>`      |

**Design notes:**

- **Extra arguments are preserved via `Filter`'s `Args` type parameter.**
  `Filter<A, B, X, [i: number]>` expands to `(input: A, i: number) =>
  Result<B, X>`. This is not a breaking change for callers who used the
  index/key parameter — they simply switch from returning `Option` to returning
  `Result`.
- **Key-value collections** (HashMap, Record, Trie, TxHashMap): the Filter
  receives the **value** as the first argument and the **key** as an extra
  argument. The key is preserved in the output collection unchanged.
- **`Option.filterMap`** was previously an alias for `flatMap`. With Filter, it
  becomes: apply the filter to the inner value, return `Some(pass)` on success,
  `None` on failure.

### Convenience Functions Affected by Option-to-Filter Conversion

These functions delegate to `filterMap` with Option-returning callbacks and must
be rewritten:

| Module   | Function       | Current implementation            | Required change            |
| -------- | -------------- | --------------------------------- | -------------------------- |
| Iterable | `getSomes`     | `filterMap(identity)` on `Option` | Rewrite with explicit loop |
| Iterable | `getFailures`  | `filterMap(Result.getFailure)`    | Rewrite with explicit loop |
| Iterable | `getSuccesses` | `filterMap(Result.getSuccess)`    | Rewrite with explicit loop |
| Chunk    | `compact`      | `filterMap(identity)` on `Option` | Rewrite with explicit loop |
| Record   | `getSomes`     | delegates to `filterMap`          | Rewrite with explicit loop |

**Strategy:** Rewrite each with an explicit loop, matching the pattern
`Array.getSomes` already uses.

### Internal Implementation Changes

All internal implementations that use `Filter.apply(filter, input)` must be
updated:

- **Predicate-only functions** (`filter`, `catchIf`, etc.): use boolean return
  directly.
- **Filter-only functions** (`filterMap`, `catchFilter`, etc.): call the Filter
  directly and check `Result.isSuccess`/`Result.isFailure`, extracting
  `.success`/`.failure`.

Note: `Array.partition` does NOT use `Filter.apply` — it has inline
`true`/`false`/`Result.isSuccess` branching. This inline branching must also be
split when removing the Filter overload.

Affected internal files:

- `packages/effect/src/internal/effect.ts`
- `packages/effect/src/Array.ts`
- `packages/effect/src/Stream.ts`
- `packages/effect/src/Channel.ts`
- `packages/effect/src/Sink.ts`
- `packages/effect/src/Chunk.ts`
- `packages/effect/src/Iterable.ts`
- `packages/effect/src/Cache.ts` (calls `Iterable.filterMap` with Option lambdas)
- `packages/effect/src/internal/hashMap.ts`
- `packages/effect/src/internal/trie.ts`

Internal filter functions (`findError`, `findDefect`, `findDie`,
`findInterrupt`, `causeFilterInterruptors`, `exitFilterSuccess`, etc.) are
already `Filter.Filter` and do not need changes. Only their **consumption sites**
(which currently use `Filter.apply`) need updating.

### Unchanged Modules

These modules are unaffected:

- **FiberSet, FiberHandle, FiberMap** — use `Filter.compose`,
  `Filter.toPredicate`, `Filter.has` internally (none removed).
- **Pull** — uses `Filter.composePassthrough` and `Filter.fromPredicate`
  (neither removed). Update if any `Filter.apply` usage exists.
- **Array.getSomes** — already uses an explicit loop, unaffected.

### Call Site Updates

All internal call sites that pass a `Filter` to a now-predicate-only function
must switch to the new Filter-specific function:

```ts
// Before:
Stream.filter(stream, myFilter)

// After:
Stream.filterMap(stream, myFilter)
```

```ts
// Before:
Effect.catchIf(program, myFilter, handler)

// After:
Effect.catchFilter(program, myFilter, handler)
```

```ts
// Before (Option-based):
Chunk.filterMap(chunk, (a, i) => a > 0 ? Option.some(a * 2) : Option.none())

// After (Filter-based, index preserved as extra arg):
Chunk.filterMap(chunk, (a, i) => a > 0 ? Result.succeed(a * 2) : Result.failVoid)
```

### Downstream / External Call Sites

These unstable modules use `catchIf`, `catchCauseIf`, or similar APIs with
Filter-style callbacks and must be updated:

- `packages/effect/src/unstable/socket/Socket.ts`
- `packages/effect/src/unstable/cli/Command.ts`
- `packages/effect/src/unstable/encoding/Sse.ts`
- `packages/effect/src/unstable/rpc/RpcServer.ts`
- `packages/effect/src/unstable/cluster/Sharding.ts`
- `packages/effect/src/unstable/cluster/K8sHttpClient.ts` (4 `Effect.catchIf`
  call sites with Result-returning lambdas)

These modules must switch from the overloaded API to the new Filter-specific API
(e.g., `catchIf` → `catchFilter`).

Modules that use plain boolean predicates with `catchIf` (e.g.,
`SqlEventLogJournal.ts`) are unaffected.

## Testing

- Update existing tests that use Filter overloads on `filter`, `partition`,
  `catchIf`, etc. to use the new separate APIs.
- Update tests for Option-based `filterMap` to use `Filter`/`Result` instead.
- Add new tests for each new API:
  - Verify `filterMap` with a `Filter.Filter` that transforms values.
  - Verify `partition` separates pass/fail correctly with typed outputs.
  - Verify `catchFilter` catches errors matched by a Filter.
  - etc.
- Use `it.effect` from `@effect/vitest` and `assert` (not `expect`).

## Validation

After each task:

- `pnpm lint-fix`
- `pnpm test <relevant test files>`
- `pnpm check:tsgo` (run `pnpm clean` first if type checking fails spuriously)

Final validation:

- `pnpm codegen` (regenerate barrel files)
- `pnpm lint-fix`
- `pnpm check:tsgo`
- `pnpm test`
- `pnpm docgen`

## Implementation Plan

### Task 1: Channel — Add separate Filter APIs, remove Filter overloads

**Files:** `packages/effect/src/Channel.ts`, `packages/effect/test/Channel.test.ts`

**Why first:** Channel is a dependency for Stream, Sink, and Array (via
`Channel.filterArray` which internally calls `Array.partition`). Must be done
before Array, Stream, and Sink tasks.

1. Add `filterMap`, `filterMapEffect`, `filterMapArray`,
   `filterMapArrayEffect`.
2. Add `catchFilter`, `catchCauseFilter`.
3. Remove Filter/OrPredicate overloads from `filter`, `filterEffect`,
   `filterArray`, `filterArrayEffect`, `catchIf`, `catchCauseIf`.
4. Update implementations — remove `Filter.apply` usage, use direct
   boolean/Result checks.
5. Update Channel tests.
6. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Channel.test.ts && pnpm check:tsgo`

### Task 2: Array — Add separate Filter APIs, remove Filter overloads

**Files:** `packages/effect/src/Array.ts`, `packages/effect/test/Array.test.ts`

**Depends on:** Task 1 (Channel.filterArray calls `Array.partition` internally;
after Task 1 the Filter path goes through `Channel.filterMapArray` instead).

1. Add `filterMap(f: Filter<A, B, X, [i: number]>): Array<B>` — iterate, call
   filter with element and index, push `result.success` values. Dual
   (data-last + data-first).
2. Change `partition` to `partition(f: Filter<A, Pass, Fail, [i: number]>): [Array<Fail>,
    Array<Pass>]` — iterate, split on `Result.isSuccess`. Dual.
3. Add `takeWhileFilter(f: Filter<A, B, X, [i: number]>): Array<B>` — take
   prefix while filter succeeds, collect `.success` values. Dual.
4. Add `dropWhileFilter(f: Filter<A, B, X, [i: number]>): Array<A>` — drop
   prefix while filter succeeds, keep remaining original values. Dual.
5. Remove predicate / refinement overloads from `partition` and remove
   `partitionFilter`; keep `Filter.Filter<A, B, X>` overload removals from `filter`,
   `takeWhile`, `dropWhile`.
6. Update implementations: `filter`/`takeWhile`/`dropWhile` use boolean checks
   directly; `partition` uses `Result.isSuccess` / `Result.isFailure` only.
7. Update all Array tests: change any test using `Array.filter(items, aFilter)`
   to `Array.filterMap(items, aFilter)`, etc.
8. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Array.test.ts && pnpm check:tsgo`

### Task 3: Effect — Add separate Filter APIs, remove Filter overloads

**Files:** `packages/effect/src/Effect.ts`, `packages/effect/src/internal/effect.ts`,
`packages/effect/test/Effect/` (multiple test files), unstable modules

This task must be atomic — removing Filter overloads from `catchIf` etc.
immediately breaks 6+ unstable modules, so unstable module updates cannot be
deferred.

1. Add `filterMap`, `filterMapEffect` — filter over iterables using
   `Filter`/`FilterEffect`.
2. Add `filterMapOrElse` — apply Filter to success value, call orElse on fail.
3. Add `filterMapOrFail` — apply Filter to success value, fail with error on
   fail.
4. Add `catchFilter` — catch errors matched by a Filter. Include optional
   `orElse` parameter.
5. Add `catchCauseFilter` — catch causes matched by a Filter.
6. Add `tapCauseFilter` — tap causes matched by a Filter.
7. Add `onExitFilter` — run finalizer when exit matches a Filter.
8. Add `onErrorFilter` — run finalizer when cause matches a Filter.
9. Remove Filter/OrPredicate overloads from `filter`, `filterOrElse`,
   `filterOrFail`, `catchIf`, `catchCauseIf`, `tapCauseIf`, `onExitIf`,
   `onErrorIf`.
10. Update `internal/effect.ts` implementations — split predicate/Filter code
    paths, remove `Filter.apply` usage.
11. Update all call sites in unstable modules that pass Filters to
    now-predicate-only APIs:
    - `packages/effect/src/unstable/socket/Socket.ts`
    - `packages/effect/src/unstable/cli/Command.ts`
    - `packages/effect/src/unstable/encoding/Sse.ts`
    - `packages/effect/src/unstable/rpc/RpcServer.ts`
    - `packages/effect/src/unstable/cluster/Sharding.ts`
    - `packages/effect/src/unstable/cluster/K8sHttpClient.ts`
12. Update Effect tests.
13. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Effect/ && pnpm check:tsgo`

### Task 4: Stream — Add separate Filter APIs, remove Filter overloads

**Files:** `packages/effect/src/Stream.ts`, `packages/effect/test/Stream/`
(multiple test files)

**Depends on:** Task 1 (Stream delegates to Channel.filterArray /
Channel.filterMapArray internally).

1. Add `filterMap`, `filterMapEffect`.
2. Rename `partitionFilter`, `partitionFilterEffect`, and
   `partitionQueueFilter` to `partition`, `partitionEffect`, and
   `partitionQueue`.
3. Add `takeWhileFilter`, `dropWhileFilter`.
4. Add `catchFilter`, `catchCauseFilter`.
5. Remove predicate/refinement overloads from `partition`, `partitionQueue`,
   and effectful-predicate overloads from `partitionEffect`; keep Filter-only
   signatures. Also remove Filter/OrPredicate overloads from `filter`,
   `filterEffect`, `takeWhile`, `dropWhile`,
   `catchIf`, `catchCauseIf`.
6. Update implementations — `filterMap` delegates to
   `Channel.filterMapArray`, predicate-only `filter` delegates to
   `Channel.filterArray`.
7. Update Stream tests.
8. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Stream/ && pnpm check:tsgo`

### Task 5: Sink + Pull — Add separate Filter APIs, remove Filter overloads

**Files:** `packages/effect/src/Sink.ts`, `packages/effect/src/Pull.ts`,
`packages/effect/test/Sink.test.ts`

**Depends on:** Task 1 (Sink may reference Channel).

1. Add `takeWhileFilter`, `takeWhileFilterEffect` to Sink.
2. Remove Filter overloads from `takeWhile`, `takeWhileEffect`.
3. Update Pull if it uses `Filter.apply` — switch to direct Filter calls.
4. Update Sink/Pull tests.
5. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Sink.test.ts && pnpm check:tsgo`

### Task 6: Chunk + Iterable — Convert Option filterMap to Filter

**Files:** `packages/effect/src/Chunk.ts`, `packages/effect/src/Iterable.ts`,
`packages/effect/src/Cache.ts`, `packages/effect/test/Chunk.test.ts`,
`packages/effect/test/Iterable.test.ts`, all internal consumers

1. Change `Chunk.filterMap` signature from `(a: A, i: number) => Option<B>` to
   `Filter<A, B, X, [i: number]>`. Update implementation to pass index to
   filter and check `Result.isSuccess`.
2. Change `Chunk.filterMapWhile` from `(a: A) => Option<B>` to
   `Filter<A, B, X>`.
3. Change `Iterable.filterMap` from `(a: A, i: number) => Option<B>` to
   `Filter<A, B, X, [i: number]>`. Update implementation to pass index to
   filter and check `Result.isSuccess`.
4. Change `Iterable.filterMapWhile` from `(a: A, i: number) => Option<B>` to
   `Filter<A, B, X, [i: number]>`.
5. Rewrite convenience functions that delegate to `filterMap` with Option
   callbacks:
   - `Iterable.getSomes` — rewrite with explicit loop
   - `Iterable.getFailures` — rewrite with explicit loop
   - `Iterable.getSuccesses` — rewrite with explicit loop
   - `Chunk.compact` — rewrite with explicit loop
6. Find and update ALL other call sites of `Chunk.filterMap` and
   `Iterable.filterMap` across the codebase — specifically:
   - `packages/effect/src/Cache.ts` (lines ~1161, ~1214) — calls
     `Iterable.filterMap` with Option-returning lambdas, must convert to
     Result-returning.
7. Update tests.
8. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Chunk.test.ts packages/effect/test/Iterable.test.ts && pnpm check:tsgo`

### Task 7: HashMap + Record + Trie + TxHashMap — Convert Option filterMap to Filter

**Files:** `packages/effect/src/HashMap.ts`, `packages/effect/src/Record.ts`,
`packages/effect/src/Trie.ts`, `packages/effect/src/TxHashMap.ts`,
`packages/effect/src/internal/hashMap.ts`, `packages/effect/src/internal/trie.ts`,
corresponding test files

TxHashMap must be in this task because `TxHashMap.filterMap` internally delegates
to `HashMap.filterMap` — they must change together.

1. Change `HashMap.filterMap` from `(value: A, key: K) => Option<B>` to
   `Filter<A, B, X, [key: K]>` (value as input, key as extra arg).
2. Change `TxHashMap.filterMap` from `(value: A, key: K) => Option<A>` to
   `Filter<A, B, X, [key: K]>`. Update delegation to `HashMap.filterMap`.
3. Change `Record.filterMap` from `(a: A, key: K) => Option<B>` to
   `Filter<A, B, X, [key: K]>`.
4. Change `Trie.filterMap` from `(value: A, key: string) => Option<B>` to
   `Filter<A, B, X, [key: string]>`.
5. Rewrite `Record.getSomes` — currently delegates to `filterMap`, must use
   explicit loop instead.
6. Update internal implementations in `internal/hashMap.ts`,
   `internal/trie.ts`.
7. Find and update all call sites.
8. Update tests.
9. Validate: `pnpm lint-fix && pnpm test packages/effect/test/HashMap.test.ts packages/effect/test/Record.test.ts packages/effect/test/Trie.test.ts packages/effect/test/TxHashMap.test.ts && pnpm check:tsgo`

### Task 8: Option — Convert Option filterMap to Filter

**Files:** `packages/effect/src/Option.ts`, `packages/effect/test/Option.test.ts`

1. Change `Option.filterMap` from `(a: A) => Option<B>` to `Filter<A, B, X>`.
   Previously an alias for `flatMap` — now applies the Filter, returns
   `Some(pass)` on success, `None` on failure.
2. Find and update all call sites.
3. Update tests.
4. Validate: `pnpm lint-fix && pnpm test packages/effect/test/Option.test.ts && pnpm check:tsgo`

### Task 9: Remove Filter.apply and type helpers

**Files:** `packages/effect/src/Filter.ts`, all files importing removed exports

**Depends on:** Tasks 1-8 (all usages of `Filter.apply`, `OrPredicate`,
`ResultOrBool`, `Pass`, `Fail`, `ApplyResult` must be eliminated first).

1. Remove `apply` function from `Filter.ts`.
2. Remove type exports: `OrPredicate`, `ResultOrBool`, `Pass`, `Fail`,
   `ApplyResult`.
3. Remove the `// apply` section (lines 77-132).
4. Grep the entire codebase for any remaining references to these exports and
   fix them.
5. Update Filter tests if any test `Filter.apply` directly.
6. Validate: `pnpm lint-fix && pnpm check:tsgo && pnpm test`

### Task 10: Final cleanup and validation

**Depends on:** All previous tasks.

1. Regenerate barrel files: `pnpm codegen`.
2. Run `pnpm lint-fix`.
3. Run `pnpm check:tsgo` (`pnpm clean` first if needed).
4. Run `pnpm test`.
5. Run `pnpm docgen`.
6. Create changeset in `.changeset/` for `effect` package (severity: `minor`).
   Include migration notes for:
   - Overloaded APIs split into separate functions
   - Option-based `filterMap` converted to `Filter`-based (return `Result`
     instead of `Option`; index/key params preserved via `Filter`'s `Args`)
   - `Filter.apply` and type helpers removed

### Task Dependency Graph

```
Task 1 (Channel) ──┬── Task 2 (Array)
                   ├── Task 4 (Stream)
                   └── Task 5 (Sink+Pull)
Task 3 (Effect + unstable modules)            ──┐
Task 6 (Chunk + Iterable + Cache)              ─┤
Task 7 (HashMap + Record + Trie + TxHashMap)   ─┤── Task 9 (Remove Filter.apply)
Task 8 (Option)                                ─┤        │
                                                         ▼
                                                    Task 10 (Final)
```

**Parallelizable groups:**

- **Group A:** Task 1 → Tasks 2, 4, 5 (Channel first, then dependents)
- **Group B:** Task 3 (Effect + unstable, independent)
- **Group C:** Task 6 (Chunk + Iterable, independent)
- **Group D:** Task 7 → Task 8 is independent of 7 but must follow if
  `Option.filterMap` callers also use `HashMap.filterMap`
- Tasks in different groups can run in parallel.
- Task 9 waits for all groups to complete.
- Task 10 is last.

## Acceptance Criteria

- Every function that currently accepts both `Predicate` and `Filter.Filter` via
  overloads is split into two separate functions.
- `Filter.apply`, `OrPredicate`, `ResultOrBool`, `Pass`, `Fail`, `ApplyResult`
  are removed from `Filter.ts`.
- All `filterMap` APIs across the codebase accept `Filter.Filter` with
  appropriate extra args (not `(a) => Option<B>`). Index/key parameters are
  preserved via `Filter`'s `Args` type parameter.
- Convenience functions (`getSomes`, `getFailures`, `getSuccesses`, `compact`)
  are rewritten with explicit loops.
- All downstream/unstable modules updated to use new Filter-specific APIs.
- All tests pass.
- Type checking passes (`pnpm check:tsgo`).
- All JSDoc examples compile (`pnpm docgen`).
- Barrel files are regenerated (`pnpm codegen`).
- A changeset is created with migration notes.

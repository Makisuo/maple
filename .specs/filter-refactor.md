# Filter Refactor: Box Pass Values and Accept Predicates

## Summary

Refactor `Filter.Filter` to box both pass and fail return values (`pass<B> | fail<X>`)
instead of only boxing failures. This enables every API that accepts a `Filter` to also
accept a plain `Predicate` or `Refinement` via overloads, with no runtime ambiguity.

## Background

`Filter<Input, Pass, Fail>` is currently `(input: Input) => Pass | fail<Fail>`. The pass
value is unboxed. This makes it impossible to also accept `Predicate<Input>` (which returns
`boolean`) in the same parameter position because:

1. **Runtime**: a boolean return is indistinguishable from a pass value of `true`/`false`.
2. **Type-level**: if the `Filter` return type includes `boolean`, TypeScript cannot prevent
   a predicate from matching a `Filter<A, B, X>` overload with arbitrary `B`.

Boxing pass values (`pass<B>`) makes `Filter` and `Predicate` structurally distinct at both
runtime and type level, allowing clean overload resolution.

## Goals

- Change `Filter<Input, Pass, Fail>` to return `pass<Pass> | fail<Fail>`.
- Change `FilterEffect<Input, Pass, Fail, E, R>` to return `Effect<pass<Pass> | fail<Fail>, E, R>`.
- Add `pass<A>` branded type and `Filter.pass(value)` constructor.
- Add predicate/refinement overloads to all 22 public APIs that accept `Filter`.
- Merge `catchIf` into `catchFilter` (and similar predicate variants into their Filter
  counterparts) where appropriate, removing the separate predicate-only APIs.
- Update all internal filter functions (`findError`, `findDefect`, `findDie`,
  `findInterrupt`, `exitFilterCause`, `exitFilterSuccess`, etc.) to return `pass<T>`.
- Update all consumption sites to check `isPass`/`isFail` instead of just `isFail`.

## Non-goals

- No changes to `Filter.FilterEffect` beyond updating the return type.
- No new filter combinators.
- No changes to APIs that already only accept predicates (e.g. `Effect.filterOrElse`).

## Design

### New Types

```ts
interface pass<out A> {
  readonly [PassTypeId]: typeof PassTypeId
  readonly pass: A
}

interface fail<out A> {
  readonly [FailTypeId]: typeof FailTypeId
  readonly fail: A
}

// Filter now returns boxed values on both branches
interface Filter<in Input, out Pass = Input, out Fail = Input> {
  (input: Input): pass<Pass> | fail<Fail>
}

interface FilterEffect<in Input, out Pass, out Fail, out E = never, out R = never> {
  (input: Input): Effect<pass<Pass> | fail<Fail>, E, R>
}
```

### Constructors

```ts
// New
const pass: <A>(value: A) => pass<A>
const passVoid: pass<void>
const isPass: (u: unknown) => u is pass<A>

// Updated
const make: <Input, Pass, Fail>(
  f: (input: Input) => pass<Pass> | fail<Fail>
) => Filter<Input, Pass, Fail>

// fromPredicate remains, but now wraps with pass()
const fromPredicate: {
  <A, B extends A>(refinement: Refinement<A, B>): Filter<A, B, Exclude<A, B>>
  <A>(predicate: Predicate<A>): Filter<A>
}
// Implementation: (input) => predicate(input) ? pass(input) : fail(input)
```

### Overload Strategy

Every API that currently accepts `Filter.Filter<A, B, X>` gains overloads for
`Predicate<A>` and `Refinement<A, B>`. TypeScript resolves the correct overload because:

- `Refinement<A, B>` returns `input is B` (special `boolean` subtype) — matched first
- `Predicate<A>` returns `boolean` — matched second
- `Filter<A, B, X>` returns `pass<B> | fail<X>` — **structurally distinct from `boolean`**,
  so a predicate cannot accidentally match this overload

At runtime, the implementation calls the function and inspects the result:

- `true` → pass (use original input)
- `false` → fail (use original input)
- `isPass(result)` → extract `.pass`
- `isFail(result)` → extract `.fail`

A single internal helper normalizes this:

```ts
const applyFilter = <A, B, X>(
  filter: Filter<A, B, X> | Predicate<A> | Refinement<A, B>,
  input: A
): pass<A | B> | fail<A | X> => {
  const result = filter(input)
  if (result === true) return pass(input)
  if (result === false) return fail(input)
  return result // pass<B> | fail<X>
}
```

### API Changes

For each affected API, add refinement and predicate overloads. When a separate
predicate-only variant already exists (e.g. `catchIf` for `catchFilter`), merge it into the
Filter-based API and remove the standalone variant.

#### APIs to merge (remove predicate-only variant)

| Filter API       | Predicate variant absorbed |
| ---------------- | -------------------------- |
| `Effect.catchIf` | old `Effect.catchIf`       |
| `Stream.catchIf` | old `Stream.catchIf`       |

_(The old `catchIf` was predicate-only. It was merged into `catchFilter`, which was then
renamed back to `catchIf` in Phase 5.)_

#### APIs to add overloads (no existing predicate variant to remove)

| Module  | Function (final name) |
| ------- | --------------------- |
| Effect  | `catchCauseIf`        |
| Effect  | `tapCauseIf`          |
| Effect  | `filter`              |
| Effect  | `onErrorIf`           |
| Effect  | `onExitIf`            |
| Stream  | `filter`              |
| Stream  | `filterEffect`        |
| Stream  | `partition`           |
| Stream  | `partitionQueue`      |
| Stream  | `partitionEffect`     |
| Stream  | `catchIf`             |
| Stream  | `catchCauseIf`        |
| Channel | `filter`              |
| Channel | `filterEffect`        |
| Channel | `filterArray`         |
| Channel | `filterArrayEffect`   |
| Channel | `catchCauseIf`        |
| Channel | `catchIf`             |
| Sink    | `takeWhile`           |
| Sink    | `takeWhileEffect`     |
| Array   | `partition`           |

#### APIs with existing predicate variants that remain separate

Some APIs have predicate counterparts with different semantics (not just a wrapped Filter).
These stay as-is:

| Filter API              | Predicate API (keep separate) | Reason                                                          |
| ----------------------- | ----------------------------- | --------------------------------------------------------------- |
| `Stream.filterMap`      | `Stream.filter`               | `filter` doesn't transform, returns `Stream<A>` not `Stream<B>` |
| `Channel.filterMap`     | `Channel.filter`              | Same                                                            |
| `Sink.takeFilter`       | `Sink.takeWhile`              | Different semantics (while vs filter)                           |
| `Array.partitionFilter` | `Array.partition`             | `partition` returns `[A[], A[]]` not `[Pass[], Fail[]]`         |

### Internal Filter Functions

All internal filters in `packages/effect/src/internal/effect.ts` must wrap pass values:

```ts
// Before:
const findError = <E>(cause: Cause<E>): E | fail<Cause<never>> => {
  // ...
  return reason.error // unboxed
}

// After:
const findError = <E>(cause: Cause<E>): pass<E> | fail<Cause<never>> => {
  // ...
  return pass(reason.error) // boxed
}
```

Affected internal filters:

- `findError`
- `findFail`
- `findDefect`
- `findDie`
- `findInterrupt`
- `causeFilterInterruptors`
- `exitFilterCause`
- `exitFilterSuccess`
- `exitFilterFailure`
- `exitFilterValue`
- `exitFindError`
- `exitFindDefect`

### Consumption Sites

All sites that currently check `Filter.isFail(result)` and use the result directly as the
pass value must be updated to extract `.pass`:

```ts
// Before:
const result = filter(error)
if (Filter.isFail(result)) { /* fail path */ }
// result is the pass value directly
f(result)

// After:
const result = applyFilter(filter, error)
if (Filter.isFail(result)) { /* fail path */ }
f(result.pass)
```

### Filter Combinators

All combinators in `Filter.ts` must be updated to work with boxed pass values:

- `or`: unwrap left pass, else try right
- `compose`: unwrap left pass, feed to right
- `composePassthrough`: same but fail with original input
- `zip` / `zipWith` / `andLeft` / `andRight`: unwrap both passes
- `mapFail`: only touches fail, but still needs to propagate `pass<T>`
- `toOption`: unwrap pass to `Some`, fail to `None`
- `toResult`: unwrap pass to `Success`, fail to `Failure`

### Existing Constructors

These return `Filter` and must produce `pass<T>`:

- `fromPredicate` → `pass(input)` / `fail(input)`
- `fromPredicateOption` → `pass(option.value)` / `fail(input)`
- `fromPredicateResult` → `pass(result.success)` / `fail(result.failure)`
- `tagged` → `pass(input)` / `fail(input)`
- `equals` → `pass(value)` / `fail(input)`
- `equalsStrict` → `pass(value)` / `fail(input)`
- `has` → `pass(input)` / `fail(input)`
- `instanceOf` → `pass(input)` / `fail(input)`
- `try` → `pass(f(input))` / `fail(input)`
- `string`, `number`, `boolean`, `bigint`, `symbol`, `date` → delegate to `fromPredicate`

## Migration

### For users writing inline filters

```ts
// Before:
Stream.filterMap((n: number) => n > 0 ? n * 2 : Filter.fail(n))

// After (transformation):
Stream.filterMap((n: number) => n > 0 ? Filter.pass(n * 2) : Filter.fail(n))

// After (predicate, no transformation):
Stream.filterMap((n: number) => n > 0)

// After (refinement):
Stream.filterMap((x): x is string => typeof x === "string")
```

### For users of catchIf

```ts
// Before:
Effect.catchIf(program, (e): e is NotFound => e._tag === "NotFound", handler)

// After (catchIf removed, use catchFilter with refinement):
Effect.catchFilter(program, (e): e is NotFound => e._tag === "NotFound", handler)
```

### For users of Filter.make

```ts
// Before:
Filter.make((n: number) => n > 0 ? n * 2 : Filter.fail(n))

// After:
Filter.make((n: number) => n > 0 ? Filter.pass(n * 2) : Filter.fail(n))
```

## Testing

- Update all existing Filter tests to use `Filter.pass()` for pass values.
- Add tests for predicate overloads on each affected API:
  - `Predicate` returning `boolean` → pass-through or filter out
  - `Refinement` → type narrowing
  - `Filter` with `pass<B>` → transformation
- Verify that `catchFilter` with predicate/refinement behaves identically to old `catchIf`.
- Use `it.effect` from `@effect/vitest` and `assert` (no `expect`).

## Validation

- `pnpm lint-fix`
- `pnpm test <relevant test files>`
- `pnpm check` (run `pnpm clean` then re-run if it fails)
- `pnpm build`
- `pnpm docgen`

## Acceptance Criteria

- `Filter.Filter` returns `pass<Pass> | fail<Fail>`, never unboxed values.
- `Filter.pass`, `Filter.passVoid`, `Filter.isPass` are exported.
- All 22 Filter-accepting APIs also accept `Predicate` and `Refinement`.
- `catchFilter` → `catchIf`, `catchCauseFilter` → `catchCauseIf`, `tapCauseFilter` → `tapCauseIf`,
  `onExitFilter` → `onExitIf`, `onErrorFilter` → `onErrorIf`.
- All internal filter functions return `pass<T>`.
- All consumption sites use `result.pass` / `result.fail` to extract values.
- All filter combinators work with boxed pass values.
- All existing tests pass after migration.
- New tests cover predicate and refinement overloads.

## Status: COMPLETE

All phases implemented. All validation passes:

- `pnpm check` — 0 errors
- `pnpm lint-fix` — clean
- `pnpm build` — succeeds
- `pnpm docgen` — all 3090 examples compile
- `pnpm test` — 5497 passed, 0 failed

## Implementation Notes

### Deviations from original spec

1. **Effectful APIs skipped for predicate overloads**: `filterMapEffect`, `partitionFilterEffect`,
   `filterMapArrayEffect`, `takeFilterEffect` were not given predicate overloads because predicates
   (returning boolean) don't make sense for effectful filter APIs that expect `Effect<pass|fail>`.

2. **`catchCauseFilter`/`tapCauseFilter` predicate overloads use single-arg callback**: When using
   a predicate (not a filter), the callback receives `(cause: Cause<E>)` — one argument — since
   there's no extracted failure value to pass. The filter overload keeps the two-arg signature
   `(failure: EB, cause: Cause<E>)`.

3. **`onErrorFilter` predicate overload uses single-arg callback**: Same pattern —
   `(cause: Cause<E>)` instead of `(failure: EB, cause: Cause<E>)`.

4. **Internal call sites use `as any` casts**: Functions like `catch_`, `catchDefect`, `tapError`,
   `tapDefect`, `onError` that pass generic filter functions to `catchCauseFilter`/`tapCauseFilter`
   internally need `as any` casts because the predicate overloads get tried first and fail
   type inference. Same for external modules: `Socket.ts`, `Command.ts`, `Sse.ts`, `RpcServer.ts`.

5. **`Effect.filterMap` runtime fix**: The predicate overload for `Effect.filterMap` (which operates
   on `Iterable<A>`) required a runtime fix — the `forEach` callback must return a valid Effect
   (`void_`) when the predicate returns boolean, not `undefined`.

6. **`Filter.fromPredicate(Exit.isSuccess)` matches predicate overload**: When passed inline to
   `onExitFilter`, TypeScript matches the predicate overload instead of the filter overload for
   polymorphic refinements like `Exit.isSuccess`. Workaround: extract to a variable with concrete
   type params, e.g. `Filter.fromPredicate(Exit.isSuccess<number, never>)`.

## Phase 4: Unify `*Filter` / `*Map` Variant Pairs

### Motivation

Now that `Filter`, `Predicate`, and `Refinement` are structurally distinct at both runtime
and type level, there is no reason to keep separate predicate-only and filter-only variants
of the same operation. Each pair can be collapsed into a single function that accepts all
three via overloads.

The naming convention becomes: the predicate name wins (shorter, more familiar). The `*Map`
or `*Filter` suffix is dropped since the overloads make it redundant.

### Merges

Each row merges the filter variant **into** the predicate variant (keeping the shorter name)
and removes the filter-specific function.

| Keep (unified name)      | Remove (merge into kept)      | Effectful variant (also merge)                               |
| ------------------------ | ----------------------------- | ------------------------------------------------------------ |
| `Stream.filter`          | `Stream.filterMap`            | `Stream.filterMapEffect` → `Stream.filterEffect`             |
| `Channel.filter`         | `Channel.filterMap`           | `Channel.filterMapEffect` → `Channel.filterEffect`           |
| `Channel.filterArray`    | `Channel.filterMapArray`      | `Channel.filterMapArrayEffect` → `Channel.filterArrayEffect` |
| `Stream.partition`       | `Stream.partitionFilter`      | `Stream.partitionFilterEffect` → `Stream.partitionEffect`    |
| `Stream.partitionQueue`* | `Stream.partitionFilterQueue` | —                                                            |
| `Array.partition`        | `Array.partitionFilter`       | —                                                            |
| `Sink.takeWhile`         | `Sink.takeFilter`             | `Sink.takeFilterEffect` → `Sink.takeWhileEffect`             |
| `Effect.filter`*         | `Effect.filterMap`            | (already effectful — `FilterEffect`)                         |

_`Stream.partitionQueue` and `Effect.filter` are new names — the predicate variant didn't
previously exist under that exact name (or used a different signature). Pick the most natural
short name._

### How it works

Each unified function has 6 overloads (3 data-last + 3 data-first), ordered:

1. **Refinement** `(refinement: Refinement<A, B>) => ...` — narrows `A` to `B`
2. **Predicate** `(predicate: Predicate<A>) => ...` — keeps `A` unchanged
3. **Filter** `(filter: Filter<A, B, X>) => ...` — transforms `A` to `B`, rejects to `X`

The runtime implementation calls the function and branches on the result type
(`boolean` → predicate path, `pass`/`fail` → filter path), same as the `Filter.apply`
helper already does.

### Example: `Stream.filter` (unified)

```ts
// Before (two separate APIs):
Stream.filter(stream, (n: number) => n > 0) // predicate
Stream.filterMap(stream, (n: number) => n > 0 ? Filter.pass(n * 2) : Filter.fail(n)) // filter

// After (single API):
Stream.filter(stream, (n: number) => n > 0) // predicate overload
Stream.filter(stream, (x): x is number => typeof x === "number") // refinement overload
Stream.filter(stream, (n: number) => n > 0 ? Filter.pass(n * 2) : Filter.fail(n)) // filter overload
```

### Example: `Array.partition` (unified)

```ts
// Before (two separate APIs):
Array.partition([1, -2, 3], (n) => n > 0) // [[-2], [1, 3]]
Array.partitionFilter([1, -2, 3], (n) => n > 0 ? Filter.pass(n) : Filter.fail(`neg:${n}`)) // [[1, 3], ["neg:-2"]]

// After (single API):
Array.partition([1, -2, 3], (n) => n > 0) // predicate overload
Array.partition([1, -2, 3], (n) => n > 0 ? Filter.pass(n) : Filter.fail(`neg:${n}`)) // filter overload
```

### Return type differences

When a predicate is used, the return type stays homogeneous (`A`). When a filter is used,
the pass and fail channels can have different types. This is expressed naturally by the
overloads:

```ts
// Stream.filter overloads (data-last):
<A, B extends A>(refinement: Refinement<A, B>): (self: Stream<A>) => Stream<B>
<A>(predicate: Predicate<A>): (self: Stream<A>) => Stream<A>
<A, B, X>(filter: Filter<A, B, X>): (self: Stream<A>) => Stream<B>

// Array.partition overloads (data-last):
<A, B extends A>(refinement: Refinement<A, B>): (self: Iterable<A>) => [Array<Exclude<A, B>>, Array<B>]
<A>(predicate: Predicate<A>): (self: Iterable<A>) => [Array<A>, Array<A>]
<A, B, X>(filter: Filter<A, B, X>): (self: Iterable<A>) => [Array<B>, Array<X>]
```

### Additional merges

These APIs also gain Filter overloads, unifying with their `*Map`/`*Filter` counterparts
where one exists, or simply adding the Filter overload where none existed before.

| Unified name          | Absorbs                | Notes                                                                                                    |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `Effect.filterOrElse` | —                      | Filter overload: pass value kept, fail feeds `orElse`                                                    |
| `Effect.filterOrFail` | —                      | Filter overload: pass value kept, fail feeds `orFailWith`                                                |
| `Array.filter`        | `Array.filterMap`      | Filter overload: keep pass side, discard fail side. Replaces `Option<B>` pattern with `Filter<A, B, X>`. |
| `Array.takeWhile`     | `Array.filterMapWhile` | Filter overload: take prefix while filter passes, transform kept elements                                |
| `Array.dropWhile`     | —                      | Filter overload: drop prefix while filter passes                                                         |
| `Stream.takeWhile`    | —                      | Filter overload: take while filter passes, transform kept elements                                       |
| `Stream.dropWhile`    | —                      | Filter overload: drop while filter passes                                                                |

The `Option`-based `Array.filterMap` and `Array.filterMapWhile` are subsumed by the Filter
overloads on `Array.filter` and `Array.takeWhile` respectively, since `Filter<A, B, X>` is
strictly more expressive than `(a) => Option<B>` (it carries a typed fail channel).

### Migration

```ts
// Stream.filterMap → Stream.filter
Stream.filterMap(stream, myFilter)    →  Stream.filter(stream, myFilter)

// Stream.partitionFilter → Stream.partition
Stream.partitionFilter(stream, myFilter)  →  Stream.partition(stream, myFilter)

// Channel.filterMap → Channel.filter
Channel.filterMap(channel, myFilter)  →  Channel.filter(channel, myFilter)

// Channel.filterMapArray → Channel.filterArray
Channel.filterMapArray(channel, myFilter)  →  Channel.filterArray(channel, myFilter)

// Array.partitionFilter → Array.partition
Array.partitionFilter(arr, myFilter)  →  Array.partition(arr, myFilter)

// Sink.takeFilter → Sink.takeWhile
Sink.takeFilter(myFilter)  →  Sink.takeWhile(myFilter)

// Effect.filterMap → Effect.filter
Effect.filterMap(items, myFilter)  →  Effect.filter(items, myFilter)

// Array.filterMap → Array.filter
Array.filterMap(arr, f)  →  Array.filter(arr, myFilter)

// Array.filterMapWhile → Array.takeWhile
Array.filterMapWhile(arr, f)  →  Array.takeWhile(arr, myFilter)
```

### Effectful variant renames

When the sync filter variant is merged into the predicate name, the effectful variant
should follow the same naming:

| Before                         | After                           |
| ------------------------------ | ------------------------------- |
| `Stream.filterMapEffect`       | `Stream.filterEffect`           |
| `Channel.filterMapEffect`      | `Channel.filterEffect`          |
| `Channel.filterMapArrayEffect` | `Channel.filterArrayEffect`     |
| `Stream.partitionFilterEffect` | `Stream.partitionEffect`        |
| `Sink.takeFilterEffect`        | `Sink.takeWhileEffect` (exists) |

`Sink.takeWhileEffect` already exists and takes a predicate. It gains a `FilterEffect`
overload.

### Steps

1. For each pair in the merge table, add Filter/FilterEffect overloads to the kept function.
2. Update the implementation to handle `boolean` vs `pass/fail` results (reuse `Filter.apply`).
3. Remove the old `*Map`/`*Filter` variant entirely (v4 is unreleased, no backward compat needed).
4. Update all internal call sites to use the unified name.
5. Update all tests.
6. Rename effectful variants.
7. Run full validation: `pnpm lint-fix`, `pnpm check`, `pnpm build`, `pnpm docgen`, `pnpm test`.

### Acceptance Criteria

- Each pair in the merge table is unified under the shorter name.
- The removed variant is deleted entirely.
- All overloads (refinement, predicate, filter) work on the unified function.
- Effectful variants are renamed to match.
- All tests pass.
- Barrel files regenerated (`pnpm codegen`).

## Phase 5: Rename `*Filter` Error-Handling APIs to `*If`

### Motivation

The `*Filter` suffix on error-handling APIs (`catchFilter`, `catchCauseFilter`, etc.) is
verbose and reads poorly. Since these APIs accept predicates, refinements, and filters via
overloads, the `*If` suffix better communicates the conditional semantics.

### Renames

| Before             | After          | Modules                       |
| ------------------ | -------------- | ----------------------------- |
| `catchFilter`      | `catchIf`      | Effect, Stream, Channel       |
| `catchCauseFilter` | `catchCauseIf` | Effect, Stream, Channel, Pull |
| `tapCauseFilter`   | `tapCauseIf`   | Effect                        |
| `onExitFilter`     | `onExitIf`     | Effect                        |
| `onErrorFilter`    | `onErrorIf`    | Effect                        |

All internal call sites, tests, and downstream consumers updated. The old `catchIf` (which
was a predicate-only variant) was already merged into `catchFilter` in Phase 3, so the name
`catchIf` was free to reuse.

### Migration

```ts
// Before:
Effect.catchFilter(program, filter, handler)
Effect.catchCauseFilter(program, filter, handler)
Effect.tapCauseFilter(program, filter, handler)
Effect.onExitFilter(program, filter, handler)
Effect.onErrorFilter(program, filter, handler)

// After:
Effect.catchIf(program, filter, handler)
Effect.catchCauseIf(program, filter, handler)
Effect.tapCauseIf(program, filter, handler)
Effect.onExitIf(program, filter, handler)
Effect.onErrorIf(program, filter, handler)
```

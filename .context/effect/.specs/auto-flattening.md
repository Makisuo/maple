# Remove auto-flattening

## Summary

Remove runtime `isEffect` auto-flattening from all public APIs. Callbacks must
return `Effect` explicitly; plain values are no longer silently wrapped or
ignored at runtime.

## Background

Many functions across Effect, Schedule, Stream, Sink, and Channel accept
callbacks whose return type is `X | Effect<X>`. At runtime they call `isEffect`
to decide whether to flatten or wrap the result. This creates:

- **Inconsistency** — `Effect.tap` auto-flattens but `Effect.tapError`,
  `Effect.tapCause`, etc. do not (issue #849).
- **Hidden behavior** — a callback returning a non-Effect value (e.g.
  `Promise`) is silently discarded or wrapped, masking bugs.
- **Type complexity** — conditional types like
  `[X] extends [Effect<…>] ? … : …` inflate overload surfaces.

The fix is to require `Effect` everywhere and remove the runtime dispatch.

## Goals

- Remove all runtime `isEffect` value-flattening checks from callback-based
  APIs.
- Simplify type signatures: remove conditional-type overloads and `| Effect`
  unions on callback return types.
- Remove the `{ onlyEffect: true }` option from `Effect.tap` (it becomes the
  only behavior).
- Keep `dual()` discrimination uses of `isEffect` — those distinguish
  data-first from data-last and are unrelated to auto-flattening.

## Non-goals

- No changes to `Effect.fn` generator-vs-Effect discrimination (it serves a
  different purpose: supporting both `gen` iterators and plain Effect returns).
- No changes to `dual()` discrimination logic that uses `isEffect` to detect
  data-first vs data-last invocations.

## Affected functions

### Effect module

| Function              | Current callback return type                                  | Change                                                                                                    |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `andThen`             | `X` (conditional type resolves `Effect<X>` or `Effect<X, …>`) | Require `Effect<B, E2, R2>` return; remove conditional-type overloads and `NotFunction<X>` overloads      |
| `tap`                 | `X` (conditional type) + `{ onlyEffect: true }` overloads     | Require `Effect<B, E2, R2>` return; remove conditional-type, `NotFunction<X>`, and `onlyEffect` overloads |
| `onExit`              | `Effect<void, XE, XR> \| void`                                | Require `Effect<void, XE, XR>`                                                                            |
| `onExitInterruptible` | `Effect<void, XE, XR> \| void`                                | Require `Effect<void, XE, XR>`                                                                            |
| `onInterrupt`         | `Effect<void> \| ((interruptors) => Effect<void>)`            | Require `(interruptors) => Effect<void>`; drop the bare-Effect overload                                   |
| `when`                | `LazyArg<boolean> \| Effect<boolean>`                         | Require `Effect<boolean>` only                                                                            |
| `acquireUseRelease`   | Internal impl types release as `Effect<void> \| void`         | Align internal impl with public sig (already `Effect<void>`)                                              |

### Schedule module

| Function      | Current callback return type             | Change                          |
| ------------- | ---------------------------------------- | ------------------------------- |
| `addDelay`    | `DurationInput \| Effect<DurationInput>` | Require `Effect<DurationInput>` |
| `map`         | `Output2 \| Effect<Output2>`             | Require `Effect<Output2>`       |
| `modifyDelay` | `DurationInput \| Effect<DurationInput>` | Require `Effect<DurationInput>` |
| `reduce`      | `State \| Effect<State>`                 | Require `Effect<State>`         |
| `unfold`      | `State \| Effect<State>`                 | Require `Effect<State>`         |
| `while`       | `boolean \| Effect<boolean>`             | Require `Effect<boolean>`       |

### Stream module

| Function   | Current callback return type               | Change                           |
| ---------- | ------------------------------------------ | -------------------------------- |
| `paginate` | `[A, Option<S>] \| Effect<[A, Option<S>]>` | Require `Effect<[A, Option<S>]>` |
| `when`     | `LazyArg<boolean> \| Effect<boolean>`      | Require `Effect<boolean>`        |

### Sink module

| Function    | Current callback return type | Change              |
| ----------- | ---------------------------- | ------------------- |
| `fold`      | `S \| Effect<S>`             | Require `Effect<S>` |
| `foldArray` | `S \| Effect<S>`             | Require `Effect<S>` |
| `foldUntil` | `S \| Effect<S>`             | Require `Effect<S>` |

### Channel module

| Function               | Current callback return type | Change                   |
| ---------------------- | ---------------------------- | ------------------------ |
| `asyncQueue` (private) | `void \| Effect<unknown>`    | Require `Effect<void>`   |
| `mapInput`             | `InElem \| Effect<InElem>`   | Require `Effect<InElem>` |
| `mapInputError`        | `InErr \| Effect<InErr>`     | Require `Effect<InErr>`  |

### Internal

| Function             | Current callback return type                 | Change                            |
| -------------------- | -------------------------------------------- | --------------------------------- |
| `request` (internal) | `RequestResolver \| Effect<RequestResolver>` | Require `Effect<RequestResolver>` |

## Requirements

### `Effect.andThen`

**Type signature — before:**

```ts
export const andThen: {
  <A, X>(
    f: (a: A) => X
  ): <E, R>(
    self: Effect<A, E, R>
  ) => [X] extends [Effect<infer A1, infer E1, infer R1>] ? Effect<A1, E | E1, R | R1> : Effect<X, E, R>
  <X>(
    f: NotFunction<X>
  ): <A, E, R>(
    self: Effect<A, E, R>
  ) => [X] extends [Effect<infer A1, infer E1, infer R1>] ? Effect<A1, E | E1, R | R1> : Effect<X, E, R>
  // + data-first variants
}
```

**Type signature — after:**

```ts
export const andThen: {
  <A, B, E2, R2>(f: (a: A) => Effect<B, E2, R2>): <E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Effect<A, E, R>, f: (a: A) => Effect<B, E2, R2>): Effect<B, E | E2, R | R2>
}
```

**Runtime — before:**

```ts
flatMap(self, (a) => {
  if (isEffect(f)) return f
  const value = typeof f === "function" ? internalCall(() => f(a)) : f
  return isEffect(value) ? value : succeed(value)
})
```

**Runtime — after:**

```ts
flatMap(self, (a) => internalCall(() => f(a)))
```

### `Effect.tap`

**Type signature — after:**

```ts
export const tap: {
  <A, B, E2, R2>(f: (a: NoInfer<A>) => Effect<B, E2, R2>): <E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Effect<A, E, R>, f: (a: NoInfer<A>) => Effect<B, E2, R2>): Effect<A, E | E2, R | R2>
}
```

Remove `NotFunction<X>` overloads, conditional-type overloads, and
`{ onlyEffect: true }` overloads.

**Runtime — after:**

```ts
flatMap(self, (a) => as(internalCall(() => f(a)), a))
```

### `Effect.onExit` / `Effect.onExitInterruptible`

Remove `| void` from the finalizer return type. The `onExitPrimitive`
implementation drops the `isEffect(eff) ? flatMap(eff, …) : exit` branch and
always `flatMap`s.

### `Effect.onInterrupt`

Remove the bare-Effect overload. Always require a function
`(interruptors: ReadonlySet<number>) => Effect<void, XE, XR>`. Drop the
`isEffect(finalizer) ? constant(finalizer) : finalizer` dispatch.

### `Effect.when`

Remove `LazyArg<boolean>` from the union. Require `Effect<boolean, E2, R2>`.
Drop the `isEffect(condition) ? condition : sync(condition)` dispatch.

### Schedule, Stream, Sink, Channel functions

For each function listed in the tables above:

1. Remove the `| Effect<…>` or `| plainValue` union from the callback return
   type, keeping only `Effect<…>`.
2. Remove the runtime `isEffect(result)` branch — always treat the return as
   an `Effect`.
3. Update internal callers to wrap plain values in `Effect.succeed` or
   `Effect.sync` where needed.

## Migration

Callers currently relying on auto-flattening must wrap return values:

| Before                                       | After                                                        |
| -------------------------------------------- | ------------------------------------------------------------ |
| `Effect.andThen(self, 42)`                   | `Effect.andThen(self, () => Effect.succeed(42))`             |
| `Effect.andThen(self, (a) => a + 1)`         | `Effect.andThen(self, (a) => Effect.succeed(a + 1))`         |
| `Effect.tap(self, (a) => console.log(a))`    | `Effect.tap(self, (a) => Effect.sync(() => console.log(a)))` |
| `Effect.tap(self, Console.log("hi"))`        | `Effect.tap(self, () => Console.log("hi"))`                  |
| `Effect.tap(self, f, { onlyEffect: true })`  | `Effect.tap(self, f)`                                        |
| `Effect.when(self, () => true)`              | `Effect.when(self, Effect.succeed(true))`                    |
| `Effect.onExit(self, (exit) => { … })`       | `Effect.onExit(self, (exit) => Effect.sync(() => { … }))`    |
| `Schedule.addDelay(sched, () => "1 second")` | `Schedule.addDelay(sched, () => Effect.succeed("1 second"))` |
| `Sink.fold(zero, cont, (s, i) => s + i)`     | `Sink.fold(zero, cont, (s, i) => Effect.succeed(s + i))`     |

## Implementation order

1. **`Effect.andThen`** and **`Effect.tap`** — highest visibility; update type
   signatures, remove conditional-type overloads, simplify runtime.
2. **`Effect.onExit`**, **`Effect.onExitInterruptible`**,
   **`Effect.acquireUseRelease`** — remove `| void` from finalizer types and
   `isEffect` branches in `onExitPrimitive`.
3. **`Effect.onInterrupt`** — require function form only.
4. **`Effect.when`** — require `Effect<boolean>`.
5. **Schedule functions** — `addDelay`, `map`, `modifyDelay`, `reduce`,
   `unfold`, `while`.
6. **Stream functions** — `paginate`, `when`.
7. **Sink functions** — `fold`, `foldArray`, `foldUntil`.
8. **Channel functions** — `mapInput`, `mapInputError`, `asyncQueue`.
9. **Internal** — `request`.
10. Fix all internal callers and tests that relied on auto-flattening.

## Testing

- Update existing tests that pass plain values to auto-flattening APIs.
- Verify that passing a non-Effect to `andThen`/`tap` is a compile error.
- Run `pnpm test` for each affected package after changes.

## Validation

- `pnpm lint-fix`
- `pnpm test <relevant test files>`
- `pnpm check` (run `pnpm clean` then re-run if it fails)
- `pnpm build`
- `pnpm docgen`

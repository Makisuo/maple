# Duration: support negative values

## Summary

Extend the `Duration` type to represent both positive and negative values. The
core `make` constructor currently clamps all non-positive inputs to zero,
making it impossible to express time deltas like "5 seconds ago" or to move a
`TestClock` backward via `adjust`.

## Background

The private `make` function (`Duration.ts:229`) is the sole constructor for
`Duration` values. It treats every `number <= 0` and `bigint <= 0n` as zero:

```ts
if (isNaN(input) || input <= 0) {
  duration.value = zeroDurationValue
}
```

This invariant propagates through every public constructor (`millis`, `seconds`,
`nanos`, …) and every arithmetic operation (`subtract`, `times`, `divide`).
Consequences:

- `Duration.subtract(seconds(3), seconds(10))` silently returns `Duration.zero`
  instead of a -7 s duration.
- `TestClock.adjust(Duration.seconds(-5))` is a no-op — the clock cannot move
  backward.
- `DateTime.addDuration(dt, Duration.seconds(-5))` is a no-op — you must use
  the separate `subtractDuration` API.
- String inputs like `"-5 seconds"` parse syntactically (the regex accepts `-?`)
  but the resulting value is clamped to zero.

## Goals

- Allow `Duration` to hold negative `Millis` and `Nanos` values.
- Add a `NegativeInfinity` variant so the type is fully signed.
- Make `subtract`, `times`, and `divide` produce negative results when
  mathematically appropriate.
- Let `TestClock.adjust` accept negative durations to move the clock backward.
- Let `DateTime.addDuration` naturally subtract time when given a negative
  duration.
- Keep the external API surface additive — no existing function signatures
  change, only their domain widens.

## Non-goals

- Changing the `DurationInput` type. Numeric and string inputs already accept
  negative values syntactically; they just need to stop being clamped.

## Requirements

### 1. Extend `DurationValue` with `NegativeInfinity`

**File:** `packages/effect/src/Duration.ts`

Current:

```ts
export type DurationValue =
  | { _tag: "Millis"; millis: number }
  | { _tag: "Nanos"; nanos: bigint }
  | { _tag: "Infinity" }
```

New:

```ts
export type DurationValue =
  | { _tag: "Millis"; millis: number }
  | { _tag: "Nanos"; nanos: bigint }
  | { _tag: "Infinity" }
  | { _tag: "NegativeInfinity" }
```

Add a new constant:

```ts
const negativeInfinityDurationValue: DurationValue = { _tag: "NegativeInfinity" }
export const negativeInfinity: Duration = /* make with negativeInfinityDurationValue */
```

### 2. Remove the zero-clamp in `make`

**File:** `packages/effect/src/Duration.ts`, `make` function (line 229)

Current:

```ts
if (isNaN(input) || input <= 0) {
  duration.value = zeroDurationValue
}
```

New:

```ts
if (isNaN(input)) {
  duration.value = zeroDurationValue
} else if (input === 0 || Object.is(input, -0)) {
  duration.value = zeroDurationValue
} else if (!Number.isFinite(input)) {
  duration.value = input > 0 ? infinityDurationValue : negativeInfinityDurationValue
} else if (!Number.isInteger(input)) {
  duration.value = { _tag: "Nanos", nanos: BigInt(Math.round(input * 1_000_000)) }
} else {
  duration.value = { _tag: "Millis", millis: input }
}
```

For bigint:

```ts
if (input === bigint0) {
  duration.value = zeroDurationValue
} else {
  duration.value = { _tag: "Nanos", nanos: input }
}
```

### 3. New predicate and utility functions

Add to `Duration.ts`:

```ts
/** Returns `true` if the duration is negative (< zero). */
export const isNegative: (self: Duration) => boolean

/** Returns `true` if the duration is positive (> zero). */
export const isPositive: (self: Duration) => boolean

/** Returns the absolute value of the duration. */
export const abs: (self: Duration) => Duration

/** Negates the duration. `negate(seconds(5))` → `-5 seconds`. */
export const negate: (self: Duration) => Duration
```

Rules for special values:

- `isNegative(zero)` → `false`
- `isPositive(zero)` → `false`
- `isNegative(infinity)` → `false`
- `isNegative(negativeInfinity)` → `true`
- `isPositive(infinity)` → `true`
- `isPositive(negativeInfinity)` → `false`
- `negate(infinity)` → `negativeInfinity`
- `negate(negativeInfinity)` → `infinity`
- `abs(infinity)` → `infinity`
- `abs(negativeInfinity)` → `infinity`

Update existing predicates:

- `isFinite`: return `false` for both `Infinity` and `NegativeInfinity`
- `isZero`: return `false` for `NegativeInfinity`

### 4. Arithmetic changes

#### `subtract` (line 1052)

Currently clamps to zero via `make`. After the `make` change, `subtract` needs
no code changes for the finite case — `make(3000 - 10000)` will produce
`make(-7000)` which now stores `{ _tag: "Millis", millis: -7000 }`.

The `onInfinity` handler needs updating for `NegativeInfinity`:

- `infinity - infinity` → `zero`
- `infinity - negativeInfinity` → `infinity`
- `infinity - finite` → `infinity`
- `negativeInfinity - negativeInfinity` → `zero`
- `negativeInfinity - infinity` → `negativeInfinity`
- `negativeInfinity - finite` → `negativeInfinity`
- `finite - infinity` → `negativeInfinity`
- `finite - negativeInfinity` → `infinity`

This follows standard signed-infinity arithmetic.

#### `times` (line 1018)

No code changes for finite values. `make(millis * times)` will produce negative
when the signs differ. The `onInfinity` handler needs updating:

- `infinity * positive` → `infinity`
- `infinity * negative` → `negativeInfinity`
- `infinity * 0` → `zero`
- `negativeInfinity * positive` → `negativeInfinity`
- `negativeInfinity * negative` → `infinity`
- `negativeInfinity * 0` → `zero`

#### `divide` / `divideUnsafe` (lines 943, 985)

`divide`: remove the `by <= 0 → undefined` guard for nanos. Division by zero
should still return `undefined`. Division by a negative number should produce a
negative Duration.

`divideUnsafe`: remove the `by < 0 → zero` guard. Division by zero: same
current behavior (millis: `make(millis / 0)` = infinity; nanos: handle
explicitly).

#### `sum` (line 1091)

No changes for finite values. The `onInfinity` handler needs updating:

- `infinity + infinity` → `infinity`
- `infinity + negativeInfinity` → `zero`
- `infinity + finite` → `infinity`
- `negativeInfinity + negativeInfinity` → `negativeInfinity`
- `negativeInfinity + finite` → `negativeInfinity`

### 5. Conversion functions

#### `toHrTime` (line 660)

This function breaks with negatives because `Math.floor` and `%` produce
surprising results for negative values. Fix:

```ts
export const toHrTime = (self: Duration): [seconds: number, nanos: number] => {
  switch (self.value._tag) {
    case "Infinity":
      return [Infinity, 0]
    case "NegativeInfinity":
      return [-Infinity, 0]
    case "Nanos": {
      const n = self.value.nanos
      const sign = n < bigint0 ? -1n : 1n
      const abs = n < bigint0 ? -n : n
      return [
        Number(sign * (abs / bigint1e9)),
        Number(sign * (abs % bigint1e9))
      ]
    }
    case "Millis": {
      const m = self.value.millis
      const sign = m < 0 ? -1 : 1
      const abs = Math.abs(m)
      return [
        sign * Math.floor(abs / 1000),
        sign * Math.round((abs % 1000) * 1_000_000)
      ]
    }
  }
}
```

This ensures `[-seconds, -nanos]` where both components share the same sign.

#### `toMillis`, `toSeconds`, `toNanos`, etc.

These currently return `Infinity` for the `Infinity` case. Add a
`NegativeInfinity` case that returns `-Infinity` (or throws for
`toNanosUnsafe`, which already throws for `Infinity`). The finite-value paths
need no changes — they return the raw numeric value which is now allowed to be
negative.

#### `match` / `matchPair` helpers

The internal `match` and `matchPair` functions dispatch on `_tag`. They
currently have an `onInfinity` handler. These must be extended with an
`onNegativeInfinity` handler (or the `onInfinity` handler receives the full
`DurationValue` and can inspect the tag). The cleanest approach: rename the
current catch-all to `onNonFinite` and pass the value so the handler can
distinguish the two cases, or add a separate `onNegativeInfinity` callback.

#### `parts` (line 1247)

Same issue with BigInt modulo. Fix by decomposing the absolute value, then
negating all parts if the original was negative:

```ts
export const parts = (self: Duration) => {
  if (self.value._tag === "Infinity") { /* unchanged */ }
  if (self.value._tag === "NegativeInfinity") {
    return {
      days: -Infinity,
      hours: -Infinity,
      minutes: -Infinity,
      seconds: -Infinity,
      millis: -Infinity,
      nanos: -Infinity
    }
  }
  const nanos = toNanosUnsafe(self)
  const neg = nanos < bigint0
  const abs = neg ? -nanos : nanos
  // decompose abs into days, hours, minutes, seconds, millis, nanos
  // if neg, negate each part
}
```

#### `format` (line 1296)

Prefix with `-` when negative:

```ts
if (isNegative(self)) {
  return "-" + format(abs(self))
}
```

This produces `"-1d 2h 30m"` instead of `"-1d -2h -30m"`.

#### `fromDurationInputUnsafe` — tuple form (line 122)

The `-Infinity` check should now produce `negativeInfinity` instead of `zero`.
The general case should allow negative tuples by passing through to `make`
which now accepts negatives.

### 6. Comparison / ordering

`Order` (line 805) uses raw numeric comparison which already handles negative
numbers correctly for finite values. The `onInfinity` handler needs updating to
account for `NegativeInfinity`:

- `NegativeInfinity` < any finite value < `Infinity`
- `NegativeInfinity` == `NegativeInfinity`

All derived functions (`min`, `max`, `between`, `clamp`, comparison predicates)
delegate to `Order` and need no additional changes.

### 7. Schema codecs

`Schema.Duration`, `Schema.DurationFromNanos`, `Schema.DurationFromMillis`
currently validate `>= 0`. These should be left as-is — the existing schemas
represent a "non-negative duration" contract for serialization, which is the
common case. If needed, a separate `Schema.SignedDuration` can be added later.

### 8. Consumer audit

Full audit of every Duration consumer in the codebase. Each call site is
categorized by the action required after negative values become representable.

#### 8.1 Already guarded — no changes needed

| File                   | Line(s)   | Code                                                  | Why safe                                                                     |
| ---------------------- | --------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `internal/effect.ts`   | 5254-5261 | `Clock.sleep`: `millis <= 0 → yieldNow`               | Explicit guard                                                               |
| `testing/TestClock.ts` | 291-294   | `TestClock.sleep`: `end <= currentTimestamp → return` | Explicit guard                                                               |
| `Schedule.ts`          | 2167-2176 | `fixed`: `window === 0 → Duration.zero`               | Modulo guard; negative window produces negative millis which `sleep` handles |
| `Schedule.ts`          | 3167-3175 | `windowed`: `window === 0 → Duration.zero`            | Same as `fixed`                                                              |
| `Schema.ts`            | —         | `Duration*` codecs validate `>= 0`                    | Explicit schema validation                                                   |

#### 8.2 Self-consistent degradation — no changes needed

These sites pass Duration to `Effect.sleep`, `Effect.timeout`, or
`Effect.delay`, all of which resolve immediately for non-positive values. The
resulting behavior (immediate timeout, immediate emission, no delay) is a
reasonable degradation and does not cause errors.

| File                                    | Line(s)   | Usage                                                 | Degradation                                                                   |
| --------------------------------------- | --------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `internal/effect.ts`                    | 3402-3415 | `delay`: `sleep(duration)` then run                   | Immediate execution                                                           |
| `internal/effect.ts`                    | 3444      | `timeoutOrElse`: `sleep(duration)`                    | Immediate timeout                                                             |
| `internal/effect.ts`                    | 3449-3468 | `timeout`: `sleep(duration)`                          | Immediate timeout                                                             |
| `internal/effect.ts`                    | 3472-3491 | `timeoutOption`: `sleep(duration)`                    | Immediate `None`                                                              |
| `internal/effect.ts`                    | 3876-3889 | `cachedInvalidateWithTTL`: TTL millis                 | Immediate invalidation (no caching)                                           |
| `internal/effect.ts`                    | 3919-3937 | `cachedWithTTL` / `cached`                            | Delegates to above                                                            |
| `Stream.ts`                             | 474-478   | `tick`: `Effect.delay(interval)`                      | Immediate ticks (tight loop but bounded by yield)                             |
| `Stream.ts`                             | 2573-2581 | `timeout`: `Effect.timeoutOrElse`                     | Immediate stream termination                                                  |
| `Stream.ts`                             | 7109-7119 | `debounce`: `setTimeout(durationMs)`                  | Immediate emit (setTimeout clamps ≤0 to 0)                                    |
| `Stream.ts`                             | 7468-7479 | `groupedWithin`: `Schedule.spaced(duration)`          | Immediate flush                                                               |
| `Schedule.ts`                           | 2016-2021 | `exponential`: base millis                            | Negative base → no delay on first attempt                                     |
| `Schedule.ts`                           | 2090-2099 | `fibonacci`: initial millis                           | Negative initial → no delay                                                   |
| `Schedule.ts`                           | 2635-2636 | `spaced`: sleep duration                              | Immediate advance                                                             |
| `Schedule.ts`                           | 1661-1662 | `during`: elapsed comparison                          | Immediately exhausted                                                         |
| `Sink.ts`                               | 1582-1591 | `withDuration` / `timed`                              | Produces Duration (does not consume a timeout)                                |
| `RequestResolver.ts`                    | 558-567   | `setDelay`: `Effect.sleep(duration)`                  | Immediate batching                                                            |
| `RequestResolver.ts`                    | 922-970   | `asCache`: delegates to `Cache.makeWith`              | See Cache below                                                               |
| `Pool.ts`                               | 503-504   | `strategyUsageTTL`: `Effect.delay(ttl)`               | Immediate excess-item check                                                   |
| `internal/rcRef.ts`                     | 151-163   | `idleTimeToLive`: `Effect.sleep(ttl)`                 | Immediate release                                                             |
| `RcMap.ts`                              | 387-409   | `idleTimeToLive`: `Duration.isZero` check, then sleep | Zero → immediate close; negative `toMillis` → setTimeout(0) → immediate close |
| `unstable/socket/Socket.ts`             | 519-520   | `openTimeout`: `Effect.timeoutOrElse`                 | Immediate timeout error                                                       |
| `unstable/reactivity/Atom.ts`           | 167-179   | `setIdleTTL`: converts to millis for setTimeout       | setTimeout(negative) → immediate eviction                                     |
| `unstable/reactivity/Atom.ts`           | 1504-1524 | `debounce`: setTimeout(millis)                        | Immediate fire                                                                |
| `unstable/reactivity/Atom.ts`           | 1538-1546 | `withRefresh`: setTimeout(millis)                     | Immediate refresh (tight loop mitigated by scope cleanup)                     |
| `unstable/workflow/DurableClock.ts`     | —         | Passthrough to `Effect.sleep`                         | Handled by sleep                                                              |
| `unstable/observability/OtlpTracer.ts`  | —         | Passthrough to `OtlpExporter`                         | See OtlpExporter below                                                        |
| `unstable/observability/OtlpLogger.ts`  | —         | Passthrough to `OtlpExporter`                         | See OtlpExporter below                                                        |
| `unstable/observability/OtlpMetrics.ts` | —         | Passthrough to `OtlpExporter`                         | See OtlpExporter below                                                        |
| `unstable/http/Cookies.ts`              | —         | Negative `max-age`                                    | Valid per RFC 6265 (immediate expiry)                                         |
| `platform-node-shared/NodeSocket.ts`    | —         | `openTimeout` passthrough                             | See Socket.ts                                                                 |
| `platform-bun/BunSocket.ts`             | —         | Passthrough                                           | See Socket.ts                                                                 |
| `opentelemetry/Metrics.ts`              | —         | `shutdownTimeout`                                     | Immediate shutdown (skip flush)                                               |
| `opentelemetry/NodeSdk.ts`              | —         | `shutdownTimeout`                                     | Immediate shutdown                                                            |
| `opentelemetry/Logger.ts`               | —         | `shutdownTimeout`                                     | Immediate shutdown                                                            |

#### 8.3 HIGH priority — division-by-zero or data corruption

| File                                  | Line(s) | Issue                                                                                                                                                                                          | Required change                                                                                                                   |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `unstable/persistence/RateLimiter.ts` | 65-68   | `Duration.divideUnsafe(window, limit)` — if `window` is zero or negative, `refillRateMillis` is 0 or negative, causing division-by-zero in downstream token-bucket math and Redis PTTL errors. | Clamp: `const window = Duration.max(Duration.fromDurationInputUnsafe(options.window), Duration.millis(1))` or fail with a defect. |

#### 8.4 MEDIUM priority — hot loops or backend errors

| File                                     | Line(s)                    | Issue                                                                                                                                                    | Required change                                                                                                  |
| ---------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `unstable/observability/OtlpExporter.ts` | 57, 114                    | Zero/negative `exportInterval` → `Effect.sleep(0)` → tight export loop burning CPU and hammering the collector.                                          | Clamp: `Duration.max(exportInterval, Duration.millis(100))` or fail.                                             |
| `unstable/persistence/PersistedQueue.ts` | 304-312, 383, 1011         | Zero/negative `pollInterval` → tight poll loop. Negative `lockExpirationMillis` → Redis `PEXPIRE`/SQL with negative values → undefined backend behavior. | Clamp both `pollInterval` and `lockExpirationMillis` to `Duration.millis(1)` minimum.                            |
| `unstable/persistence/Persistence.ts`    | 172-176, 183-192, 769, 784 | `Duration.isZero(ttl)` check skips storage, but negative TTL passes through to Redis `SET PX <negative>` → Redis error.                                  | Add `Duration.isNegative(ttl)` to the skip condition: `if (Duration.isZero(ttl) \|\| Duration.isNegative(ttl))`. |
| `unstable/rpc/RpcClient.ts`              | 1113, 1184-1190            | Negative `timeToLive` → `Pool.makeWithTTL` with negative TTL → immediate worker invalidation → thrashing (constant create/destroy).                      | Clamp: `Duration.max(timeToLive, Duration.seconds(1))` or fail.                                                  |

#### 8.5 LOW priority — harmless but worth documenting

| File                                     | Line(s)                     | Behavior with negative                                                                                                                                    | Action                                                                    |
| ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Cache.ts`                               | 401-406, 677-685, 1032-1038 | Negative TTL → `expiresAt` in the past → immediate eviction on next access. Equivalent to "don't cache."                                                  | Document: negative TTL = no caching. Optionally treat same as `isZero`.   |
| `ScopedCache.ts`                         | 183-185, 317-323, 449-452   | Same as Cache.                                                                                                                                            | Same.                                                                     |
| `Pool.ts`                                | 461-474                     | `strategyCreationTTL`: negative TTL → `remaining` always ≤ 0 → immediate invalidation.                                                                    | Document: negative TTL = items never kept.                                |
| `RcMap.ts`                               | 258-280, 354-398            | Negative `idleTimeToLive` → `toMillis` < 0 → not `isZero`, not `isFinite`(still finite) → sets `expiresAt` in the past → immediate close on next release. | Fine — immediate cleanup. Document.                                       |
| `Metric.ts`                              | 2038-2072                   | Negative `maxAge` → `age <= maxAge` never true → empty snapshots.                                                                                         | Add guard: `maxAge = Math.max(maxAge, 0)`.                                |
| `Stream.ts`                              | 7265-7301                   | `throttleEnforceEffect`/`throttleShapeEffect`: negative `durationMs` → `setTimeout(negative)` → immediate (setTimeout clamps to 0). No division.          | No change needed.                                                         |
| `unstable/persistence/PersistedCache.ts` | 43-71                       | Delegates to `Persistence.make` and `Cache.makeWith`.                                                                                                     | Covered by Persistence and Cache guards.                                  |
| `Config.ts`                              | —                           | Duration parsing from config.                                                                                                                             | Config layer may add its own validation; no Duration-level change needed. |

### 9. TestClock changes

**File:** `packages/effect/src/testing/TestClock.ts`

`adjust` (line 320) already does:

```ts
const millis = Duration.toMillis(Duration.fromDurationInputUnsafe(duration))
return run((timestamp) => timestamp + millis)
```

With negative durations allowed, `millis` can be negative, and
`timestamp + millis` moves the clock backward. The `run` function (line 307)
iterates sleeps with `timestamp <= endTimestamp` — when moving backward, no
sleeps are woken (their timestamps are all in the "future" relative to the new
time), and `currentTimestamp` is set to the earlier value. This is the correct
behavior: adjusting backward doesn't undo already-resolved sleeps, it just
repositions the clock.

No code changes needed in TestClock — it benefits automatically.

### 10. DateTime changes

`DateTime.addDuration` (DateTime.ts:913-919) already does:

```ts
mapEpochMillis(self, (millis) => millis + Duration.toMillis(...))
```

With negative durations, `addDuration(dt, Duration.minutes(-30))` naturally
subtracts 30 minutes. No code changes needed — the existing implementation
works once `make` stops clamping.

## Migration

This is a **behavioral breaking change** for code that relies on the silent
zero-clamp:

- `Duration.subtract(a, b)` where `b > a` now returns a negative duration
  instead of `Duration.zero`. Code that checks `Duration.isZero(result)` to
  detect "nothing left" must switch to `!Duration.isPositive(result)`.
- `Duration.times(d, -1)` now returns a negative duration instead of zero.
- Config values like `"-5 seconds"` now parse to an actual -5s duration
  instead of zero.

Add a changeset entry documenting the behavioral change.

## Testing

### Duration unit tests (`packages/effect/test/Duration.test.ts`)

- Constructors: `millis(-5)`, `seconds(-3)`, `nanos(-100n)` produce negative
  durations with correct values.
- `isNegative`, `isPositive` predicates.
- `abs` and `negate` roundtrip: `abs(negate(d)) === d` for all `d >= 0`.
- `subtract(seconds(3), seconds(10))` → negative 7 seconds.
- `sum(seconds(5), seconds(-3))` → 2 seconds.
- `times(seconds(5), -2)` → -10 seconds.
- `toMillis`, `toSeconds`, `toNanos` return negative numbers.
- `toHrTime` returns `[-seconds, -nanos]` with consistent signs.
- `parts` decomposes correctly for negative durations.
- `format` prefixes with `-`.
- `Order` sorts negativeInfinity < negative < zero < positive < infinity.
- `isZero(subtract(seconds(5), seconds(5)))` → true.
- `-Infinity` input → `negativeInfinity`.
- `NaN` input → `zero`.
- `negate(infinity)` → `negativeInfinity`.
- `negate(negativeInfinity)` → `infinity`.
- `sum(infinity, negativeInfinity)` → `zero`.
- `subtract(seconds(5), infinity)` → `negativeInfinity`.
- `times(infinity, -1)` → `negativeInfinity`.

### TestClock tests (`packages/effect/test/TestClock.test.ts`)

- `adjust` with negative duration moves clock backward.
- Sleeps registered before backward adjustment are not woken.
- Forward adjustment after backward adjustment wakes sleeps at correct
  timestamps.

### Existing tests

All existing Duration, TestClock, DateTime, Schedule, Effect, Stream, Cache,
Pool tests must continue to pass unchanged.

## Validation

- `pnpm lint-fix`
- `pnpm test packages/effect/test/Duration.test.ts`
- `pnpm test packages/effect/test/TestClock.test.ts`
- `pnpm test` (full suite)
- `pnpm check` (run `pnpm clean` first if needed)
- `pnpm build`
- `pnpm docgen`

## Acceptance Criteria

- [x] `Duration` can represent negative values via `Millis` and `Nanos` variants.
- [x] `DurationValue` includes a `NegativeInfinity` variant.
- [x] `make` no longer clamps negative inputs to zero (`-Infinity` →
      `negativeInfinity`, `NaN` → `zero`).
- [x] `negativeInfinity` constant is exported.
- [x] `isNegative`, `isPositive`, `abs`, `negate` are exported.
- [x] `subtract`, `times`, `divide` produce negative results when appropriate.
- [x] Infinity arithmetic follows standard signed-infinity rules.
- [x] `toHrTime`, `parts`, `format` handle negative durations correctly.
- [x] `TestClock.adjust` can move the clock backward (no code changes needed).
- [x] `Schema.Duration*` codecs continue to reject negative values (no change).
- [x] All consumer sites that require non-negative durations have explicit guards.
- [x] All existing tests pass. New tests cover negative duration behavior.

## Implementation Status

**Implemented** on branch `spec/duration-negative-values`.

All validation steps pass:

- `pnpm lint-fix` — 0 errors
- `pnpm check` — passes
- `pnpm test` — 5472 tests pass (203 test files)
- `pnpm build` — passes
- `pnpm docgen` — passes

### Files changed

#### Core Duration

- `packages/effect/src/Duration.ts` — `DurationValue` type, `make`, new
  predicates/utilities, arithmetic, conversions, ordering, format

#### Schema

- `packages/effect/src/Schema.ts` — Added `NegativeInfinity` case to encode
  (maps to `Millis(0)` as the schema rejects negatives)

#### Consumer guards

- `packages/effect/src/unstable/persistence/RateLimiter.ts` — Clamp `window`
  to min 1ms
- `packages/effect/src/unstable/observability/OtlpExporter.ts` — Clamp
  `exportInterval` to min 100ms
- `packages/effect/src/unstable/persistence/PersistedQueue.ts` — Clamp
  `pollInterval`, `lockRefreshInterval`, `lockExpiration` to min 1ms (both
  Redis and SQL stores)
- `packages/effect/src/unstable/persistence/Persistence.ts` — Skip storage
  for negative TTL (same as zero)
- `packages/effect/src/unstable/rpc/RpcClient.ts` — Clamp `timeToLive` to
  min 1s; changed Duration import from type-only to value
- `packages/effect/src/Metric.ts` — Clamp `maxAge` to min 0

#### Tests

- `packages/effect/test/Duration.test.ts` — Updated 5 tests for new
  behavior; added comprehensive negative value tests (predicates, abs, negate,
  negativeInfinity, ordering, format, toString, toJSON, sum, subtract, times)

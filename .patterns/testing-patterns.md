# Testing Patterns - Effect Library

### Testing Framework Selection

Use `it.effect` for Effect-based modules.

```typescript
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

// Use it.effect for Effect-based tests
it.effect("should work with Effects", () =>
  Effect.gen(function*() {
    const result = yield* someEffect
    assert.strictEqual(result, expectedValue)
  }))
```

Use regular `it` for pure TypeScript functions

```typescript
import { describe, expect, it } from "@effect/vitest"

// For pure functions that don't return Effects
it("should work with pure functions", () => {
  const result = pureFunction(input)
  expect(result).toBe(expectedValue)
})
```

### Testing Rules

- Never use Effect.runSync in tests
- Never use expect with it.effect. Use assert methods instead
- Always use TestClock for time-dependent operations
- Group Related Tests using `describe`

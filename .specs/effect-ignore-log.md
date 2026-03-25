# Effect.ignore log option + remove ignoreLogged

## Summary

Remove `Effect.ignoreLogged` and extend `Effect.ignore` with an optional logging
configuration so callers can opt into logging failures while still discarding
results.

## Background

`Effect.ignoreLogged` overlaps with `Effect.ignore`. We want a single API that
supports optional logging while preserving the existing `ignore` default
behavior (no logging). This is a breaking change because `ignoreLogged` is
removed.

## Goals

- Provide `Effect.ignore` options with `log?: boolean | LogLevel`.
- Preserve current `Effect.ignore` behavior when no options are supplied.
- Log the full `Cause` using the current fiber log level when `log: true`.
- Allow overriding the log level when `log` is a `LogLevel`.
- Remove `Effect.ignoreLogged` from public and internal APIs.
- Update docs to reflect the new API and removal.

## Non-goals

- No changes to logging infrastructure or log formatting.
- No deprecation path for `ignoreLogged`.
- No new logging helpers beyond `Effect.ignore` options.

## Requirements

### API

- Add overloads for `Effect.ignore` to accept options:
  - `Effect.ignore(self, options?)`
  - `Effect.ignore(options?)(self)`
- Introduce a documented options type shape:
  - `{ readonly log?: boolean | LogLevel }`
- `log?: boolean | LogLevel`:
  - `undefined` or `false`: do not log failures.
  - `true`: log the full `Cause` at the current fiber log level
    (equivalent to `logWithLevel()` today).
  - `LogLevel`: log the full `Cause` at the provided level.
- `Effect.ignore` still returns `Effect<void, never, R>`.

### Behavior

- Success value is discarded as `void`.
- Failures (including defects and interrupts) are discarded as `void`.
- When logging is enabled, log the full `Cause` using existing logger behavior
  (`logWithLevel`), with no additional message formatting.

### Removal

- Remove `Effect.ignoreLogged` from:
  - internal implementation (`packages/effect/src/internal/effect.ts`)
  - public API (`packages/effect/src/Effect.ts`)
  - any docs referencing it

### Documentation

- Update `Effect.ignore` JSDoc to document `log` option and include an example.
- Remove `ignoreLogged` JSDoc and any references to it in docs.
- Add a migration note in docs if a suitable location exists (short guidance:
  use `Effect.ignore({ log: true })` or `Effect.ignore({ log: "Error" })`).

## Migration

- Replace `Effect.ignoreLogged(effect)` with:
  - `Effect.ignore(effect, { log: true })` or
  - `Effect.ignore({ log: true })(effect)`
- For custom level: `Effect.ignore(effect, { log: "Error" })`.

## Testing

- Add tests that capture logs via a custom `Logger` layer:
  - `log` omitted/false: no logs emitted on failure.
  - `log: true`: emits one log with the current log level and the full `Cause`.
  - `log: <LogLevel>`: emits one log with the provided log level.
- Use `it.effect` from `@effect/vitest` and `assert` (no `expect`).

## Validation

- `pnpm lint-fix`
- `pnpm test <relevant test file>`
- `pnpm check` (run `pnpm clean` then re-run if it fails)
- `pnpm build`
- `pnpm docgen`

## Acceptance Criteria

- `Effect.ignore` supports `log?: boolean | LogLevel` with behavior above.
- `Effect.ignoreLogged` is removed from the codebase and docs.
- Docs reflect the new API and include a clear example.
- Tests cover logging enabled/disabled behavior.

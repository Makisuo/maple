## Overview

Refactor `WorkerError` to follow the new `reason` pattern (see `SocketError` and
`AiError`). `WorkerError` becomes a thin wrapper around a `reason` union of
semantic worker error classes. The existing `Spawn`, `Send`, `Receive`, and
`Unknown` categories remain, but each becomes a dedicated reason type with its
own message and optional cause.

## Goals

- Use a `reason` union for Worker errors instead of a literal string.
- Keep the same four error categories with minimal semantic change.
- Move human-readable messages onto the reason classes.
- Remove top-level `message`/`cause` fields in favor of reason payloads.
- Update all worker implementations to construct reason classes directly.
- Allow ergonomic `Effect.catchReason` usage with Worker errors.

## Non-goals

- No new worker behavior or error sources.
- No compatibility layer for legacy literal reasons.
- No new public worker APIs outside the error types themselves.

## Design

### Reason Types

Define four reason classes in `packages/effect/src/unstable/workers/WorkerError.ts`:

- `WorkerSpawnError`
- `WorkerSendError`
- `WorkerReceiveError`
- `WorkerUnknownError`

Each reason class:

- Uses `Schema.ErrorClass` with `_tag` via `Schema.tag("...")`.
- Includes a required `message: Schema.String`.
- Includes an optional `cause: Schema.Defect`.
- Exposes a default `message` getter if needed for consistency, but all existing
  call sites should supply the current message string so behavior is preserved.

Export the reason classes from `WorkerError.ts` so they are available via the
existing `effect/unstable/workers/WorkerError` module re-export.

### Reason Union

Expose a `WorkerErrorReason` type alias and `WorkerErrorReason` schema union:

```ts
export type WorkerErrorReason =
  | WorkerSpawnError
  | WorkerSendError
  | WorkerReceiveError
  | WorkerUnknownError

export const WorkerErrorReason = Schema.Union([
  WorkerSpawnError,
  WorkerSendError,
  WorkerReceiveError,
  WorkerUnknownError
])
```

### Top-Level WorkerError

Update `WorkerError` to wrap the reason union:

```ts
export class WorkerError extends Schema.ErrorClass<WorkerError>(TypeId)({
  _tag: Schema.tag("WorkerError"),
  reason: WorkerErrorReason
}) {
  readonly [TypeId] = TypeId

  override get message(): string {
    return this.reason.message
  }
}
```

The existing `isWorkerError` guard remains, targeting only the top-level
`WorkerError` wrapper.

The top-level `WorkerError` schema should no longer include `message` or `cause`.

### Construction Pattern

All call sites should construct a reason class and wrap it in `WorkerError`:

```ts
return Effect.fail(
  new WorkerError({
    reason: new WorkerSendError({
      message: "Failed to send message to worker",
      cause
    })
  })
)
```

No legacy literal support is required.

## Migration Scope

Update every `new WorkerError({ reason: "...", message, cause })` call to the
new reason class pattern. The primary files are:

- `packages/effect/src/unstable/workers/Worker.ts`
- `packages/platform-node/src/NodeWorker.ts`
- `packages/platform-node/src/NodeWorkerRunner.ts`
- `packages/platform-bun/src/BunWorker.ts`
- `packages/platform-bun/src/BunWorkerRunner.ts`
- `packages/platform-browser/src/BrowserWorker.ts`
- `packages/platform-browser/src/BrowserWorkerRunner.ts`

## Testing Plan

Add a new test suite under `packages/effect/test/unstable/workers` to validate:

- `WorkerError` wraps reason classes and exposes `message` from the reason.
- `isWorkerError` only matches the wrapper, not reason instances.
- Each reason class preserves `message` and `cause` values.
- Schema encode/decode round-trips for `WorkerError` and reason classes.

Follow the `it.effect` testing pattern used across the repo.

# SqlError Reason Pattern

## Overview

Refactor `SqlError` to follow the reason pattern used by `AiError` and
`WorkerError`. The new design introduces per-reason error classes and updates
`SqlError` to wrap a `reason` field instead of a flat `cause`/`message` pair.
This enables ergonomic error handling via `Effect.catchReason` and structured
error classification across all SQL drivers.

## Goals

- Replace the flat `cause`/`message` fields with a `reason` union of semantic
  error classes.
- Cover the most common cross-database error categories: connection,
  authentication, authorization, syntax, constraints, deadlocks, serialization
  failures, lock timeouts, statement timeouts, and unknown.
- Add an `operation` field (free-form string) so callers know what operation
  was being attempted.
- Add `isRetryable` to each reason indicating transient vs permanent errors.
- Update all 11 SQL driver packages to classify native errors into reasons on a
  best-effort basis, falling back to `UnknownError` for unrecognized codes.

## Non-Goals

- Exhaustive error code mapping for every database engine.
- Adding retry policies or backoff logic to the SQL layer.
- Changing `ResultLengthMismatch` (it remains a separate error class).
- Changing SQL client behavior beyond error construction.
- Modifying the `SqlConnection`, `Statement`, or `SqlClient` interfaces (they
  already use `SqlError` as their error type).

## Current State

`SqlError` is a `Schema.TaggedErrorClass` with two fields:

```ts
export class SqlError extends Schema.TaggedErrorClass<SqlError>(
  "effect/sql/SqlError"
)("SqlError", {
  cause: Schema.Defect,
  message: Schema.optional(Schema.String)
}) {
  readonly [TypeId] = TypeId
}
```

All 62 instantiation sites across 11 driver packages use
`new SqlError({ cause, message: "..." })`. The `message` field is a
human-readable string like `"Failed to execute statement"` or
`"PgClient: Failed to connect"`. The `cause` field holds the raw native driver
error. There is no error classification, no retryability indication, and no
structured reason.

## Proposed Design

### Reason Classes

Define reason classes in `packages/effect/src/unstable/sql/SqlError.ts` using
`Schema.TaggedErrorClass`, which defines `_tag` automatically via its second
argument. Each reason class:

- Has a unique `_tag` (set by `Schema.TaggedErrorClass`'s tag argument).
- Includes `cause: Schema.Defect` (the underlying native error).
- Includes `message: Schema.optional(Schema.String)` for human-readable
  context.
- Includes `operation: Schema.optional(Schema.String)` describing what was
  being attempted (e.g. `"connect"`, `"execute"`, `"beginTransaction"`).
- Exposes an `isRetryable` getter.
- Has a `[ReasonTypeId]` brand.
- Includes `@since 4.0.0` JSDoc tags on all exports.

#### Reason List

| Class | `_tag` | `isRetryable` | Description |
|---|---|---|---|
| `ConnectionError` | `"ConnectionError"` | `true` | Failed to connect to the database (refused, DNS, timeout, pool exhaustion) |
| `AuthenticationError` | `"AuthenticationError"` | `false` | Invalid credentials |
| `AuthorizationError` | `"AuthorizationError"` | `false` | Insufficient privileges for the operation |
| `SqlSyntaxError` | `"SqlSyntaxError"` | `false` | SQL syntax or semantic error (bad table name, invalid column, etc.) |
| `ConstraintError` | `"ConstraintError"` | `false` | Constraint violation (unique, foreign key, check, not null) |
| `DeadlockError` | `"DeadlockError"` | `true` | Deadlock detected, transaction was aborted |
| `SerializationError` | `"SerializationError"` | `true` | Serialization failure in a serializable transaction |
| `LockTimeoutError` | `"LockTimeoutError"` | `true` | Lock wait timeout exceeded |
| `StatementTimeoutError` | `"StatementTimeoutError"` | `true` | Statement execution time exceeded configured timeout |
| `UnknownError` | `"UnknownError"` | `false` | Catch-all for errors that cannot be classified |

#### Reason Class Template

Each reason class follows this structure:

```ts
export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>(
  "effect/sql/SqlError/ConnectionError"
)("ConnectionError", {
  cause: Schema.Defect,
  message: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.String)
}) {
  readonly [ReasonTypeId] = ReasonTypeId

  get isRetryable(): boolean {
    return true
  }
}
```

### ReasonTypeId

Add a `ReasonTypeId` constant:

```ts
const ReasonTypeId = "~effect/sql/SqlError/Reason" as const
```

### Reason Union

```ts
export type SqlErrorReason =
  | ConnectionError
  | AuthenticationError
  | AuthorizationError
  | SqlSyntaxError
  | ConstraintError
  | DeadlockError
  | SerializationError
  | LockTimeoutError
  | StatementTimeoutError
  | UnknownError

export const SqlErrorReason: Schema.Union<[
  typeof ConnectionError,
  typeof AuthenticationError,
  typeof AuthorizationError,
  typeof SqlSyntaxError,
  typeof ConstraintError,
  typeof DeadlockError,
  typeof SerializationError,
  typeof LockTimeoutError,
  typeof StatementTimeoutError,
  typeof UnknownError
]> = Schema.Union([
  ConnectionError,
  AuthenticationError,
  AuthorizationError,
  SqlSyntaxError,
  ConstraintError,
  DeadlockError,
  SerializationError,
  LockTimeoutError,
  StatementTimeoutError,
  UnknownError
])
```

### Updated SqlError

Keep `SqlError` as `Schema.TaggedErrorClass` (matching the current pattern).
Set `cause` on the wrapper via `override readonly cause = this.reason`
(matching `AiError`):

```ts
export class SqlError extends Schema.TaggedErrorClass<SqlError>(
  "effect/sql/SqlError"
)("SqlError", {
  reason: SqlErrorReason
}) {
  readonly [TypeId] = TypeId
  override readonly cause = this.reason

  override get message(): string {
    return this.reason.message ?? this.reason._tag
  }

  get isRetryable(): boolean {
    return this.reason.isRetryable
  }
}
```

Key changes:
- `cause` and `message` removed from `SqlError` schema fields.
- `message` delegates to `reason.message`, falling back to `reason._tag`.
- `isRetryable` delegates to `reason.isRetryable`.
- `cause` set to `this.reason` via override (matching `AiError` pattern at
  line 1400), ensuring `Error.cause` is set for stack trace chaining.
- `TypeId` string remains `"~effect/sql/SqlError"` for guard compatibility.

### Type Guards

Add `isSqlError` and `isSqlErrorReason` guards:

```ts
export const isSqlError = (u: unknown): u is SqlError =>
  Predicate.hasProperty(u, TypeId)

export const isSqlErrorReason = (u: unknown): u is SqlErrorReason =>
  Predicate.hasProperty(u, ReasonTypeId)
```

Note: `Predicate` must be added to the imports in `SqlError.ts`.

### Construction Pattern

Before:

```ts
new SqlError({ cause, message: "Failed to execute statement" })
```

After:

```ts
new SqlError({
  reason: new UnknownError({
    cause,
    message: "Failed to execute statement",
    operation: "execute"
  })
})
```

With classification:

```ts
new SqlError({
  reason: new ConnectionError({
    cause,
    message: "PgClient: Failed to connect",
    operation: "connect"
  })
})
```

### Recommended Operation Values

While `operation` is a free-form string, drivers should use these canonical
values for consistency:

- `"connect"` — establishing a database connection
- `"acquireConnection"` — acquiring a connection from the pool
- `"execute"` — executing a prepared statement
- `"executeUnprepared"` — executing an unprepared statement
- `"stream"` — streaming query results
- `"prepare"` — preparing a statement
- `"beginTransaction"` — beginning a transaction
- `"commitTransaction"` — committing a transaction
- `"rollbackTransaction"` — rolling back a transaction
- `"createSavepoint"` — creating a savepoint
- `"listen"` — subscribing to notifications (PostgreSQL)
- `"notify"` — sending a notification (PostgreSQL)
- `"export"` — exporting a database
- `"import"` — importing a database
- `"backup"` — backing up a database
- `"loadExtension"` — loading a SQLite extension
- `"insert"` — inserting data (ClickHouse batch insert)
- `"openDatabase"` — opening a database file
- `"parseRow"` — parsing a result row

### Breaking Change Notice

This is a breaking change to `SqlError`'s constructor and serialized shape.
The encoded JSON changes from `{_tag, cause, message}` to
`{_tag, reason: {_tag, cause, message, operation}}`. Since `SqlError` lives
under `effect/unstable/sql`, this is acceptable under the unstable API policy.
Changesets should use `minor` version bumps.

## Driver Error Classification

Each driver should implement a local `classifyError` helper function that
inspects the native error and returns the appropriate reason class instance.
The classification is best-effort: drivers should map well-known error codes
and fall back to `UnknownError` for anything unrecognized.

### Shared SQLite Classifier

Since 6 driver packages use SQLite-based databases (sqlite-node, sqlite-bun,
sqlite-wasm, sqlite-do, sqlite-react-native, d1), a shared
`classifySqliteError` helper should be exported from
`packages/effect/src/unstable/sql/SqlError.ts`. This helper inspects the
error's `code` property (string like `"SQLITE_CONSTRAINT"`) or numeric code
and returns the appropriate reason. Drivers that don't expose structured codes
(D1, Durable Objects) should fall back to `UnknownError`.

### PostgreSQL (`@effect/sql-pg`)

PostgreSQL errors expose a `code` field with SQLSTATE codes:

| SQLSTATE | Reason |
|---|---|
| `08*` (connection exception) | `ConnectionError` |
| `28*` (invalid authorization) | `AuthenticationError` |
| `42501` (insufficient privilege) | `AuthorizationError` |
| `42*` (syntax error or access rule violation, except `42501`) | `SqlSyntaxError` |
| `23*` (integrity constraint violation) | `ConstraintError` |
| `40P01` (deadlock detected) | `DeadlockError` |
| `40001` (serialization failure) | `SerializationError` |
| `55P03` (lock not available) | `LockTimeoutError` |
| `57014` (query cancelled / statement timeout) | `StatementTimeoutError` |
| Everything else | `UnknownError` |

Note: `42501` must be checked before the general `42*` prefix to ensure it
maps to `AuthorizationError` rather than `SqlSyntaxError`.

### MySQL (`@effect/sql-mysql2`)

MySQL errors expose an `errno` field:

| errno | Reason |
|---|---|
| `1040` (too many connections) | `ConnectionError` |
| `1042`, `1043` (can't get hostname, bad handshake) | `ConnectionError` |
| `1129`, `1130` (host blocked, host not allowed) | `ConnectionError` |
| `1203` (max user connections) | `ConnectionError` |
| `1044` (access denied to database) | `AuthorizationError` |
| `1045` (access denied for user) | `AuthenticationError` |
| `1142`, `1143`, `1227` (insufficient privileges) | `AuthorizationError` |
| `1064` (syntax error) | `SqlSyntaxError` |
| `1146` (table doesn't exist) | `SqlSyntaxError` |
| `1054` (unknown column) | `SqlSyntaxError` |
| `1022`, `1048`, `1062`, `1169` (constraint violations) | `ConstraintError` |
| `1216`, `1217`, `1451`, `1452`, `1557` (FK violations) | `ConstraintError` |
| `1213` (deadlock) | `DeadlockError` |
| `1205` (lock wait timeout) | `LockTimeoutError` |
| `3024` (query execution interrupted / timeout) | `StatementTimeoutError` |
| Everything else | `UnknownError` |

Note: MySQL does not distinguish serialization failures from deadlocks; both
use errno `1213`. `SerializationError` is not mapped for MySQL.

### MSSQL (`@effect/sql-mssql`)

MSSQL errors (from `tedious`) expose a `number` field:

| Error number | Reason |
|---|---|
| `233` (connection closed) | `ConnectionError` |
| `10054` (connection forcibly closed) | `ConnectionError` |
| `18456` (login failed) | `AuthenticationError` |
| `18452` (login failed, untrusted domain) | `AuthenticationError` |
| `4060` (cannot open database) | `AuthenticationError` |
| `229`, `230`, `262`, `297`, `300` (permission denied) | `AuthorizationError` |
| `102` (syntax error) | `SqlSyntaxError` |
| `207` (invalid column name) | `SqlSyntaxError` |
| `208` (invalid object name) | `SqlSyntaxError` |
| `2714` (object already exists) | `SqlSyntaxError` |
| `547` (FK constraint) | `ConstraintError` |
| `2601` (unique index violation) | `ConstraintError` |
| `2627` (unique constraint violation) | `ConstraintError` |
| `515` (cannot insert NULL) | `ConstraintError` |
| `1205` (deadlock victim) | `DeadlockError` |
| `3960` (snapshot isolation conflict) | `SerializationError` |
| `1222` (lock request timeout) | `LockTimeoutError` |
| Everything else | `UnknownError` |

For connection-level errors (timeout during pool connect), use
`ConnectionError` regardless of error number.

### SQLite (all SQLite drivers)

SQLite errors expose a `code` string property (e.g. `"SQLITE_CONSTRAINT"`)
and/or a numeric result code:

| Code (string / numeric) | Reason |
|---|---|
| `SQLITE_AUTH` / `23` | `AuthenticationError` |
| `SQLITE_PERM` / `3` | `AuthorizationError` |
| `SQLITE_CONSTRAINT` / `19` (and extended codes like `SQLITE_CONSTRAINT_UNIQUE`) | `ConstraintError` |
| `SQLITE_BUSY` / `5` | `LockTimeoutError` |
| `SQLITE_LOCKED` / `6` | `LockTimeoutError` |
| `SQLITE_CANTOPEN` / `14` | `ConnectionError` |
| `SQLITE_ERROR` / `1` | `UnknownError` |
| Everything else | `UnknownError` |

Notes:
- `SQLITE_AUTH` is numeric code `23`, not `14`.
- `SQLITE_LOCKED` (code `6`) maps to `LockTimeoutError` (not
  `DeadlockError`), because SQLite uses a simpler locking model without
  true deadlock detection.
- `SQLITE_ERROR` (code `1`) is too generic for reliable syntax detection via
  message parsing. Default to `UnknownError`.
- Drivers that don't expose structured error codes (D1, Durable Objects)
  should default to `UnknownError`.

### ClickHouse (`@effect/sql-clickhouse`)

ClickHouse errors from `@clickhouse/client` expose error codes:

| Code | Reason |
|---|---|
| `516` (authentication failed) | `AuthenticationError` |
| `497` (access denied) | `AuthorizationError` |
| `62` (syntax error) | `SqlSyntaxError` |
| `60` (table not found) | `SqlSyntaxError` |
| `36` (invalid column) | `SqlSyntaxError` |
| `242` (table already exists) | `SqlSyntaxError` |
| `159`, `469` (timeout) | `StatementTimeoutError` |
| Connection-level errors (timeout during connect) | `ConnectionError` |
| Everything else | `UnknownError` |

### LibSQL (`@effect/sql-libsql`)

LibSQL errors from `@libsql/client` wrap SQLite error codes. Use the shared
`classifySqliteError` helper where the underlying code is accessible, falling
back to `UnknownError`.

## Impacted Files

### Core (effect package)

- `packages/effect/src/unstable/sql/SqlError.ts` — reason classes, updated
  `SqlError`, shared `classifySqliteError` helper, type guards

### Driver Packages

- `packages/sql/pg/src/PgClient.ts`
- `packages/sql/mysql2/src/MysqlClient.ts`
- `packages/sql/mssql/src/MssqlClient.ts`
- `packages/sql/sqlite-node/src/SqliteClient.ts`
- `packages/sql/sqlite-bun/src/SqliteClient.ts`
- `packages/sql/sqlite-wasm/src/SqliteClient.ts`
- `packages/sql/sqlite-wasm/src/OpfsWorker.ts`
- `packages/sql/sqlite-do/src/SqliteClient.ts`
- `packages/sql/sqlite-react-native/src/SqliteClient.ts`
- `packages/sql/d1/src/D1Client.ts`
- `packages/sql/libsql/src/LibsqlClient.ts`
- `packages/sql/clickhouse/src/ClickhouseClient.ts`

### Tests

- `packages/effect/test/unstable/sql/SqlError.test.ts` (new)
- Existing driver test files that assert on `SqlError` instances

## Implementation Plan

Changing `SqlError`'s constructor signature is a breaking change that affects
all 62 call sites across 11 driver packages. Since `pnpm check:tsgo` runs
across the full monorepo, the core change and all driver updates must be
done together to maintain a passing build.

### Task 1: Core SqlError + all drivers + tests + changesets

This is a single atomic task. All changes must land together for the build
to pass.

#### Task State (core checkpoint)

- [x] Core `SqlError.ts` reason-pattern refactor (items 1-9) completed.
- [x] Driver updates (items 10-12) completed across all 11 SQL driver packages.
- [x] Tests and changesets (items 13-16) completed (core and targeted driver classification tests landed; pending minor changesets added for `effect` and all affected SQL driver packages).
- [x] Full monorepo validation (items 17-21) completed (`pnpm codegen`, `pnpm lint-fix`, `pnpm check:tsgo`, `pnpm docgen`, and full `pnpm test` sweep all pass).

#### Discoveries / Issues

- The previous 62 SQL driver `new SqlError({ cause, message })` call sites were
  migrated to `new SqlError({ reason: ... })` with per-driver classification.
- `ResultLengthMismatch` shares the SqlError module TypeId brand, so
  `isSqlError` must also check `_tag === "SqlError"` to avoid false
  positives.
- Added core smoke tests in `packages/effect/test/unstable/sql/SqlError.test.ts`
  for wrapper delegation, guards, and `classifySqliteError` string/numeric
  mappings.
- SQLite-based drivers now use `classifySqliteError` with canonical operations
  (`prepare`, `execute`, `openDatabase`, `export`, `import`, `backup`,
  `loadExtension`, `stream`); D1 intentionally defaults to `UnknownError`
  because native D1 errors do not expose stable SQLite result codes.
- Added per-driver `classifyError` helpers for pg / mysql2 / mssql /
  clickhouse with SQLSTATE / errno / number / code mappings from this spec and
  `UnknownError` fallback for unmapped native errors.
- Expanded `packages/effect/test/unstable/sql/SqlError.test.ts` with exhaustive
  assertions for all 10 reason classes, wrapper delegation checks for
  `message` / `cause` / `isRetryable`, and schema encode/decode round-trips for
  `SqlError` wrapping each reason.
- Added targeted driver classification suites:
  - `packages/sql/pg/test/SqlErrorClassification.test.ts` verifies SQLSTATE
    precedence (`42501` before generic `42*`) and unknown fallback.
  - `packages/sql/mysql2/test/SqlErrorClassification.test.ts` verifies errno
    mapping for connection / auth / authz / syntax / constraint / deadlock /
    lock-timeout / statement-timeout plus unknown fallback.
  - `packages/sql/mssql/test/SqlErrorClassification.test.ts` verifies `number`
    mapping for connection / auth / authz / syntax / constraint / deadlock /
    serialization / lock-timeout plus unknown fallback.
  - `packages/sql/clickhouse/test/SqlErrorClassification.test.ts` verifies
    `code` mapping for auth / authz / syntax / statement-timeout and unknown
    fallback on execute.
  - `packages/sql/d1/test/Client.test.ts` and
    `packages/sql/sqlite-do/test/Client.test.ts` now assert `UnknownError`
    fallback when native errors do not expose stable SQLite codes.
- Added 12 pending minor changesets for the SqlError reason-pattern migration:
  one for `effect` and one per affected SQL driver package
  (pg / mysql2 / mssql / sqlite-node / sqlite-bun / sqlite-wasm / sqlite-do /
  sqlite-react-native / d1 / libsql / clickhouse).
- Post-changeset validation rerun completed: `pnpm lint-fix`,
  `pnpm test packages/effect/test/unstable/sql/SqlError.test.ts`,
  `pnpm check:tsgo`, and `pnpm docgen`.
- Review verification: targeted suites pass via `pnpm test` for pg / mysql2 /
  mssql / clickhouse / d1 / sqlite-do classification test files.
- Full monorepo `pnpm test` initially failed in `@effect/sql-libsql` due
  transient testcontainer connectivity (`ECONNREFUSED`) in this environment.
  `packages/sql/libsql/test/util.ts` now uses `container.getHost()` (instead of
  hardcoded `localhost`) and waits for server readiness after container start,
  stabilizing libsql integration tests while preserving SqlError behavior.

**Core changes** (`packages/effect/src/unstable/sql/SqlError.ts`):

1. Add `ReasonTypeId` constant.
2. Add `Predicate` import.
3. Define all 10 reason classes (`ConnectionError`, `AuthenticationError`,
   `AuthorizationError`, `SqlSyntaxError`, `ConstraintError`, `DeadlockError`,
   `SerializationError`, `LockTimeoutError`, `StatementTimeoutError`,
   `UnknownError`) using `Schema.TaggedErrorClass`.
4. Define `SqlErrorReason` type alias and schema union (using array syntax
   `Schema.Union([...])`).
5. Update `SqlError` to use `Schema.TaggedErrorClass` with
   `reason: SqlErrorReason` (replacing `cause`/`message` fields).
6. Add `message`, `isRetryable` getters and `cause` override that delegate
   to the reason.
7. Add `isSqlError` and `isSqlErrorReason` type guards.
8. Add shared `classifySqliteError` helper for SQLite-based drivers.
9. Add `@since 4.0.0` JSDoc tags on all new exports.

**Driver updates** (all driver files listed in Impacted Files):

10. For each driver, add a local `classifyError` helper (or use the shared
    SQLite helper) that maps native error codes to reason classes.
11. Update all `new SqlError({ cause, message })` call sites to
    `new SqlError({ reason: new <ReasonClass>({ cause, message, operation }) })`.
12. Use the error code mappings defined in the Driver Error Classification
    section.

**Tests**:

13. Add `packages/effect/test/unstable/sql/SqlError.test.ts` covering:
    - Reason construction and `isRetryable` values for all 10 reason classes
    - `SqlError` wrapper: `message` delegation, `isRetryable` delegation,
      `cause` delegation
    - `isSqlError` and `isSqlErrorReason` guards
    - Schema encode/decode round-trips for `SqlError` with each reason type
14. Update any existing driver tests that assert on `SqlError` shape
    (e.g. `error.cause`, `error.message`).

**Changesets**:

15. Add changeset for `effect` (minor): `SqlError` now uses the reason
    pattern with structured error classification.
16. Add changesets for each SQL driver package (minor): driver now classifies
    native errors into `SqlError` reason types.

**Validation**:

17. `pnpm codegen` (regenerate barrel files)
18. `pnpm lint-fix`
19. `pnpm check:tsgo` (run `pnpm clean` first if needed)
20. `pnpm docgen`
21. `pnpm test`

## Test Plan

- Unit tests for all 10 reason classes: construction, `isRetryable` values,
  `message` getters, Schema encode/decode round-trips.
- Unit tests for `SqlError` wrapper: `message` delegation, `isRetryable`
  delegation, `cause` override, `isSqlError` and `isSqlErrorReason` guards.
- Integration: existing driver tests pass with the new error structure.

## Validation

- `pnpm codegen`
- `pnpm lint-fix`
- `pnpm check:tsgo` (run `pnpm clean` if check fails)
- `pnpm test <affected_test_file.ts>`
- `pnpm docgen`

## Review Follow-up Tasks

- [x] Run full monorepo `pnpm test` sweep (beyond targeted suites) before merge.
- Monitor CI stability for `@effect/sql-libsql` container startup timing; if
  flakiness persists, replace ad-hoc readiness polling with a dedicated
  testcontainers wait strategy / healthcheck endpoint.

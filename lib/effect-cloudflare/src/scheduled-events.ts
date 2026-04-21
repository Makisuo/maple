// Copied verbatim from alchemy-effect to stay API-compatible for a future
// migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/ScheduledEvents.ts
//
// SQLite-backed cron/timer for Durable Objects. Use inside a DO alarm handler:
//   alarm: () => Effect.gen(function* () {
//     const fired = yield* processScheduledEvents
//     for (const event of fired) { ... }
//   })
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { DurableObjectState } from "./durable-object-state.ts"
import type { SqlStorageValue } from "./durable-object-storage.ts"

const INIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS alchemy_scheduled_events (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  repeat_ms INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alchemy_scheduled_events_run_at
  ON alchemy_scheduled_events (run_at);
`

const ensureTable = Effect.gen(function* () {
  const ctx = yield* DurableObjectState
  yield* ctx.storage.sql.exec(INIT_TABLE_SQL)
})

export interface ScheduledEvent {
  id: string
  runAt: Date
  repeatMs?: number
  payload: unknown
}

interface EventRow extends Record<string, SqlStorageValue> {
  id: string
  run_at: number
  repeat_ms: number | null
  payload: string
}

const toScheduledEvent = (row: EventRow): ScheduledEvent => ({
  id: row.id,
  runAt: new Date(row.run_at),
  repeatMs: row.repeat_ms ?? undefined,
  payload: JSON.parse(row.payload) as unknown,
})

export const scheduleEvent = Effect.fnUntraced(function* (
  id: string,
  runAt: Date,
  payload: unknown,
  repeatMs?: number,
) {
  yield* ensureTable
  const ctx = yield* DurableObjectState

  yield* ctx.storage.sql.exec(
    `INSERT OR REPLACE INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload)
     VALUES (?, ?, ?, ?)`,
    id,
    runAt.getTime(),
    repeatMs ?? null,
    JSON.stringify(payload),
  )

  yield* reconcileAlarm
})

export const cancelEvent = Effect.fnUntraced(function* (id: string) {
  yield* ensureTable
  const ctx = yield* DurableObjectState

  yield* ctx.storage.sql.exec(
    `DELETE FROM alchemy_scheduled_events WHERE id = ?`,
    id,
  )

  yield* reconcileAlarm
})

export const listEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState
> = Effect.gen(function* () {
  yield* ensureTable
  const ctx = yield* DurableObjectState

  const cursor = yield* ctx.storage.sql.exec<EventRow>(
    `SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY run_at ASC`,
  )

  return yield* cursor.pipe(Stream.map(toScheduledEvent), Stream.runCollect)
})

export const processScheduledEvents: Effect.Effect<
  ScheduledEvent[],
  never,
  DurableObjectState
> = Effect.gen(function* () {
  yield* ensureTable
  const ctx = yield* DurableObjectState
  const now = Date.now()

  const cursor = yield* ctx.storage.sql.exec<EventRow>(
    `SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY run_at ASC`,
    now,
  )

  const fired = yield* cursor.pipe(
    Stream.mapEffect((row) =>
      (row.repeat_ms != null
        ? ctx.storage.sql.exec(
            `UPDATE alchemy_scheduled_events SET run_at = ? WHERE id = ?`,
            now + row.repeat_ms,
            row.id,
          )
        : ctx.storage.sql.exec(
            `DELETE FROM alchemy_scheduled_events WHERE id = ?`,
            row.id,
          )
      ).pipe(Effect.as(toScheduledEvent(row))),
    ),
    Stream.runCollect,
  )

  yield* reconcileAlarm
  return fired
})

const reconcileAlarm: Effect.Effect<void, never, DurableObjectState> =
  Effect.gen(function* () {
    const ctx = yield* DurableObjectState

    const next = yield* (yield* ctx.storage.sql.exec<{
      run_at: number
    }>(
      `SELECT run_at FROM alchemy_scheduled_events ORDER BY run_at ASC LIMIT 1`,
    )).pipe(Stream.take(1), Stream.runHead)

    if (Option.isSome(next)) {
      yield* ctx.storage.setAlarm(next.value.run_at)
    } else {
      yield* ctx.storage.deleteAlarm()
    }
  })

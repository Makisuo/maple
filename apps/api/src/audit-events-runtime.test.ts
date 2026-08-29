import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { auditLogEntries } from "@maple/db"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { processAuditEventsBatch } from "./audit-events-runtime"
import { AuditLogEvent, encodeAuditLogEventSync } from "./services/audit/audit-event"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_audit_consumer_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const event = (id: string) =>
	encodeAuditLogEventSync(
		new AuditLogEvent({
			orgId: ORG,
			id: Schema.decodeUnknownSync(AuditLogEvent.fields.id)(id),
			actorType: "user",
			source: "dashboard",
			action: "dashboard.created",
			outcome: "allowed",
			occurredAtMs: 1_700_000_000_000,
		}),
	)

/** One queue message, recording which terminal call the consumer made on it. */
const message = (body: unknown, attempts: number) => {
	const calls: string[] = []
	return {
		message: {
			body,
			attempts,
			ack: () => calls.push("ack"),
			retry: () => calls.push("retry"),
		},
		calls,
	}
}

const run = <A>(effect: Effect.Effect<A, never, Database>) => {
	const db = createTestDb(createdDbs)
	return effect.pipe(Effect.provide(db.layer))
}

const batchOf = (...messages: ReadonlyArray<{ readonly message: unknown }>) =>
	({ messages: messages.map((entry) => entry.message) }) as never

/**
 * A database whose every write fails, so the consumer's retry path is exercised
 * without depending on a real Postgres fault.
 */
const failingDatabase = Layer.succeed(Database, {
	execute: () =>
		Effect.fail(new DatabaseError({ message: "insert failed", cause: new Error("insert failed") })),
})

describe("processAuditEventsBatch", () => {
	it.effect("inserts a well-formed event and acks it", () =>
		run(
			Effect.gen(function* () {
				const first = message(event("11111111-1111-4111-8111-111111111111"), 1)
				yield* processAuditEventsBatch(batchOf(first))

				expect(first.calls).toEqual(["ack"])
				const database = yield* Database
				const rows = yield* database.execute((db) => db.select().from(auditLogEntries))
				expect(rows.map((row) => row.action)).toEqual(["dashboard.created"])
			}),
		),
	)

	// Redelivery is expected — the queue retries whole batches — so a second
	// delivery of an already-inserted event must be a no-op, not a duplicate row.
	it.effect("is idempotent across redelivery of the same event", () =>
		run(
			Effect.gen(function* () {
				const body = event("22222222-2222-4222-8222-222222222222")
				yield* processAuditEventsBatch(batchOf(message(body, 1)))
				yield* processAuditEventsBatch(batchOf(message(body, 2)))

				const database = yield* Database
				const rows = yield* database.execute((db) => db.select().from(auditLogEntries))
				expect(rows).toHaveLength(1)
			}),
		),
	)

	// Cloudflare routes a message to the DLQ only when the consumer retries it
	// past `max_retries`. Acking on the final attempt would discard the entry
	// instead, which is exactly the silent drop this branch exists to prevent.
	it.effect("retries a failed insert on the final attempt so the message reaches the DLQ", () =>
		Effect.gen(function* () {
			const exhausted = message(event("33333333-3333-4333-8333-333333333333"), 6)
			yield* processAuditEventsBatch(batchOf(exhausted))

			expect(exhausted.calls).toEqual(["retry"])
		}).pipe(Effect.provide(failingDatabase)),
	)

	it.effect("retries a failed insert while attempts remain", () =>
		Effect.gen(function* () {
			const failed = message(event("44444444-4444-4444-8444-444444444444"), 2)
			yield* processAuditEventsBatch(batchOf(failed))

			expect(failed.calls).toEqual(["retry"])
		}).pipe(Effect.provide(failingDatabase)),
	)

	// A message that cannot decode will never decode. Retrying only burns the
	// attempts that would otherwise carry a recoverable message to the DLQ.
	it.effect("acks a malformed message instead of retrying it forever", () =>
		run(
			Effect.gen(function* () {
				const malformed = message({ not: "an audit event" }, 1)
				yield* processAuditEventsBatch(batchOf(malformed))

				expect(malformed.calls).toEqual(["ack"])
				const database = yield* Database
				const rows = yield* database.execute((db) => db.select().from(auditLogEntries))
				expect(rows).toEqual([])
			}),
		),
	)
})

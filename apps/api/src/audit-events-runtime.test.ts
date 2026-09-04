import { describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/primitives"
import type { AuditLogRow } from "@maple/domain/tinybird"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { processAuditEventsBatch } from "./audit-events-runtime"
import { makeWarehouseServiceStub } from "@/routes/v2/v2-test-support"
import { AuditLogEvent, encodeAuditLogEventSync } from "./services/audit/audit-event"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_audit_consumer_test")
const OTHER_ORG = asOrgId("org_audit_consumer_other")

const event = (id: string, orgId: OrgId = ORG) =>
	encodeAuditLogEventSync(
		new AuditLogEvent({
			orgId,
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

const batchOf = (...messages: ReadonlyArray<{ readonly message: unknown }>) =>
	({ messages: messages.map((entry) => entry.message) }) as never

/** A warehouse whose `ingest` dies rather than failing — an unexpected defect. */
const dyingWarehouse = Layer.succeed(
	WarehouseQueryService,
	makeWarehouseServiceStub({
		ingest: () => Effect.die(new Error("ingest exploded")),
	}),
)

/** A warehouse whose `ingest` records each call, or fails every call. */
const warehouse = (fail = false) => {
	const written: Array<{ orgId: string; rows: ReadonlyArray<AuditLogRow> }> = []
	const layer = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (tenant, _datasource, rows) =>
				fail
					? Effect.fail(
							new WarehouseUpstreamError({ message: "tinybird down", pipeName: "audit_log", cause: new Error("down") }),
						)
					: Effect.sync(() => {
							// SAFETY: this stub only ever receives the audit datasource's rows.
							written.push({ orgId: tenant.orgId, rows: rows as ReadonlyArray<AuditLogRow> })
						}),
		}),
	)
	return { written, layer }
}

describe("processAuditEventsBatch", () => {
	it.effect("writes well-formed events through ingest, one batch per org, and acks them", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const first = message(event("11111111-1111-4111-8111-111111111111"), 1)
			const second = message(event("22222222-2222-4222-8222-222222222222"), 1)
			const other = message(event("33333333-3333-4333-8333-333333333333", OTHER_ORG), 1)
			yield* processAuditEventsBatch(batchOf(first, second, other)).pipe(Effect.provide(store.layer))

			expect(first.calls).toEqual(["ack"])
			expect(second.calls).toEqual(["ack"])
			expect(other.calls).toEqual(["ack"])
			expect(store.written.map((write) => [write.orgId, write.rows.length]).sort()).toEqual([
				[OTHER_ORG, 1],
				[ORG, 2],
			])
			expect(store.written.flatMap((write) => write.rows).every((row) => row.Action === "dashboard.created")).toBe(
				true,
			)
		}),
	)

	// Cloudflare routes a message to the DLQ only when the consumer retries it
	// past `max_retries`. Acking on the final attempt would discard the entry
	// instead, which is exactly the silent drop this branch exists to prevent.
	it.effect("retries a failed write on the final attempt so the message reaches the DLQ", () =>
		Effect.gen(function* () {
			const exhausted = message(event("44444444-4444-4444-8444-444444444444"), 6)
			yield* processAuditEventsBatch(batchOf(exhausted)).pipe(Effect.provide(warehouse(true).layer))
			expect(exhausted.calls).toEqual(["retry"])
		}),
	)

	it.effect("retries every message of a failed org batch while attempts remain", () =>
		Effect.gen(function* () {
			const a = message(event("55555555-5555-4555-8555-555555555555"), 2)
			const b = message(event("66666666-6666-4666-8666-666666666666"), 2)
			yield* processAuditEventsBatch(batchOf(a, b)).pipe(Effect.provide(warehouse(true).layer))
			expect(a.calls).toEqual(["retry"])
			expect(b.calls).toEqual(["retry"])
		}),
	)

	// A typed failure retries; so must a defect. Catching only the failure
	// channel would let an unexpected throw escape the consumer, and Cloudflare
	// treats a consumer that neither acked nor retried as a retry anyway — but
	// silently, with no log and no DLQ accounting.
	it.effect("retries when the write dies instead of failing", () =>
		Effect.gen(function* () {
			const defect = message(event("77777777-7777-4777-8777-777777777777"), 2)
			yield* processAuditEventsBatch(batchOf(defect)).pipe(Effect.provide(dyingWarehouse))
			expect(defect.calls).toEqual(["retry"])
		}),
	)

	// A message that cannot decode will never decode. Retrying only burns the
	// attempts that would otherwise carry a recoverable message to the DLQ.
	it.effect("acks a malformed message instead of retrying it forever", () =>
		Effect.gen(function* () {
			const store = warehouse()
			const malformed = message({ not: "an audit event" }, 1)
			const fine = message(event("77777777-7777-4777-8777-777777777777"), 1)
			yield* processAuditEventsBatch(batchOf(malformed, fine)).pipe(Effect.provide(store.layer))

			expect(malformed.calls).toEqual(["ack"])
			expect(fine.calls).toEqual(["ack"])
			expect(store.written).toHaveLength(1)
		}),
	)
})

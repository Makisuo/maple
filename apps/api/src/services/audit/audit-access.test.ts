import { describe, expect, it } from "@effect/vitest"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import { makeMemoryAuditLog } from "./AuditLogService"
import { auditAttribution, recordRawSqlAudit, withAuditedRead } from "./audit-access"
import { AuditLogService } from "./AuditLogService"

const ORG = Schema.decodeUnknownSync(OrgId)("org_audit_access_test")
const USER = Schema.decodeUnknownSync(UserId)("user_audit_access_test")

/** The `{ group, endpoint }` a security middleware receives for one endpoint. */
const endpointOf = (api: { readonly groups: Record<string, HttpApiGroup.Top> }, group: string, name: string) => {
	const found = api.groups[group]
	if (found === undefined) throw new Error(`no group ${group}`)
	const endpoint = found.endpoints[name] as HttpApiEndpoint.Top | undefined
	if (endpoint === undefined) throw new Error(`no endpoint ${group}.${name}`)
	return { group: found, endpoint }
}

const request = (method: string, url: string, body?: string) =>
	HttpServerRequest.fromWeb(
		new Request(`https://api.test${url}`, {
			method,
			headers: { "cf-ray": "ray-1", "cf-connecting-ip": "203.0.113.7" },
			...(body !== undefined ? { body } : undefined),
		}),
	)

class HandlerFailure extends Schema.TaggedError<HandlerFailure>()("HandlerFailure", {
	message: Schema.String,
}) {}

const subject = {
	orgId: ORG,
	actor: { type: "user" as const, userId: USER },
	source: "dashboard" as const,
}

describe("withAuditedRead", () => {
	it.effect("records a telemetry read for an endpoint whose GROUP carries the annotation", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const req = request("POST", "/internal/query-engine/execute-batch?x=1", '{"requests":[]}')
			const options = endpointOf(MapleInternalApi, "queryEngine", "executeBatch")
			// The handler reads the body first, exactly as a real one would.
			const handler = req.text.pipe(Effect.map(() => HttpServerResponse.empty({ status: 200 })))
			yield* withAuditedRead(audit, req, options, subject)(handler)

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries).toHaveLength(1)
			const entry = entries[0]!
			expect(entry.action).toBe("telemetry.read")
			expect(entry.userId).toBe(USER)
			expect(entry.requestId).toBe("ray-1")
			expect(entry.metadata).toMatchObject({
				endpoint: "queryEngine.executeBatch",
				method: "POST",
				status: 200,
				body: '{"requests":[]}',
			})
		}),
	)

	it.effect("records session replay reads on the v2 group and nothing for unannotated endpoints", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const ok = Effect.succeed(HttpServerResponse.empty({ status: 200 }))
			yield* withAuditedRead(audit, request("GET", "/v2/session_replays/s1"), endpointOf(MapleApiV2, "sessionReplays", "retrieve"), subject)(ok)
			yield* withAuditedRead(audit, request("GET", "/v2/api_keys"), endpointOf(MapleApiV2, "apiKeys", "list"), subject)(ok)

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries.map((entry) => entry.action)).toEqual(["session_replay.read"])
		}),
	)

	it.effect("still records an attempted read when the handler fails", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const failing = Effect.fail(new HandlerFailure({ message: "boom" }))
			const outcome = yield* withAuditedRead(
				audit,
				request("GET", "/v2/traces/t1"),
				endpointOf(MapleApiV2, "traces", "retrieve"),
				subject,
			)(failing).pipe(Effect.result)
			expect(Result.isFailure(outcome)).toBe(true)
			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries).toHaveLength(1)
			expect(entries[0]!.metadata).toMatchObject({ status: 0, endpoint: "traces.retrieve" })
		}),
	)
})

describe("auditAttribution", () => {
	it("attributes an agent tenant to the agent acting for the user", () => {
		const actorId = Schema.decodeUnknownSync(Schema.String)("actor_1")
		const attribution = auditAttribution(
			{ orgId: ORG, userId: USER, actorId: actorId as never, mcpClientName: "claude-code" },
			{ type: "api_key", source: "mcp" },
		)
		expect(attribution).toEqual({
			actor: { type: "agent", actorId, userId: USER, label: "claude-code" },
			source: "mcp",
		})
	})

	it("keeps a system token as system regardless of the tenant", () => {
		expect(auditAttribution({ orgId: ORG, userId: USER }, { type: "system", source: "system" })).toEqual({
			actor: { type: "system" },
			source: "system",
		})
	})
})

describe("recordRawSqlAudit", () => {
	it.effect("records a refused statement as denied and an executed one with its row count", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			const base = {
				tenant: { orgId: ORG, userId: USER },
				sql: "SELECT 1",
				context: "mcp.run_sql",
				startTime: "2026-08-29 09:00:00",
				endTime: "2026-08-29 10:00:00",
			}
			yield* recordRawSqlAudit({ ...base, result: { _tag: "rejected", reason: "missing $__orgFilter" } })
			yield* TestClock.adjust("1 second")
			yield* recordRawSqlAudit({ ...base, result: { _tag: "rows", rowCount: 3 } })

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries.map((entry) => [entry.action, entry.outcome])).toEqual([
				["telemetry.sql_executed", "allowed"],
				["telemetry.sql_executed", "denied"],
			])
			expect(entries[1]!.denialReason).toBe("missing $__orgFilter")
			expect(entries[0]!.metadata).toMatchObject({ sql: "SELECT 1", row_count: 3, context: "mcp.run_sql" })
			expect(entries[0]!.source).toBe("mcp")
		}).pipe(
			Effect.provideService(CurrentAuditActor, { type: "api_key", source: "mcp" }),
			Effect.provide(AuditLogService.layerMemory),
		),
	)
})

// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import {
	AiSessionsInternalApiGroup,
	CurrentTenant,
	V1SchemaErrors,
	V1UnexpectedErrors,
} from "@maple/domain/http"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/query-engine-integrations"
import { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "../v2/v2-test-support"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"
import { HttpAiSessionsInternalLive } from "./ai-sessions.http"

/**
 * The truncation contract of `POST /internal/ai-sessions/spans`: what the row
 * cap does, and what the byte cap does instead. Both are one-off shapes the
 * other warehouse reads have no equivalent of.
 */

class AiSessionsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(AiSessionsInternalApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const SESSION_ID = "wrun_01KZTEST"

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_ai_sessions" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_ai_sessions" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

/** One warehouse row, in the wire shape `aiSessionSpansRowSchema` decodes. */
const spanRow = (index: number) => ({
	traceId: "trace-1",
	spanId: `span-${index}`,
	parentSpanId: "",
	spanName: "chat",
	spanKind: "SPAN_KIND_CLIENT",
	serviceName: "agent-runner",
	durationMs: 12,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-19 10:00:00.000000000",
	spanAttributes: { "gen_ai.operation.name": "chat", "maple_ai.session.id": SESSION_ID },
	resourceAttributes: {},
})

const makeHarness = (overrides: Partial<WarehouseQueryServiceApi>) => {
	const routes = HttpApiBuilder.layer(AiSessionsOnlyApi).pipe(
		Layer.provide(HttpAiSessionsInternalLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub(overrides))),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const spans = async () => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and this route reads nothing out of it.
		const response = await handler(
			new Request("http://maple.test/internal/ai-sessions/spans", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: SESSION_ID,
					startTime: "2026-08-19 09:00:00",
					endTime: "2026-08-19 11:00:00",
				}),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return {
			status: response.status,
			body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
		}
	}

	return { spans, dispose }
}

describe("POST /internal/ai-sessions/spans", () => {
	it("answers a response-limit failure with the 413 the client can act on", async () => {
		const harness = makeHarness({
			compiledQueryBounded: () =>
				Effect.fail(
					new WarehouseResponseLimitError({ kind: "bytes", message: "response too large" }),
				),
		})

		try {
			const response = await harness.spans()
			expect(response.status).toBe(413)
			expect(response.body?._tag).toBe("@maple/http/ai-sessions/AiSessionTooLargeError")
		} finally {
			await harness.dispose()
		}
	})

	it("cuts the session at the row cap and says so", async () => {
		// The query asks for one row past the cap precisely so this case is
		// distinguishable from a session that exactly fills it.
		const rows = Array.from({ length: AI_SESSION_SPANS_MAX_SPANS + 1 }, (_, index) => spanRow(index))
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) => compiled.decodeRows(rows).pipe(Effect.orDie),
		})

		try {
			const response = await harness.spans()
			expect(response.status).toBe(200)
			expect(response.body?.truncated).toBe(true)
			expect(response.body?.data).toHaveLength(AI_SESSION_SPANS_MAX_SPANS)
		} finally {
			await harness.dispose()
		}
	})

	it("reports a session that fits as complete", async () => {
		const harness = makeHarness({
			compiledQueryBounded: (_tenant, compiled) =>
				compiled.decodeRows([spanRow(0), spanRow(1)]).pipe(Effect.orDie),
		})

		try {
			const response = await harness.spans()
			expect(response.status).toBe(200)
			expect(response.body?.truncated).toBe(false)
			expect(response.body?.data).toHaveLength(2)
		} finally {
			await harness.dispose()
		}
	})
})

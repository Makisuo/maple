import { describe, expect, it } from "@effect/vitest"
import { ChatApiGroup, CurrentTenant, V1SchemaErrors, V1UnexpectedErrors } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { McpToolExecutor, type McpToolExecutorShape } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { HttpChatLive } from "./chat.http"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"

class ChatOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(ChatApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_chat_approval" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_chat_approval" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

const makeHarness = (executor: McpToolExecutorShape) => {
	const routes = HttpApiBuilder.layer(ChatOnlyApi).pipe(
		Layer.provide(HttpChatLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(Layer.succeed(McpToolExecutor, executor)),
		// No session identifiers are sent in these requests, so the route never
		// touches the durable-object binding carried by WorkerEnvironment.
		Layer.provideMerge(Layer.succeed(WorkerEnvironment, {} as never)),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const apply = async () => {
		const response = await handler(
			new Request("http://maple.test/internal/chat/apply", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					tool: "delete_alert_rule",
					input: { rule_id: "alert_123", confirm: true },
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

	return { apply, dispose }
}

describe("POST /internal/chat/apply", () => {
	it("executes the approved tool under the authenticated tenant", async () => {
		let receivedTenant: TenantContext | undefined
		const harness = makeHarness({
			execute: (tenant) => {
				receivedTenant = tenant
				return Effect.succeed({
					content: [{ type: "text", text: "Alert rule deleted." }],
				})
			},
		})

		try {
			const response = await harness.apply()
			expect(response).toEqual({
				status: 200,
				body: { content: "Alert rule deleted." },
			})
			expect(receivedTenant?.orgId).toBe(TENANT.orgId)
			expect(receivedTenant?.userId).toBe(TENANT.userId)
		} finally {
			await harness.dispose()
		}
	})

	it("serializes executor defects as a declared 500 response", async () => {
		const harness = makeHarness({
			execute: () => Effect.die(new Error("missing service should never escape")),
		})

		try {
			const response = await harness.apply()
			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/errors/ChatToolExecutionError",
				tool: "delete_alert_rule",
				message: 'Could not apply "delete_alert_rule". Please try again.',
			})
		} finally {
			await harness.dispose()
		}
	})
})

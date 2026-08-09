import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { McpToolExecutor, type McpToolExecutorShape } from "./dispatcher"
import { McpLive } from "./app"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeMcpToolExecutorStubLayer = (
	execute: McpToolExecutorShape["execute"] = () =>
		Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
) => Layer.succeed(McpToolExecutor, { execute })

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

describe("MCP HTTP authorization", () => {
	it("challenges unauthenticated clients before MCP initialization", async () => {
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer(),
		).pipe(Layer.provideMerge(base))
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						host: "api.example.com",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			expect(response.status).toBe(401)
			expect(response.headers.get("www-authenticate")).toContain(
				'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
			)
			expect(response.headers.get("www-authenticate")).toContain('scope="mcp:tools"')
		} finally {
			await dispose()
		}
	})

	it("accepts an audience-bound OAuth key behind a forwarded HTTPS proxy", async () => {
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		let executedOrgId: string | undefined
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer((tenant) => {
				executedOrgId = tenant.orgId
				return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] })
			}),
		).pipe(Layer.provideMerge(base))
		const orgId = Schema.decodeUnknownSync(OrgId)("org_test")
		const userId = Schema.decodeUnknownSync(UserId)("user_test")
		const key = await Effect.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(orgId, userId, {
					name: "OAuth MCP test",
					kind: "mcp",
					scopes: ["mcp:tools"],
					metadataJson: {
						source: "maple_mcp_oauth",
						roles: ["org:member"],
						clientId: "client_test",
						resource: "https://api.example.com/mcp",
					},
				})
			}).pipe(Effect.provide(services)),
		)
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			expect(response.status).toBe(200)

			const sessionId = response.headers.get("mcp-session-id")
			expect(sessionId).not.toBeNull()
			await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
						"mcp-session-id": sessionId!,
						"mcp-protocol-version": "2025-06-18",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					}),
				}),
				Context.empty() as never,
			)
			const called = await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
						"mcp-session-id": sessionId!,
						"mcp-protocol-version": "2025-06-18",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "inspect_trace", arguments: {} },
					}),
				}),
				Context.empty() as never,
			)
			const calledBody = await called.clone().text()
			expect({ status: called.status, body: calledBody }).toEqual({
				status: 200,
				body: expect.any(String),
			})
			expect(executedOrgId).toBe(orgId)
		} finally {
			await dispose()
		}
	})
})

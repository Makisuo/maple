import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "../services/ApiKeysService"
import { AuthService } from "../services/AuthService"
import { McpLive } from "./app"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

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
		const services = Layer.mergeAll(ApiKeysService.layer, AuthService.layer).pipe(
			Layer.provideMerge(base),
		)
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
		const services = Layer.mergeAll(ApiKeysService.layer, AuthService.layer).pipe(
			Layer.provideMerge(base),
		)
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
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			expect(response.status).toBe(200)
		} finally {
			await dispose()
		}
	})
})

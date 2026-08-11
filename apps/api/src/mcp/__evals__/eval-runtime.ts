import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { McpServicesLive } from "@/runtime/mcp-service-graph"
import { Env } from "@/platform/Env"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { createTestDb } from "@/platform/test-pglite"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { FIXTURES } from "./utils"

const INTERNAL_TOKEN = "eval-internal-token"

const testEnv = (): Record<string, string> => ({
	PORT: "3472",
	TINYBIRD_HOST: "https://maple-eval.tinybird.co",
	TINYBIRD_TOKEN: "eval-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "eval-root-password",
	MAPLE_DEFAULT_ORG_ID: FIXTURES.orgId,
	INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "eval-lookup-key",
	MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
	MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
})

export interface EvalRuntime {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly runtime: ManagedRuntime.ManagedRuntime<any, never>
	readonly tenant: TenantContext
	readonly dispose: () => Promise<void>
}

/**
 * Build a node runtime for the app services backed by an in-memory PGlite DB +
 * test config (mirrors apps/api `getMapleAgentSetup`/buildSetup, swapping Hyperdrive→PGlite).
 * The warehouse client must be faked separately via `installFakeWarehouse` —
 * this runtime uses the REAL WarehouseQueryService. The returned `requestLayer`
 * carries the already-resolved MCP tenant, matching the post-auth dispatcher
 * context shared by HTTP and RPC.
 */
export const makeEvalRuntime = (): EvalRuntime => {
	const testDb = createTestDb()
	const env = testEnv()

	const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	const workerEnvLive = Layer.succeed(WorkerEnvironment, env as Record<string, unknown>)

	const layer = McpServicesLive.pipe(
		Layer.provide(Layer.mergeAll(configLive, envLive, databaseLive, workerEnvLive)),
	)
	// `as any`: the residual requirement set is satisfied at runtime (same pattern
	// as apps/api/src/agent.ts buildSetup).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const runtime = ManagedRuntime.make(layer as any) as ManagedRuntime.ManagedRuntime<any, never>

	const tenant: TenantContext = {
		orgId: Schema.decodeSync(OrgId)(FIXTURES.orgId),
		userId: Schema.decodeSync(UserId)("internal-service"),
		roles: [],
		authMode: "self_hosted",
	}

	return {
		runtime,
		tenant,
		dispose: async () => {
			await runtime.dispose()
			await testDb.close()
		},
	}
}

/**
 * Invoke a tool handler directly (no LLM) through the eval runtime + request
 * layer. Used to validate the full-execution wiring without spending an LLM call.
 */
export const runToolDirect = async (
	rt: EvalRuntime,
	name: string,
	params: unknown,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
	return rt.runtime.runPromise(
		McpToolExecutor.pipe(Effect.flatMap((executor) => executor.execute(rt.tenant, name, params))),
	)
}

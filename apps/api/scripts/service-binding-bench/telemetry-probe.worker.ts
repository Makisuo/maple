let initialized = false
let initialization: Promise<void> | undefined

/**
 * The smallest useful telemetry-route island with today's module boundaries.
 * It deliberately loads the route, warehouse, auth, cache, and DB modules but
 * not unrelated billing, alerts, email, OAuth-provider, MCP, or webhook code.
 */
const initialize = (): Promise<void> => {
	if (initialization !== undefined) return initialization
	initialization = Promise.all([
		import("../../src/routes/v2/telemetry.http"),
		import("../../src/services/warehouse/WarehouseQueryService"),
		import("../../src/services/warehouse/QueryEngineService"),
		import("../../src/services/auth/ApiAuthorizationV2Layer"),
		import("../../src/services/auth/ApiV2RateLimiter"),
		import("../../src/services/auth/OrgMembershipService"),
		import("../../src/services/org/ApiKeysService"),
		import("../../src/platform/CacheBackendLive"),
		import("../../src/platform/DatabasePgLive"),
		import("../../src/platform/pg-connection-scope"),
	]).then(() => undefined)
	return initialization
}

export default {
	async fetch(): Promise<Response> {
		const wasInitialized = initialized
		const startedAt = performance.now()
		await initialize()
		const moduleEvaluationMs = performance.now() - startedAt
		initialized = true
		return Response.json({
			graph: "telemetry-island",
			cached: wasInitialized,
			moduleEvaluationMs,
		})
	},
}

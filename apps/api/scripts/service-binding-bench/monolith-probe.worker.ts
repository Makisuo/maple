let initialized = false
let initialization: Promise<void> | undefined

const initialize = (): Promise<void> => {
	if (initialization !== undefined) return initialization
	initialization = Promise.all([
		import("../../src/runtime/service-graph"),
		import("../../src/runtime/http-graph"),
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
			graph: "monolith",
			cached: wasInitialized,
			moduleEvaluationMs,
		})
	},
}

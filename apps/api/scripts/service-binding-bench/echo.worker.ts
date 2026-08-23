export default {
	fetch(): Response {
		const startedAt = performance.now()
		const response = new Response("ok")
		response.headers.set("x-target-handler-ms", (performance.now() - startedAt).toFixed(4))
		return response
	},
}

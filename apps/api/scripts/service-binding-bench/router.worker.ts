interface ServiceBinding {
	fetch(request: Request): Promise<Response>
}

interface Env {
	ECHO: ServiceBinding
	MONOLITH: ServiceBinding
	TELEMETRY: ServiceBinding
}

const withBindingTiming = async (service: ServiceBinding, request: Request): Promise<Response> => {
	const startedAt = performance.now()
	const response = await service.fetch(request)
	const bindingMs = performance.now() - startedAt
	const headers = new Headers(response.headers)
	headers.set("x-service-binding-ms", bindingMs.toFixed(4))
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const pathname = new URL(request.url).pathname
		switch (pathname) {
			case "/ready":
			case "/direct":
				return new Response("ok", { headers: { "x-service-binding-ms": "0" } })
			case "/bound":
				return withBindingTiming(env.ECHO, request)
			case "/probe/monolith":
				return withBindingTiming(env.MONOLITH, request)
			case "/probe/telemetry":
				return withBindingTiming(env.TELEMETRY, request)
			default:
				return new Response("Not found", { status: 404 })
		}
	},
}

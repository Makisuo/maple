type Env = {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		const assetResponse = await env.ASSETS.fetch(request)
		if (assetResponse.status !== 404) {
			// `/version.json` is the one asset whose whole job is to be stale-free:
			// clients poll it to learn a newer bundle is deployed. Served from any
			// cache it would report the deploy the tab is already running, which is
			// exactly the answer that makes the check useless.
			if (url.pathname === "/version.json") {
				const response = new Response(assetResponse.body, assetResponse)
				response.headers.set("Cache-Control", "no-store, must-revalidate")
				return response
			}
			return assetResponse
		}

		// Fetch "/" rather than "/index.html": the assets layer's
		// auto-trailing-slash handling answers explicit /index.html requests
		// with a 307 to "/", which would bounce deep links to the root.
		return env.ASSETS.fetch(new Request(new URL("/", url), request))
	},
}

type Env = {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		const assetResponse = await env.ASSETS.fetch(request)
		if (assetResponse.status !== 404) {
			return assetResponse
		}

		// Fetch "/" rather than "/index.html": the assets layer's
		// auto-trailing-slash handling answers explicit /index.html requests
		// with a 307 to "/", which would bounce deep links to the root.
		return env.ASSETS.fetch(new Request(new URL("/", url), request))
	},
}

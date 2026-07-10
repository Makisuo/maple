type Env = {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

// The Local Mode docs moved to the standalone Maple Local site
// (apps/local-landing). These 301s must ship together with (or after) the
// maplelocal.dev zone going live — see apps/local-landing/README.md.
const REDIRECTS: Record<string, string> = {
	"/docs/local-mode": "https://maplelocal.dev/docs/getting-started/quickstart",
	"/docs/local-mode/cli-reference": "https://maplelocal.dev/docs/reference/cli",
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		const redirect = REDIRECTS[url.pathname.replace(/\/$/, "")]
		if (redirect) return Response.redirect(redirect, 301)

		const assetResponse = await env.ASSETS.fetch(request)
		if (assetResponse.status !== 404) return assetResponse

		const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request))
		return new Response(notFound.body, {
			status: 404,
			headers: notFound.headers,
		})
	},
}

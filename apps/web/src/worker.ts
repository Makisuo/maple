type Env = {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

/**
 * Frame and referrer policy, applied to document responses.
 *
 * The app is a single-page bundle, so every route is the same index.html and
 * there is no per-route server render to hang a header on — the path is all
 * this layer knows. That is enough for the split that matters:
 *
 *   - Everything except `/share/` refuses framing outright. The authed app has
 *     no reason to be in anyone's iframe, and until now nothing said so.
 *   - `/share/` allows framing at the document level, because embedding a
 *     public chart is a feature. *Which* links may be framed is decided by the
 *     API (`embeddable` on the resolve response) and enforced by the page, which
 *     is the only layer that knows which token it is holding.
 *
 * `Referrer-Policy: no-referrer` is share-specific and load-bearing rather than
 * hygienic: the token is in the share URL, so without it every cross-origin
 * request the page makes hands the token to a third party in `Referer`. The API
 * deliberately keeps tokens out of its own URLs; this is the other half.
 */
const SHARE_PATH_PREFIX = "/share/"

const isShareDocument = (pathname: string): boolean =>
	pathname === "/share" || pathname.startsWith(SHARE_PATH_PREFIX)

/** HTML only. A script or stylesheet is not framed, and `frame-ancestors` on one means nothing. */
const isHtmlResponse = (response: Response): boolean =>
	(response.headers.get("content-type") ?? "").includes("text/html")

const applyDocumentSecurityHeaders = (response: Response, pathname: string): Response => {
	if (!isHtmlResponse(response)) return response

	// Rebuilt field by field: a `Response` works as a `ResponseInit` (the spec
	// reads status/statusText/headers off it), but a spread does not — those are
	// prototype getters, so `{ ...response }` is an empty object and the result
	// would silently become a 200 with no headers at all.
	const headers = new Headers(response.headers)

	if (isShareDocument(pathname)) {
		headers.set("Referrer-Policy", "no-referrer")
	} else {
		headers.set("Content-Security-Policy", "frame-ancestors 'none'")
		headers.set("X-Frame-Options", "DENY")
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
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
			// `/` resolves to a real asset and returns here rather than through the
			// fallback below, so the headers have to be applied on both paths — this
			// one is the app's own front door.
			return applyDocumentSecurityHeaders(assetResponse, url.pathname)
		}

		// Fetch "/" rather than "/index.html": the assets layer's
		// auto-trailing-slash handling answers explicit /index.html requests
		// with a 307 to "/", which would bounce deep links to the root.
		//
		// Every SPA route lands here, which is what makes this the one place the
		// document's security headers can be set from the requested path.
		const document = await env.ASSETS.fetch(new Request(new URL("/", url), request))
		return applyDocumentSecurityHeaders(document, url.pathname)
	},
}

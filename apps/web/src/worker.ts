import { alertChartIdFromPath, ogIdFromPath, shareTokenFromPath } from "./og/share-links"
import { renderAlertChartImage } from "./og/alert-chart"
import { fetchShareOgMeta, renderShareOgImage, shareOgMetaRewriter } from "./og/share-preview"
import { apiTarget, type ApiTarget, type WebWorkerEnv } from "./worker-env"

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

/**
 * Inline a share link's own `og:*` tags, when it has any.
 *
 * Applied to every viewer, not only to crawlers: sniffing user agents to serve
 * different HTML is cloaking, and the tags change nothing for a human — the app
 * replaces the head as soon as it boots.
 */
const applyShareOgMeta = async (
	response: Response,
	url: URL,
	api: ApiTarget | undefined,
): Promise<Response> => {
	const token = shareTokenFromPath(url.pathname)
	if (api === undefined || token === undefined || !isHtmlResponse(response)) return response

	const meta = await fetchShareOgMeta(api, token)
	// No meta means an org-only link, a dead one, or an API that did not answer.
	// All three keep the generic card, and none of them is worth a broken page.
	return meta === undefined ? response : shareOgMetaRewriter(meta, url.origin).transform(response)
}

export default {
	async fetch(request: Request, env: WebWorkerEnv): Promise<Response> {
		const url = new URL(request.url)
		const api = apiTarget(env)

		// Ahead of the assets lookup: this path has no asset behind it, and the
		// 404 the assets layer returns for it would fall through to the SPA shell.
		const ogId = ogIdFromPath(url.pathname)
		if (ogId !== undefined) {
			return api === undefined
				? new Response(null, { status: 404 })
				: renderShareOgImage(api, ogId, env.ASSETS)
		}

		// Also ahead of the assets lookup, and for the same reason: `/alerts/…` is
		// a real SPA route, so the shell would answer this path with HTML in an
		// `<img>` slot rather than a 404 anyone could diagnose.
		const chartId = alertChartIdFromPath(url.pathname)
		if (chartId !== undefined) {
			return api === undefined
				? new Response(null, { status: 404 })
				: renderAlertChartImage(api, chartId, env.ASSETS)
		}

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
			//
			// `/share/<token>` also lands here, not in the fallback: with
			// `not_found_handling: single-page-application` the assets layer answers
			// unknown paths with the shell itself, at status 200. The share preview
			// therefore has to be applied on this branch too — putting it only on
			// the fallback below silently disables it in every deployment.
			return applyShareOgMeta(applyDocumentSecurityHeaders(assetResponse, url.pathname), url, api)
		}

		// Fetch "/" rather than "/index.html": the assets layer's
		// auto-trailing-slash handling answers explicit /index.html requests
		// with a 307 to "/", which would bounce deep links to the root.
		//
		// Every SPA route lands here, which is what makes this the one place the
		// document's security headers can be set from the requested path.
		const document = await env.ASSETS.fetch(new Request(new URL("/", url), request))
		// Reached when the assets layer 404s rather than serving the shell — a
		// deployment without SPA not-found handling, or a request it declines.
		return applyShareOgMeta(applyDocumentSecurityHeaders(document, url.pathname), url, api)
	},
}

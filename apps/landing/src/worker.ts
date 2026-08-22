import { API_ORIGIN } from "./lib/agent-resources"

type Env = {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

/**
 * Every citable page ships a markdown twin at `<path>.md` (see
 * `src/lib/page-markdown.ts`). A client can ask for it two ways: by URL suffix,
 * which is a plain static asset and needs nothing from this worker, or by
 * `Accept: text/markdown` on the HTML URL, which is what this handles.
 *
 * The header must name `text/markdown` *literally*. Every browser's Accept ends
 * in a catch-all wildcard, so treating a wildcard as a match would serve
 * markdown to every human visitor.
 */
const wantsMarkdown = (request: Request): boolean => acceptHeader(request).includes("text/markdown")

/**
 * Browsers always name `text/html`; `curl`, SDK HTTP clients, and agents send
 * `*\/*` or nothing. That difference picks the 404 representation: an HTML
 * page for a person, a short markdown note for everything else.
 */
const acceptsHtml = (request: Request): boolean => {
	const accept = acceptHeader(request)
	return accept.includes("text/html") || accept.includes("application/xhtml+xml")
}

const acceptHeader = (request: Request): string => (request.headers.get("Accept") ?? "").toLowerCase()

/** `/pricing` → `/pricing.md`; `/docs/x/y/` → `/docs/x/y.md`; `/` → `/index.md`. Extensions opt out. */
export const markdownTwin = (pathname: string): string | null => {
	const path = pathname.replace(/\/+$/, "") || "/"
	if (path === "/") return "/index.md"
	if (/\.[a-z0-9]+$/i.test(path)) return null
	return `${path}.md`
}

/**
 * Paths that belong to the API, not the website. Nothing under them exists
 * here, and a client hitting them is a program expecting JSON — so the 404
 * uses the API's error envelope and says where the API actually lives.
 */
const API_PATH = /^\/(api|v1|v2|rpc|mcp)(\/|$)/
export const isApiPath = (pathname: string): boolean => API_PATH.test(pathname)

/**
 * Mirrors `v2RouteNotFoundBody` from `@maple/domain/http/v2` (see
 * `worker.test.ts`, which asserts the two agree). Hand-written here because the
 * domain module drags Effect Schema into a worker whose entire job is header
 * negotiation — the API worker documents what that costs at startup.
 */
export const apiNotFoundBody = (method: string, pathname: string, origin: string) => ({
	error: {
		_tag: "@maple/http/v2/RouteNotFoundError",
		type: "not_found_error",
		code: "route_not_found",
		title: "No such route",
		message: `No route matches ${method.toUpperCase()} ${pathname} on ${origin}, which serves the Maple website. The Maple API is at ${API_ORIGIN} — reference: ${API_ORIGIN}/v2/docs, OpenAPI: ${origin}/openapi.json, MCP server: ${API_ORIGIN}/mcp.`,
		retryable: false,
		recovery: "fix_request",
	},
})

/** The markdown 404: what was asked for, and where to look instead. */
export const notFoundMarkdown = (pathname: string, origin: string): string =>
	[
		"# 404 — Not found",
		"",
		`There is no page at \`${pathname}\` on ${origin}.`,
		"",
		"## Where to look next",
		"",
		`- [Site index for agents](${origin}/llms.txt) — every section of the site with its markdown URL`,
		`- [Sitemap](${origin}/sitemap-index.xml)`,
		`- [Documentation](${origin}/docs.md) · [Full docs, single file](${origin}/llms-full.txt)`,
		`- [Pricing](${origin}/pricing.md) · [Changelog](${origin}/changelog.md) · [Roadmap](${origin}/roadmap.md)`,
		`- [API reference](${API_ORIGIN}/v2/docs) · [OpenAPI spec](${origin}/openapi.json) · [MCP server manifest](${origin}/.well-known/mcp.json)`,
		`- [About](${origin}/about.md) · [Contact](${origin}/contact.md)`,
		"",
		"Append `.md` to any page URL, or send `Accept: text/markdown`, to receive its markdown source.",
		"",
	].join("\n")

const MARKDOWN_TYPE = "text/markdown; charset=utf-8"

const withHeaders = (response: Response, set: Record<string, string>): Response => {
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(set)) headers.set(name, value)
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** RFC 8288 alternate link, so a client that got HTML can find the markdown without guessing. */
const alternateLink = (twinUrl: URL): string => `<${twinUrl}>; rel="alternate"; type="text/markdown"`

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const twin = markdownTwin(url.pathname)
		const twinUrl = twin ? new URL(twin, url) : null

		if (twinUrl && wantsMarkdown(request)) {
			const candidate = await env.ASSETS.fetch(new Request(twinUrl, request))
			// `not_found_handling: "single-page-application"` in wrangler.jsonc can
			// answer a missing asset with the SPA shell at status 200, so the
			// content-type is the real test of whether the twin exists.
			const isMarkdown = candidate.headers.get("Content-Type")?.includes("text/markdown")
			if (candidate.ok && isMarkdown) return withHeaders(candidate, { Vary: "Accept" })
		}

		const assetResponse = await env.ASSETS.fetch(request)
		// Vary only on the paths that actually have two representations. Putting
		// it on hashed CSS/JS/images would split their cache entries for nothing.
		if (assetResponse.status !== 404) {
			return twinUrl
				? withHeaders(assetResponse, { Vary: "Accept", Link: alternateLink(twinUrl) })
				: assetResponse
		}

		if (isApiPath(url.pathname)) {
			return Response.json(apiNotFoundBody(request.method, url.pathname, url.origin), {
				status: 404,
				headers: { Vary: "Accept", "Cache-Control": "no-store" },
			})
		}

		if (!acceptsHtml(request)) {
			return new Response(notFoundMarkdown(url.pathname, url.origin), {
				status: 404,
				headers: {
					"Content-Type": MARKDOWN_TYPE,
					Vary: "Accept",
					"X-Content-Type-Options": "nosniff",
				},
			})
		}

		// Deliberately *not* `new Request(url, request)`: the ASSETS.fetch above has
		// already consumed the body stream, so re-deriving from `request` throws
		// `Body has already been used` and the runtime answers 500. That is invisible
		// for GETs (no body) and turned every POST to an unknown path into a 500.
		const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url)))
		return withHeaders(new Response(notFound.body, { status: 404, headers: notFound.headers }), {
			Vary: "Accept",
		})
	},
}

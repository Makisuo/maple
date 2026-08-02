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
const wantsMarkdown = (request: Request): boolean =>
	(request.headers.get("Accept") ?? "").toLowerCase().includes("text/markdown")

/** `/pricing` → `/pricing.md`; `/docs/x/y/` → `/docs/x/y.md`. Extensions opt out. */
const markdownTwin = (pathname: string): string | null => {
	const path = pathname.replace(/\/+$/, "") || "/"
	if (path === "/") return null
	if (/\.[a-z0-9]+$/i.test(path)) return null
	return `${path}.md`
}

const withVary = (response: Response): Response => {
	const headers = new Headers(response.headers)
	headers.set("Vary", "Accept")
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (wantsMarkdown(request)) {
			const twin = markdownTwin(url.pathname)
			if (twin) {
				const candidate = await env.ASSETS.fetch(new Request(new URL(twin, url), request))
				// `not_found_handling: "single-page-application"` in wrangler.jsonc can
				// answer a missing asset with the SPA shell at status 200, so the
				// content-type is the real test of whether the twin exists.
				const isMarkdown = candidate.headers.get("Content-Type")?.includes("text/markdown")
				if (candidate.ok && isMarkdown) return withVary(candidate)
			}
		}

		const assetResponse = await env.ASSETS.fetch(request)
		// Vary only on the paths that actually have two representations. Putting
		// it on hashed CSS/JS/images would split their cache entries for nothing.
		if (assetResponse.status !== 404) {
			return markdownTwin(url.pathname) ? withVary(assetResponse) : assetResponse
		}

		const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request))
		return new Response(notFound.body, {
			status: 404,
			headers: notFound.headers,
		})
	},
}

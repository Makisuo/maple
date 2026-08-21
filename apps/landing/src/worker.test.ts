import { v2RouteNotFoundBody } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"
import worker, { apiNotFoundBody, isApiPath, markdownTwin, notFoundMarkdown } from "./worker"

/**
 * A stand-in for the Workers Assets binding: a path → body map with the same
 * content-type sniffing the real layer does, answering 404 for anything else.
 */
const assets = (files: Record<string, string>) => ({
	fetch: async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url)
		// Workers Assets resolves a directory request to its index.html.
		const resolved = pathname.endsWith("/") && !(pathname in files) ? `${pathname}index.html` : pathname
		const body = files[resolved]
		if (body === undefined) return new Response(null, { status: 404 })
		const type = resolved.endsWith(".md")
			? "text/markdown; charset=utf-8"
			: resolved.endsWith(".html")
				? "text/html; charset=utf-8"
				: "application/octet-stream"
		return new Response(body, { status: 200, headers: { "Content-Type": type } })
	},
})

const env = {
	ASSETS: assets({
		"/index.html": "<html>home</html>",
		"/index.md": "# Maple\n",
		"/pricing/index.html": "<html>pricing</html>",
		"/pricing.md": "# Pricing\n",
		"/_astro/app.js": "console.log(1)",
		"/404.html": "<html>not found</html>",
	}),
}

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
	worker.fetch(new Request(`https://maple.dev${path}`, { headers, ...init }), env)

describe("markdownTwin", () => {
	it("maps page paths to their .md twin, including the home page", () => {
		expect(markdownTwin("/")).toBe("/index.md")
		expect(markdownTwin("/pricing")).toBe("/pricing.md")
		expect(markdownTwin("/pricing/")).toBe("/pricing.md")
		expect(markdownTwin("/docs/x/y/")).toBe("/docs/x/y.md")
	})

	it("opts out anything with an extension", () => {
		expect(markdownTwin("/pricing.md")).toBeNull()
		expect(markdownTwin("/_astro/app.js")).toBeNull()
		expect(markdownTwin("/openapi.json")).toBeNull()
	})
})

describe("markdown content negotiation", () => {
	it("serves the home page twin for Accept: text/markdown on /", async () => {
		const response = await get("/", { Accept: "text/markdown" })
		expect(response.status).toBe(200)
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
		expect(response.headers.get("Vary")).toBe("Accept")
		expect(await response.text()).toBe("# Maple\n")
	})

	it("serves the twin for a page URL, with and without a trailing slash", async () => {
		for (const path of ["/pricing", "/pricing/"]) {
			const response = await get(path, { Accept: "text/markdown, text/html;q=0.5" })
			expect(response.status).toBe(200)
			expect(response.headers.get("Content-Type")).toContain("text/markdown")
			expect(await response.text()).toBe("# Pricing\n")
		}
	})

	it("keeps serving HTML to browsers, with Vary and an alternate Link", async () => {
		const response = await get("/pricing/", { Accept: BROWSER_ACCEPT })
		expect(response.status).toBe(200)
		expect(response.headers.get("Content-Type")).toContain("text/html")
		expect(response.headers.get("Vary")).toBe("Accept")
		expect(response.headers.get("Link")).toBe(
			'<https://maple.dev/pricing.md>; rel="alternate"; type="text/markdown"',
		)
		expect(await response.text()).toBe("<html>pricing</html>")
	})

	it("treats a wildcard Accept as HTML, never markdown", async () => {
		const response = await get("/pricing/", { Accept: "*/*" })
		expect(response.headers.get("Content-Type")).toContain("text/html")
	})

	it("does not add Vary or Link to assets that have a single representation", async () => {
		const response = await get("/_astro/app.js", { Accept: "*/*" })
		expect(response.status).toBe(200)
		expect(response.headers.get("Vary")).toBeNull()
		expect(response.headers.get("Link")).toBeNull()
	})
})

describe("404 handling", () => {
	it("returns the HTML 404 page to browsers", async () => {
		const response = await get("/nope", { Accept: BROWSER_ACCEPT })
		expect(response.status).toBe(404)
		expect(response.headers.get("Content-Type")).toContain("text/html")
		expect(response.headers.get("Vary")).toBe("Accept")
		expect(await response.text()).toBe("<html>not found</html>")
	})

	it("returns a markdown 404 with recovery links to non-browser clients", async () => {
		for (const headers of [{ Accept: "*/*" }, {}, { Accept: "text/markdown" }]) {
			const response = await get("/some-path-that-does-not-exist", headers)
			expect(response.status).toBe(404)
			expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
			expect(response.headers.get("Vary")).toBe("Accept")
			const body = await response.text()
			expect(body).toContain("/some-path-that-does-not-exist")
			expect(body).toContain("https://maple.dev/llms.txt")
			expect(body).toContain("https://maple.dev/sitemap-index.xml")
			expect(body).toContain("https://maple.dev/openapi.json")
		}
	})

	it("answers API-shaped paths with the v2 error envelope", async () => {
		for (const path of ["/api/things", "/v2/dashboards", "/v1", "/mcp"]) {
			const response = await get(path, { Accept: "application/json" })
			expect(response.status).toBe(404)
			expect(response.headers.get("Content-Type")).toContain("application/json")
			const body = await response.json()
			expect(body.error._tag).toBe("@maple/http/v2/RouteNotFoundError")
			expect(body.error.message).toContain("https://api.maple.dev")
		}
	})

	it("survives a POST with a body to an unknown path (no 'Body has already been used')", async () => {
		const response = await get(
			"/nope",
			{ Accept: BROWSER_ACCEPT, "Content-Type": "text/plain" },
			{ method: "POST", body: "hello" },
		)
		expect(response.status).toBe(404)
	})

	it("does not mistake documented paths for API paths", () => {
		expect(isApiPath("/api-latency")).toBe(false)
		expect(isApiPath("/apis")).toBe(false)
		expect(isApiPath("/api/x")).toBe(true)
		expect(isApiPath("/v2")).toBe(true)
	})
})

describe("parity with the API's own envelope", () => {
	it("agrees with @maple/domain's RouteNotFound on every stable field", () => {
		const canonical = v2RouteNotFoundBody("GET", "/x", {
			openApiUrl: "https://maple.dev/openapi.json",
			docsUrl: "https://api.maple.dev/v2/docs",
		})
		const { message: _ours, ...ours } = apiNotFoundBody("GET", "/x", "https://maple.dev").error
		const { message: _theirs, ...theirs } = canonical
		expect(ours).toEqual(theirs)
	})

	it("renders the markdown note with absolute links", () => {
		expect(notFoundMarkdown("/x", "https://maple.dev")).toContain("(https://maple.dev/llms.txt)")
	})
})

/**
 * The machine-facing entry points, named once. `llms.txt`, the home page
 * twin, the docs pages, and the worker's 404 note all quote these, so a moved
 * endpoint is a one-line change.
 *
 * Plain constants, no `astro:*` imports: `worker.ts` (bundled for the edge) and
 * the unit tests both read this.
 */

export const API_ORIGIN = "https://api.maple.dev"
export const GITHUB_URL = "https://github.com/MapleTechLabs/maple"
export const DISCORD_URL = "https://discord.gg/BnXjKuwJqP"
export const X_URL = "https://x.com/maple_dev"

export const SUPPORT_EMAIL = "support@maple.dev"
export const PRIVACY_EMAIL = "privacy@getmaple.dev"
export const LEGAL_EMAIL = "legal@getmaple.dev"

/** Paths on the website (`maple.dev`). */
export const SITE_PATHS = {
	llmsTxt: "/llms.txt",
	llmsFull: "/llms-full.txt",
	sitemap: "/sitemap-index.xml",
	openapi: "/openapi.json",
	mcpManifest: "/.well-known/mcp.json",
	mcpServerJson: "/.well-known/mcp/server.json",
	apiDocs: "/docs/api",
	mcpDocs: "/docs/mcp",
	about: "/about",
	contact: "/contact",
} as const

/** Paths on the API (`api.maple.dev`). */
export const API_PATHS = {
	reference: "/v2/docs",
	openapi: "/openapi.json",
	mcp: "/mcp",
	mcpManifest: "/.well-known/mcp.json",
	oauthResource: "/.well-known/oauth-protected-resource/mcp",
	health: "/health",
} as const

export const apiUrl = (path: (typeof API_PATHS)[keyof typeof API_PATHS]) => `${API_ORIGIN}${path}`

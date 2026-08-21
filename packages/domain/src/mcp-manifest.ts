/**
 * The MCP registry `server.json` document for Maple's hosted MCP server.
 *
 * One definition, served from three places so they cannot drift: the API at
 * `/.well-known/mcp.json` (+ `/.well-known/mcp/server.json`), the marketing
 * site at the same paths, and — eventually — the public MCP registry. The
 * shape follows the registry schema referenced by `$schema`; the constraints
 * worth knowing are `name` (reverse-DNS namespace + `/` + server, 3–200
 * chars), `description` (1–100 chars), and a required `version`.
 *
 * Effect-free on purpose: the landing site renders this at build time and the
 * API worker's top-level module scope has to stay cheap (see `worker.ts`).
 */

export const MCP_SERVER_JSON_SCHEMA =
	"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"

/** Reverse-DNS registry name: `maple.dev` → `dev.maple`. */
export const MAPLE_MCP_SERVER_NAME = "dev.maple/maple"

/** Mirrors the `version` `McpServer.layerHttp` advertises in `initialize`. */
export const MAPLE_MCP_SERVER_VERSION = "1.0.0"

export const MAPLE_MCP_SERVER_DESCRIPTION =
	"Query Maple traces, logs, metrics, errors, dashboards, and alerts over the Model Context Protocol."

export interface MapleMcpManifestOptions {
	/** Origin of the API worker that serves `/mcp`, e.g. `https://api.maple.dev`. */
	readonly apiBaseUrl: string
	/** Origin of the marketing/docs site. Defaults to production. */
	readonly siteUrl?: string
}

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "")

export const mapleMcpServerManifest = ({
	apiBaseUrl,
	siteUrl = "https://maple.dev",
}: MapleMcpManifestOptions) => {
	const api = trimTrailingSlash(apiBaseUrl)
	const site = trimTrailingSlash(siteUrl)
	return {
		$schema: MCP_SERVER_JSON_SCHEMA,
		name: MAPLE_MCP_SERVER_NAME,
		title: "Maple",
		description: MAPLE_MCP_SERVER_DESCRIPTION,
		version: MAPLE_MCP_SERVER_VERSION,
		websiteUrl: `${site}/features/ai-mcp-integration`,
		repository: {
			url: "https://github.com/Makisuo/maple",
			source: "github",
			subfolder: "apps/api",
		},
		icons: [
			{
				src: `${site}/logo192.png`,
				mimeType: "image/png",
				sizes: ["192x192"],
			},
		],
		remotes: [
			{
				type: "streamable-http",
				url: `${api}/mcp`,
				headers: [
					{
						name: "Authorization",
						description:
							"`Bearer <Maple API key>` (`maple_ak_…`, created under Settings → API keys). Omit it to use OAuth instead: the server advertises its authorization server at `/.well-known/oauth-protected-resource/mcp`.",
						isRequired: false,
						isSecret: true,
					},
				],
			},
		],
	} as const
}

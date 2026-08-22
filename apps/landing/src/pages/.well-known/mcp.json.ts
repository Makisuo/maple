/**
 * `/.well-known/mcp.json` — the MCP registry `server.json` for Maple's hosted
 * MCP server, published on the website next to `llms.txt` and `openapi.json`.
 * The API serves the identical document at `api.maple.dev/.well-known/mcp.json`.
 */
import { mapleMcpServerManifest } from "@maple/domain/mcp-manifest"
import type { APIRoute } from "astro"
import { API_ORIGIN } from "../../lib/agent-resources"

export const GET: APIRoute = ({ site }) =>
	new Response(
		`${JSON.stringify(mapleMcpServerManifest({ apiBaseUrl: API_ORIGIN, siteUrl: site?.toString() }), null, 2)}\n`,
		{ headers: { "Content-Type": "application/json; charset=utf-8" } },
	)

import { describe, expect, it } from "vitest"
import {
	MAPLE_MCP_SERVER_NAME,
	MAPLE_MCP_SERVER_VERSION,
	MCP_SERVER_JSON_SCHEMA,
	mapleMcpServerManifest,
} from "./mcp-manifest"

// Constraints lifted from the registry schema named in `$schema`.
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/
const REMOTE_URL_PATTERN = /^https?:\/\/[^\s]+$/

describe("mapleMcpServerManifest", () => {
	const manifest = mapleMcpServerManifest({ apiBaseUrl: "https://api.maple.dev/" })

	it("satisfies the server.json required fields and limits", () => {
		expect(manifest.$schema).toBe(MCP_SERVER_JSON_SCHEMA)
		expect(manifest.name).toBe(MAPLE_MCP_SERVER_NAME)
		expect(manifest.name).toMatch(NAME_PATTERN)
		expect(manifest.name.length).toBeGreaterThanOrEqual(3)
		expect(manifest.description.length).toBeGreaterThanOrEqual(1)
		expect(manifest.description.length).toBeLessThanOrEqual(100)
		expect(manifest.title.length).toBeLessThanOrEqual(100)
		expect(manifest.version).toBe(MAPLE_MCP_SERVER_VERSION)
		expect(manifest.repository).toMatchObject({ source: "github" })
	})

	it("points one streamable-http remote at the API's /mcp endpoint", () => {
		expect(manifest.remotes).toHaveLength(1)
		const [remote] = manifest.remotes
		expect(remote.type).toBe("streamable-http")
		expect(remote.url).toBe("https://api.maple.dev/mcp")
		expect(remote.url).toMatch(REMOTE_URL_PATTERN)
		expect(remote.headers.map((h) => h.name)).toEqual(["Authorization"])
		expect(remote.headers[0].isSecret).toBe(true)
	})

	it("derives site-relative links from siteUrl", () => {
		const staged = mapleMcpServerManifest({
			apiBaseUrl: "https://api.stg.maple.dev",
			siteUrl: "https://stg.maple.dev/",
		})
		expect(staged.websiteUrl).toBe("https://stg.maple.dev/features/ai-mcp-integration")
		expect(staged.icons[0].src).toBe("https://stg.maple.dev/logo192.png")
		expect(staged.remotes[0].url).toBe("https://api.stg.maple.dev/mcp")
	})

	it("serialises to plain JSON (no undefined, no functions)", () => {
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
	})
})

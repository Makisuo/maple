import { MAPLE_MCP_SERVER_NAME } from "@maple/domain/mcp-manifest"
import { describe, expect, it } from "vitest"
import { GET } from "../pages/.well-known/mcp.json"
import { GET as GET_SERVER_JSON } from "../pages/.well-known/mcp/server.json"

const context = { site: new URL("https://maple.dev") } as Parameters<typeof GET>[0]

describe("/.well-known/mcp.json", () => {
	it("publishes the registry server.json pointing at the hosted MCP server", async () => {
		const response = await GET(context)
		expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
		const manifest = await response.json()
		expect(manifest.name).toBe(MAPLE_MCP_SERVER_NAME)
		expect(manifest.remotes).toEqual([
			expect.objectContaining({ type: "streamable-http", url: "https://api.maple.dev/mcp" }),
		])
		expect(manifest.websiteUrl).toBe("https://maple.dev/features/ai-mcp-integration")
	})

	it("serves the same document at /.well-known/mcp/server.json", async () => {
		expect(await (await GET_SERVER_JSON(context)).text()).toBe(await (await GET(context)).text())
	})
})

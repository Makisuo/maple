// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { clearMapleAuthHeaders, setMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { decideMcpAuthorization, inspectMcpAuthorization } from "./mcp-authorize"

afterEach(() => {
	clearMapleAuthHeaders()
	vi.restoreAllMocks()
})

describe("MCP OAuth approval helpers", () => {
	it("inspects a consent request with the active browser authorization", async () => {
		setMapleAuthHeaders({ authorization: "Bearer browser-session" })
		const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					clientName: "Claude",
					redirectUri: "http://127.0.0.1:1234/callback",
					resource: "https://api.maple.dev/mcp",
					scopes: ["mcp:tools"],
					expiresAt: "2026-07-21T12:00:00.000Z",
					status: "pending",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		)

		await expect(inspectMcpAuthorization("mcp_auth_request")).resolves.toMatchObject({
			clientName: "Claude",
			status: "pending",
		})
		// The request goes through tracedFetch, which normalizes the plain header
		// object into Headers (and adds traceparent), so read the header back out.
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [input, init] = fetchSpy.mock.calls[0]!
		expect(String(input)).toContain("/api/auth/mcp/oauth/authorization/mcp_auth_request")
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer browser-session")
	})

	it("returns the client redirect after approval", async () => {
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "approved",
					redirectUri: "http://127.0.0.1:1234/callback?code=secret&state=opaque",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		)
		await expect(decideMcpAuthorization("mcp_auth_request", "approve")).resolves.toMatchObject({
			status: "approved",
			redirectUri: expect.stringContaining("code=secret"),
		})
	})

	it("surfaces expired authorization requests", async () => {
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "OAuth authorization request expired" }), {
				status: 410,
				headers: { "content-type": "application/json" },
			}),
		)
		await expect(inspectMcpAuthorization("expired")).rejects.toThrow(
			"OAuth authorization request expired",
		)
	})
})

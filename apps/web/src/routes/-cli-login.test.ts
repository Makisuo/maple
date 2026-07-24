// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { clearMapleAuthHeaders, setMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { inspectCliDevice, normalizeCliUserCode } from "./cli-login"

afterEach(() => {
	clearMapleAuthHeaders()
	vi.restoreAllMocks()
})

describe("CLI login approval helpers", () => {
	it("normalizes pasted one-time codes", () => {
		expect(normalizeCliUserCode("ab cd-ef_gh")).toBe("ABCD-EFGH")
		expect(normalizeCliUserCode("abcdefghijk")).toBe("ABCD-EFGH")
	})

	it("inspects a code with the active browser authorization", async () => {
		setMapleAuthHeaders({ authorization: "Bearer browser-session" })
		const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					userCode: "ABCD-EFGH",
					deviceName: "Maple CLI on laptop",
					expiresAt: "2026-07-21T12:00:00.000Z",
					status: "pending",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		)

		await expect(inspectCliDevice("ABCD-EFGH")).resolves.toMatchObject({ status: "pending" })
		// The request goes through tracedFetch, which normalizes the plain header
		// object into Headers (and adds traceparent), so read the header back out.
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [input, init] = fetchSpy.mock.calls[0]!
		expect(String(input)).toContain("/api/auth/cli/device/ABCD-EFGH")
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer browser-session")
	})

	it("surfaces typed API error messages", async () => {
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "CLI login code has expired" }), {
				status: 410,
				headers: { "content-type": "application/json" },
			}),
		)
		await expect(inspectCliDevice("ABCD-EFGH")).rejects.toThrow("CLI login code has expired")
	})
})

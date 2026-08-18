// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const sessionResult = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock("@/lib/effect-atom", async () => {
	const actual = await vi.importActual<typeof import("@/lib/effect-atom")>("@/lib/effect-atom")
	return { ...actual, useAtomValue: () => sessionResult.current }
})
vi.mock("@/lib/services/common/atom-client", () => ({
	MapleApiAtomClient: { query: () => ({}) },
	retainedQuery: () => ({}),
}))

const { Result } = await import("@/lib/effect-atom")
const { useMapleOrganizationId } = await import("./use-maple-organization")

function Probe() {
	return <span data-testid="org">{useMapleOrganizationId() ?? "(none)"}</span>
}

const org = () => screen.getByTestId("org").textContent

afterEach(() => {
	cleanup()
})

/**
 * The chat addresses its agent as `"<orgId>:<tabId>"`. If this hook answers with
 * anything other than the org the API resolved, the browser opens a conversation
 * the backend never seeded and the thread stays empty with no error — so the only
 * acceptable source is the session the server reports.
 */
describe("useMapleOrganizationId", () => {
	it("reports the org the API resolved for this session", () => {
		sessionResult.current = Result.success({ orgId: "org_from_server" })
		render(<Probe />)
		expect(org()).toBe("org_from_server")
	})

	it("reports nothing until the session has loaded", () => {
		sessionResult.current = Result.initial()
		render(<Probe />)
		expect(org()).toBe("(none)")
	})

	it("reports nothing when the session cannot be read", () => {
		sessionResult.current = Result.fail(new Error("offline"))
		render(<Probe />)
		expect(org()).toBe("(none)")
	})
})

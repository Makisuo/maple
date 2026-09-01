import { describe, expect, it } from "vitest"
import { routeHostname, routeUrl } from "./worktree.ts"

describe("routeUrl", () => {
	it("builds the portless hostname and URL from a name and prefix", () => {
		expect(routeHostname("api", "")).toBe("api")
		expect(routeHostname("api", "fix-ui.")).toBe("fix-ui.api")
		expect(routeUrl("electric-sync", "")).toBe("https://electric-sync.localhost")
		expect(routeUrl("web", "fix-ui.")).toBe("https://fix-ui.web.localhost")
	})
})

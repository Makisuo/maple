import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { siblingUrl } from "./dev-urls.ts"

describe("siblingUrl", () => {
	const original = process.env.PORTLESS_URL

	beforeEach(() => {
		delete process.env.PORTLESS_URL
	})

	afterEach(() => {
		if (original === undefined) delete process.env.PORTLESS_URL
		else process.env.PORTLESS_URL = original
	})

	it("returns undefined when PORTLESS_URL is unset", () => {
		expect(siblingUrl("api")).toBeUndefined()
	})

	it("swaps the app label in a main-worktree URL", () => {
		process.env.PORTLESS_URL = "https://web.localhost"
		expect(siblingUrl("api")).toBe("https://api.localhost")
		expect(siblingUrl("chat-agent")).toBe("https://chat-agent.localhost")
	})

	it("preserves the branch prefix in a linked-worktree URL", () => {
		process.env.PORTLESS_URL = "https://fix-ui.web.localhost"
		expect(siblingUrl("api")).toBe("https://fix-ui.api.localhost")
		expect(siblingUrl("ingest")).toBe("https://fix-ui.ingest.localhost")
	})

	it("preserves protocol and port", () => {
		process.env.PORTLESS_URL = "http://loving-mclean-09f7bd.web.localhost:8443"
		expect(siblingUrl("api")).toBe("http://loving-mclean-09f7bd.api.localhost:8443")
	})

	it("returns undefined when the hostname has no app label before localhost", () => {
		process.env.PORTLESS_URL = "https://localhost"
		expect(siblingUrl("api")).toBeUndefined()
	})
})

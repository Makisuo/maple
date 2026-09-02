import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEV_APPS, devEndpoint, devServer, selectedDevApps, siblingUrl } from "./dev-urls.ts"

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
		expect(siblingUrl("alerting")).toBe("https://alerting.localhost")
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

describe("dev endpoints", () => {
	const keys = ["MAPLE_DEV_APPS", "MAPLE_DEV_PORT_API", "MAPLE_DEV_URL_API", "MAPLE_DEV_PORT_ELECTRIC_SYNC"]
	const saved = new Map<string, string | undefined>()

	beforeEach(() => {
		for (const key of keys) {
			saved.set(key, process.env[key])
			delete process.env[key]
		}
	})

	afterEach(() => {
		for (const key of keys) {
			const value = saved.get(key)
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	})

	it("selects every app when MAPLE_DEV_APPS is unset or empty", () => {
		expect([...selectedDevApps()]).toEqual([...DEV_APPS])
		process.env.MAPLE_DEV_APPS = " "
		expect([...selectedDevApps()]).toEqual([...DEV_APPS])
	})

	it("selects the listed apps and drops names it does not know", () => {
		process.env.MAPLE_DEV_APPS = "api, web,nope"
		expect([...selectedDevApps()]).toEqual(["api", "web"])
	})

	it("reads the port and URL the dev script handed an app", () => {
		process.env.MAPLE_DEV_PORT_API = "50123"
		process.env.MAPLE_DEV_URL_API = "https://api.localhost"
		expect(devEndpoint("api")).toEqual({ port: 50123, url: "https://api.localhost" })
		expect(devServer("api")).toEqual({ host: "127.0.0.1", port: 50123, strictPort: true })
	})

	it("falls back to the raw port URL and rejects a bad port", () => {
		process.env.MAPLE_DEV_PORT_ELECTRIC_SYNC = "50124"
		expect(devEndpoint("electric-sync")).toEqual({ port: 50124, url: "http://127.0.0.1:50124" })
		process.env.MAPLE_DEV_PORT_API = "70000"
		expect(devEndpoint("api")).toBeUndefined()
		expect(devServer("scraper")).toBeUndefined()
	})
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	claimNewVisitor,
	configureVisitorCookie,
	getVisitorId,
	isVisitorIdPersisted,
	resetVisitorCacheForTests,
	setVisitorTracking,
} from "./visitor"

/** Minimal localStorage stand-in; `throwOnWrite` models Safari private mode. */
function installStorage(options: { throwOnWrite?: boolean } = {}): Map<string, string> {
	const store = new Map<string, string>()
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (options.throwOnWrite) throw new Error("QuotaExceededError")
				store.set(key, value)
			},
			removeItem: (key: string) => {
				store.delete(key)
			},
		},
	})
	return store
}

interface CookieEntry {
	value: string
	/** `""` = host-only. */
	domain: string
}

/**
 * A `document.cookie` stand-in. `accepts` models the browser rejecting a
 * `Domain=` it considers too broad (a public suffix), which is exactly what the
 * domain probe exists to discover.
 */
function installCookies(
	options: { hostname?: string; accepts?: (domain: string) => boolean } = {},
): Map<string, CookieEntry> {
	const jar = new Map<string, CookieEntry>()
	const accepts = options.accepts ?? (() => true)
	vi.stubGlobal("location", { hostname: options.hostname ?? "app.example.com", protocol: "https:" })
	vi.stubGlobal("document", {
		get cookie(): string {
			return [...jar].map(([name, entry]) => `${name}=${entry.value}`).join("; ")
		},
		set cookie(raw: string) {
			const [pair, ...attrs] = raw.split(";").map((part) => part.trim())
			const eq = pair?.indexOf("=") ?? -1
			if (!pair || eq < 0) return
			const name = pair.slice(0, eq)
			const value = pair.slice(eq + 1)
			const domain = (attrs.find((a) => a.toLowerCase().startsWith("domain="))?.slice(7) ?? "").replace(
				/^\./,
				"",
			)
			if (domain && !accepts(domain)) return
			const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="))?.slice(8)
			if (maxAge === "0") {
				const existing = jar.get(name)
				if (existing && existing.domain === domain) jar.delete(name)
				return
			}
			jar.set(name, { value, domain })
		},
	})
	return jar
}

function cookieRecord(jar: Map<string, CookieEntry>): { id: string; mintedAt: number } | undefined {
	const raw = jar.get("maple_visitor")
	return raw ? JSON.parse(decodeURIComponent(raw.value)) : undefined
}

describe("visitor id", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
		resetVisitorCacheForTests()
	})

	it("mints once and reuses the stored id", () => {
		const store = installStorage()
		const first = getVisitorId()
		expect(first).toBeTruthy()
		expect(claimNewVisitor()).toBe(true)
		// One-shot: a second session started in the same page load (idle rotation)
		// is not a new visitor's session.
		expect(claimNewVisitor()).toBe(false)
		expect(isVisitorIdPersisted()).toBe(true)

		// A later page load reads the stored id rather than minting a new one —
		// that is the whole point of it being a *visitor* id and not a session id.
		resetVisitorCacheForTests()
		expect(getVisitorId()).toBe(first)
		expect(claimNewVisitor()).toBe(false)
		expect(store.size).toBe(1)
	})

	it("expires an id older than 400 days", () => {
		const store = installStorage()
		const stale = Date.now() - 401 * 24 * 60 * 60_000
		store.set("maple.visitor", JSON.stringify({ id: "old-visitor", mintedAt: stale }))

		// Matches the ~13-month ceiling browsers settled on for first-party ids.
		expect(getVisitorId()).not.toBe("old-visitor")
		expect(claimNewVisitor()).toBe(true)
	})

	it("falls back to an in-memory id when storage is blocked, and says so", () => {
		installStorage({ throwOnWrite: true })
		const id = getVisitorId()
		// Still consistent within the page load — better than sending '' — but it
		// is not a real visitor id, so unique counts must be able to discount it.
		expect(id).toBeTruthy()
		expect(getVisitorId()).toBe(id)
		expect(isVisitorIdPersisted()).toBe(false)
	})

	it("opting out purges the stored id, not just future reads", () => {
		const store = installStorage()
		getVisitorId()
		expect(store.size).toBe(1)

		setVisitorTracking(false)
		expect(getVisitorId()).toBeUndefined()
		// An opt-out that leaves the identifier behind is not an opt-out.
		expect(store.size).toBe(0)
	})

	it("returns undefined outside a browser", () => {
		expect(getVisitorId()).toBeUndefined()
	})
})

describe("visitor cookie", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
		resetVisitorCacheForTests()
	})

	it("writes both stores, scoped to the registered domain", () => {
		const store = installStorage()
		const jar = installCookies({ hostname: "app.example.com" })

		const id = getVisitorId()
		expect(cookieRecord(jar)?.id).toBe(id)
		// The whole point: `maple.dev` and `app.maple.dev` must resolve to one id,
		// and localStorage alone is origin-scoped.
		expect(jar.get("maple_visitor")?.domain).toBe("example.com")
		expect(JSON.parse(store.get("maple.visitor") as string).id).toBe(id)
		expect(isVisitorIdPersisted()).toBe(true)
	})

	it("probes past a public suffix the browser refuses", () => {
		installStorage()
		const jar = installCookies({ hostname: "app.shop.co.uk", accepts: (d) => d !== "co.uk" })

		getVisitorId()
		expect(jar.get("maple_visitor")?.domain).toBe("shop.co.uk")
	})

	it("keeps the cookie host-only for single-label hosts", () => {
		installStorage()
		const jar = installCookies({ hostname: "localhost" })

		getVisitorId()
		expect(jar.get("maple_visitor")?.domain).toBe("")
	})

	it("honors crossSubdomainCookie: false and an explicit cookieDomain", () => {
		installStorage()
		const jar = installCookies({ hostname: "app.example.com" })

		configureVisitorCookie({ crossSubdomainCookie: false })
		getVisitorId()
		expect(jar.get("maple_visitor")?.domain).toBe("")

		resetVisitorCacheForTests()
		jar.clear()
		configureVisitorCookie({ cookieDomain: "example.com" })
		getVisitorId()
		expect(jar.get("maple_visitor")?.domain).toBe("example.com")
	})

	it("prefers the shared cookie over a divergent origin-local id, and converges", () => {
		const store = installStorage()
		const jar = installCookies({ hostname: "app.example.com" })
		const mintedAt = Date.now()
		// The app minted its own id before the cookie existed; the marketing site's
		// cookie is the identity that links the two surfaces, so it wins.
		store.set("maple.visitor", JSON.stringify({ id: "origin-local", mintedAt }))
		jar.set("maple_visitor", {
			value: encodeURIComponent(JSON.stringify({ id: "shared", mintedAt })),
			domain: "example.com",
		})

		expect(getVisitorId()).toBe("shared")
		expect(claimNewVisitor()).toBe(false)
		expect(JSON.parse(store.get("maple.visitor") as string).id).toBe("shared")
	})

	it("survives localStorage being blocked", () => {
		installStorage({ throwOnWrite: true })
		const jar = installCookies()

		const id = getVisitorId()
		// Cookie-only is still a real, persistent visitor id — unlike the in-memory
		// fallback, it survives the page load, so uniques must not be discounted.
		expect(cookieRecord(jar)?.id).toBe(id)
		expect(isVisitorIdPersisted()).toBe(true)
	})

	it("opting out purges the cookie as well as localStorage", () => {
		const store = installStorage()
		const jar = installCookies()
		getVisitorId()
		expect(jar.size).toBe(1)

		setVisitorTracking(false)
		expect(getVisitorId()).toBeUndefined()
		expect(store.size).toBe(0)
		expect(jar.size).toBe(0)
	})
})

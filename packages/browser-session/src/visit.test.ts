import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetCookieScopeForTests } from "./cookie"
import { claimVisit, resetVisitClaimForTests } from "./visit"

const MINUTE = 60_000
const IDLE_WINDOW = 30 * MINUTE

interface CookieEntry {
	value: string
	/** `""` = host-only. */
	domain: string
}

/**
 * A `document.cookie` stand-in shared by every origin in a test, which is the
 * whole point: a cookie set on `example.com` has to be visible to
 * `app.example.com`, because that hop is what the visit claim exists to
 * deduplicate.
 */
function installCookies(jar: Map<string, CookieEntry>, hostname = "app.example.com"): void {
	vi.stubGlobal("location", { hostname, protocol: "https:" })
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
			const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="))?.slice(8)
			if (maxAge === "0") {
				jar.delete(name)
				return
			}
			jar.set(name, { value, domain })
		},
	})
}

/** A fresh, per-origin localStorage — the store that must *not* be what dedupes. */
function installStorage(options: { throwOnWrite?: boolean } = {}): void {
	const store = new Map<string, string>()
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (options.throwOnWrite) throw new Error("QuotaExceededError")
				store.set(key, value)
			},
			removeItem: (key: string) => store.delete(key),
		},
	})
}

describe("claimVisit", () => {
	let jar: Map<string, CookieEntry>

	beforeEach(() => {
		vi.unstubAllGlobals()
		resetVisitClaimForTests()
		resetCookieScopeForTests()
		jar = new Map()
		installStorage()
		installCookies(jar)
	})

	it("grants the first claim and refuses the rest of the window", () => {
		const start = Date.UTC(2026, 4, 22, 12)

		expect(claimVisit(start)).toBe(true)
		expect(claimVisit(start + MINUTE)).toBe(false)
		expect(claimVisit(start + 29 * MINUTE)).toBe(false)
	})

	it("grants again once the idle window has passed", () => {
		const start = Date.UTC(2026, 4, 22, 12)
		expect(claimVisit(start)).toBe(true)

		// The window matches the session idle timeout exactly: the rotation that
		// mints a new session id is the same moment a new visit begins, so this
		// boundary is what keeps rotated sessions from going uncharged.
		expect(claimVisit(start + IDLE_WINDOW)).toBe(true)
		expect(claimVisit(start + IDLE_WINDOW + MINUTE)).toBe(false)
	})

	it("refuses a second tab — a fresh page-load state, the same cookie jar", () => {
		const start = Date.UTC(2026, 4, 22, 12)
		expect(claimVisit(start)).toBe(true)

		// A second tab runs its own module instance against its own sessionStorage,
		// so nothing but the shared cookie can tell it the visit is already paid for.
		resetVisitClaimForTests()
		installStorage()
		installCookies(jar)

		expect(claimVisit(start + MINUTE)).toBe(false)
	})

	it("refuses a second subdomain", () => {
		const start = Date.UTC(2026, 4, 22, 12)
		installCookies(jar, "example.com")
		expect(claimVisit(start)).toBe(true)

		// localStorage is origin-scoped, so the app subdomain gets a brand new one —
		// exactly the case that used to bill a marketing-site visitor twice.
		resetVisitClaimForTests()
		resetCookieScopeForTests()
		installStorage()
		installCookies(jar, "app.example.com")

		expect(claimVisit(start + MINUTE)).toBe(false)
	})

	it("still deduplicates within a page load when localStorage writes throw", () => {
		const start = Date.UTC(2026, 4, 22, 12)
		installStorage({ throwOnWrite: true })

		expect(claimVisit(start)).toBe(true)
		expect(claimVisit(start + MINUTE)).toBe(false)
	})

	it("returns false outside a browser rather than billing a server render", () => {
		vi.unstubAllGlobals()
		expect(claimVisit(Date.UTC(2026, 4, 22, 12))).toBe(false)
	})
})

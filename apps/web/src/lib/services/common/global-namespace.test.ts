// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { setActiveOrgId } from "./auth-headers"
import { getGlobalNamespace, setGlobalNamespace, subscribeGlobalNamespace } from "./global-namespace"

// Each test uses its own org ids: the module keeps a per-org in-memory cache
// (deliberately, for storage-denied sessions), so reusing an org id across
// tests would read the previous test's value instead of localStorage.
describe("global-namespace", () => {
	beforeEach(() => {
		localStorage.clear()
		setActiveOrgId(null)
	})

	it("is null with no active org", () => {
		expect(getGlobalNamespace()).toBeNull()
	})

	it("persists the pin per org in localStorage", () => {
		setActiveOrgId("org_persist")
		setGlobalNamespace("checkout")
		expect(getGlobalNamespace()).toBe("checkout")
		expect(localStorage.getItem("maple.global-namespace.org_persist")).toBe("checkout")
	})

	it("does not bleed across orgs", () => {
		setActiveOrgId("org_bleed_a")
		setGlobalNamespace("checkout")
		setActiveOrgId("org_bleed_b")
		expect(getGlobalNamespace()).toBeNull()
		setGlobalNamespace("payments")
		setActiveOrgId("org_bleed_a")
		expect(getGlobalNamespace()).toBe("checkout")
	})

	it("clears the pin and its storage entry on null", () => {
		setActiveOrgId("org_clear")
		setGlobalNamespace("checkout")
		setGlobalNamespace(null)
		expect(getGlobalNamespace()).toBeNull()
		expect(localStorage.getItem("maple.global-namespace.org_clear")).toBeNull()
	})

	it("notifies subscribers on change and stops after unsubscribe", () => {
		setActiveOrgId("org_notify")
		const notify = vi.fn()
		const unsubscribe = subscribeGlobalNamespace(notify)
		setGlobalNamespace("checkout")
		expect(notify).toHaveBeenCalledTimes(1)
		unsubscribe()
		setGlobalNamespace(null)
		expect(notify).toHaveBeenCalledTimes(1)
	})

	it("still honors the pin in-memory when storage writes are denied", () => {
		setActiveOrgId("org_denied")
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied")
		})
		try {
			setGlobalNamespace("checkout")
			expect(getGlobalNamespace()).toBe("checkout")
		} finally {
			setItem.mockRestore()
		}
	})

	it("treats an empty stored value as unpinned", () => {
		setActiveOrgId("org_empty")
		localStorage.setItem("maple.global-namespace.org_empty", "")
		expect(getGlobalNamespace()).toBeNull()
	})
})

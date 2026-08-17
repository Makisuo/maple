import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LAB_ENTRIES } from "@/lab/registry"
import { isChromelessPath, isPublicPath } from "./public-routes"

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

describe("isPublicPath", () => {
	it("covers the auth pages and sessionless lab surfaces", () => {
		const fixtures = LAB_ENTRIES.filter((entry) => entry.session === "none").map((entry) => entry.path)
		for (const path of ["/sign-in", "/sign-up", "/org-required", "/lab", ...fixtures]) {
			expect(isPublicPath(path), path).toBe(true)
		}
	})

	it("keeps session-backed labs behind sign-in", () => {
		// The query-builder lab reads real org data, so it is the one lab surface
		// that goes through the auth gate like any product route.
		expect(isPublicPath("/lab/query-builder")).toBe(false)
		expect(isPublicPath("/lab/does-not-exist")).toBe(false)
		expect(isPublicPath("/labs-admin")).toBe(false)
	})

	it("covers every path under a share link", () => {
		// The reason this module exists: `/share/:token` is parameterised, so the
		// exact-match set it replaced could never express it.
		expect(isPublicPath("/share/mshare_abc123")).toBe(true)
		expect(isPublicPath("/share/mshare_abc123/embed")).toBe(true)
	})

	it("does not make the authed app public", () => {
		for (const path of ["/", "/dashboards", "/dashboards/dash_1", "/settings", "/traces"]) {
			expect(isPublicPath(path), path).toBe(false)
		}
	})

	it("does not let a prefix collision leak a route", () => {
		// `/share/` keeps its trailing slash precisely so a sibling route starting
		// with the same letters stays gated.
		expect(isPublicPath("/shares")).toBe(false)
		expect(isPublicPath("/share-admin")).toBe(false)
		expect(isPublicPath("/sharesettings")).toBe(false)
	})

	it("treats only share pages as chrome-less", () => {
		// Sign-in is public but still part of the app shell; a share page is not,
		// and must not mount the command palette or chat sheet.
		expect(isChromelessPath("/share/abc")).toBe(true)
		expect(isChromelessPath("/sign-in")).toBe(false)
		expect(isChromelessPath("/lab/widgets")).toBe(false)
	})
})

describe("the auth gate has exactly one source of truth", () => {
	// These two files each carried their own copy of the public-path list, and
	// they had already drifted — main.tsx was missing four entries. Asserted
	// structurally rather than by inspection so the next copy is caught.
	it("is not re-declared in __root.tsx or main.tsx", () => {
		for (const file of ["../routes/__root.tsx", "../main.tsx"]) {
			const source = read(file)
			expect(source, file).toContain("public-routes")
			expect(source, file).not.toMatch(/const PUBLIC_PATHS\s*=/)
		}
	})
})

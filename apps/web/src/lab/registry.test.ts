import { describe, expect, it } from "vitest"

import { routeTree } from "@/routeTree.gen"
import { LAB_ENTRIES, LAB_ROOT, isLabPath, isSessionlessLabPath } from "./registry"

// Route ids are only assigned once a router builds the tree, and building the
// real router drags in the Effect runtime. The generated tree already carries
// each route's `options.path` and its children, so join segments structurally.
// Trailing-slash ids (`/lab/` for the index) are excluded by name below.
function collectFullPaths(route: unknown, parentPath = "", into: string[] = []): string[] {
	if (typeof route !== "object" || route === null) return into
	const { options, children } = route as { options?: { path?: unknown }; children?: unknown }
	const segment = typeof options?.path === "string" ? options.path : ""
	const fullPath = `${parentPath}/${segment}`.replace(/\/{2,}/g, "/")
	if (segment) into.push(fullPath)
	const list = Array.isArray(children)
		? children
		: typeof children === "object" && children !== null
			? Object.values(children)
			: []
	for (const child of list) collectFullPaths(child, fullPath, into)
	return into
}

const routePaths = collectFullPaths(routeTree)

describe("lab registry", () => {
	it("lists exactly the routes under /lab (excluding the layout and index)", () => {
		const routed = routePaths
			.filter((id) => id.startsWith(`${LAB_ROOT}/`) && id !== `${LAB_ROOT}/`)
			.sort()
		const registered = LAB_ENTRIES.map((entry) => entry.path).sort()
		expect(registered).toEqual(routed)
	})

	it("has unique paths", () => {
		const paths = LAB_ENTRIES.map((entry) => entry.path)
		expect(new Set(paths).size).toBe(paths.length)
	})

	it("classifies lab paths", () => {
		expect(isLabPath("/lab")).toBe(true)
		expect(isLabPath("/lab/widgets")).toBe(true)
		expect(isLabPath("/labs-admin")).toBe(false)
		expect(isSessionlessLabPath("/lab")).toBe(true)
		expect(isSessionlessLabPath("/lab/bench/logs")).toBe(true)
		expect(isSessionlessLabPath("/lab/query-builder")).toBe(false)
		expect(isSessionlessLabPath("/lab/nope")).toBe(false)
	})
})

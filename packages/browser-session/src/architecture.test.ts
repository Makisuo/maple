import { describe, expect, it } from "vitest"

/**
 * `replay/` is the code-split tier: it is the only directory that reaches rrweb,
 * and `@maple-dev/browser` loads it behind a dynamic `import()` so the visitors
 * a sample rate excludes never download it. That only holds while nothing in the
 * always-loaded tier imports into it — one stray import and the bundler hoists
 * rrweb into the base chunk, silently, with every other test still passing.
 *
 * `session/replay-session.ts` is the sole exception: it *is* the lazy entry
 * point (`@maple/browser-session/replay`), so it sits on the far side of the
 * split even though it lives outside the directory.
 */
const LAZY_TIER = "replay"
const LAZY_ENTRY = "session/replay-session.ts"

// Read through Vite's glob rather than node's fs: this package targets browsers
// and deliberately declares no node types (`types: []`), and the raw source is
// all we need. The signature is declared here rather than by depending on
// `vite/client`, which would be a dependency added for one type in one test.
declare global {
	interface ImportMeta {
		glob: (
			pattern: string,
			options: { query: "?raw"; import: "default"; eager: true },
		) => Record<string, string>
	}
}

const sources = import.meta.glob("./**/*.ts", {
	query: "?raw",
	import: "default",
	eager: true,
})

/** Source files under src/, excluding tests and benches. */
const files = Object.keys(sources)
	.map((key) => key.replace(/^\.\//, ""))
	.filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".bench.ts"))
	.sort()

/** Normalize `a/b/../c` without node's path module. */
function normalize(specifier: string): string {
	const out: string[] = []
	for (const part of specifier.split("/")) {
		if (part === "." || part === "") continue
		if (part === "..") out.pop()
		else out.push(part)
	}
	return out.join("/")
}

/** Every relative specifier a file imports, resolved to a path under src/. */
function importsOf(file: string): string[] {
	const source = sources[`./${file}`] ?? ""
	const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
	return [...source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)].map((match) =>
		normalize(`${dir}/${match[1]!}`),
	)
}

describe("module layout", () => {
	it("sees the source tree", () => {
		// A glob that silently matched nothing would make every check below pass.
		expect(files.length).toBeGreaterThan(15)
		expect(files).toContain(LAZY_ENTRY)
	})

	it("keeps the lazy replay tier unreachable from the always-loaded tier", () => {
		const offenders = files
			.filter((file) => !file.startsWith(`${LAZY_TIER}/`) && file !== LAZY_ENTRY)
			.flatMap((file) =>
				importsOf(file)
					.filter((target) => target.startsWith(`${LAZY_TIER}/`))
					.map((target) => `${file} → ${target}`),
			)

		expect(offenders).toEqual([])
	})

	it("keeps rrweb behind that same boundary", () => {
		const offenders = files.filter(
			(file) => !file.startsWith(`${LAZY_TIER}/`) && /from\s+"rrweb"/.test(sources[`./${file}`] ?? ""),
		)

		expect(offenders).toEqual([])
	})

	it("keeps platform/ free of dependencies on the domain layers", () => {
		// platform/ is the leaf: browser globals, UA parsing, HTTP, size
		// estimation. It is imported by everything and must import nothing back,
		// or the "leaf" claim stops being true and cycles start appearing.
		const offenders = files
			.filter((file) => file.startsWith("platform/"))
			.flatMap((file) =>
				importsOf(file)
					.filter((target) => !target.startsWith("platform/"))
					.map((target) => `${file} → ${target}`),
			)

		expect(offenders).toEqual([])
	})
})

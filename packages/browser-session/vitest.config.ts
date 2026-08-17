import { defineConfig } from "vitest/config"

// `node` stays the default: most of this package is pure logic over globals the
// suites stub by hand, and several of them assert behaviour *without* a DOM
// (storage blocked, non-browser embedder) — a jsdom default would quietly
// remove the very condition under test.
//
// The capture modules are the exception. They patch `window.fetch`,
// `XMLHttpRequest`, `console.*` and `document`'s listeners, so patch/restore
// symmetry — the thing most likely to break a host app — needs a real DOM.
// Those files opt in with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
})

import { defineConfig } from "vitest/config"

// The package is mostly pure logic, but hooks and components live here too and
// their behavior tests used to be exiled to apps/web for want of a renderer.
// jsdom is the default environment so a `.test.tsx` next to a component just
// works; the pure-logic suites don't care either way.
export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
	},
})

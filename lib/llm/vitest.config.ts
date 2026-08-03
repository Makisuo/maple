import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Upstream ran `bun test --timeout 30000`; the recorded tool-loop cassettes replay several
		// turns and a couple of the golden scenarios ask for 30s explicitly.
		testTimeout: 30_000,
	},
})

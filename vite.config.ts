// vitest.config.ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths() as any],
  test: {
    globals: true,
    environment: "node", // or 'jsdom' for frontend tests
    include: ["alchemy-effect/test/**/*.test.ts"],
  },
});

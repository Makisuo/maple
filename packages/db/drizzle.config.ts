import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  strict: true,
})

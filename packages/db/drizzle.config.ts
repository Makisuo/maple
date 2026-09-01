import { defineConfig } from "drizzle-kit"

export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./drizzle",
	dialect: "postgresql",
	// Used by db:migrate/db:push/db:studio; db:generate never dials it.
	// CI passes the PlanetScale direct (5432) admin URL; the fallback is the
	// local docker-compose Postgres used by `alchemy dev`.
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://maple:maple@localhost:5499/maple",
	},
	strict: true,
})

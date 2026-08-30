/**
 * Apply bundled drizzle SQL to a real Postgres URL.
 * Used by the celld self-host migrate Job so the runtime image does not need
 * drizzle-kit (a db devDependency). Local/CI still use `db:migrate`.
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

const url = process.env.DATABASE_URL?.trim() || process.env.MAPLE_PG_URL?.trim()
if (!url) {
	console.error("migrate-pg: DATABASE_URL or MAPLE_PG_URL is required")
	process.exit(1)
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")
const sql = postgres(url, { max: 1 })
await migrate(drizzle(sql), { migrationsFolder })
await sql.end({ timeout: 5 })
console.log("migrate-pg: applied", migrationsFolder)

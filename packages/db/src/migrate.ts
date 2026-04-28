import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { MapleDbConfig } from "./config"

export const runMigrations = async (config: MapleDbConfig): Promise<void> => {
	const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")
	const client = createClient({
		url: config.url,
		authToken: config.authToken,
	})
	const db = drizzle(client)
	await migrate(db, { migrationsFolder })
	client.close()
}

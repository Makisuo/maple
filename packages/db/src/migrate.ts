import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { MapleDbConfig } from "./config"
import { reshapeDashboardWidgets } from "./migrations/0012-dashboard-widget-reshape"
import { migrateAlertQuerySignalTypes } from "./migrations/0013-alert-query-signal-types"
import * as schema from "./schema"

export { reshapeDashboardWidgets } from "./migrations/0012-dashboard-widget-reshape"
export { migrateAlertQuerySignalTypes } from "./migrations/0013-alert-query-signal-types"

export const runMigrations = async (config: MapleDbConfig): Promise<void> => {
	const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")
	const client = createClient({
		url: config.url,
		authToken: config.authToken,
	})
	const db = drizzle(client, { schema })
	await migrate(db, { migrationsFolder })
	await reshapeDashboardWidgets(db)
	await migrateAlertQuerySignalTypes(db)
	client.close()
}

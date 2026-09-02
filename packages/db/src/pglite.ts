import type { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { type MaplePgClientOptions, toDrizzleLogger } from "./client"
import * as schema from "./schema"

// Kept out of `./client` so the Workers do not bundle the embedded-Postgres driver.
export const createMaplePgliteClient = (pglite: PGlite, options?: Pick<MaplePgClientOptions, "onQuery">) =>
	drizzle(pglite, { schema, logger: toDrizzleLogger(options?.onQuery) })

export type MaplePgliteClient = ReturnType<typeof createMaplePgliteClient>

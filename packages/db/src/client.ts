import { createClient } from "@libsql/client"
import * as schema from "./schema"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"

export const createMapleLibsqlClient = (config: {
  url: string
  authToken?: string
}) => drizzleLibsql(createClient(config), { schema })

export type MapleLibsqlClient = ReturnType<typeof createMapleLibsqlClient>

export type CloudflareD1Database = Parameters<typeof drizzleD1>[0]

export const createMapleD1Client = (database: CloudflareD1Database) =>
  drizzleD1(database, { schema })

export type MapleD1Client = ReturnType<typeof createMapleD1Client>

export type MapleDatabaseClient = MapleLibsqlClient | MapleD1Client

export type MapleLibsqlTransaction = Parameters<
  Parameters<MapleLibsqlClient["transaction"]>[0]
>[0]

export type MapleD1Transaction = Parameters<
  Parameters<MapleD1Client["transaction"]>[0]
>[0]

export type MapleDatabaseTransaction =
  | MapleLibsqlTransaction
  | MapleD1Transaction

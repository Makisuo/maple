import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgTinybirdSettings = sqliteTable(
  "org_tinybird_settings",
  {
    orgId: text("org_id").notNull(),
    host: text("host").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    syncStatus: text("sync_status").notNull(),
    lastSyncAt: integer("last_sync_at", { mode: "number" }),
    lastSyncError: text("last_sync_error"),
    projectRevision: text("project_revision").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgTinybirdSettingsRow = typeof orgTinybirdSettings.$inferSelect
export type OrgTinybirdSettingsInsert = typeof orgTinybirdSettings.$inferInsert

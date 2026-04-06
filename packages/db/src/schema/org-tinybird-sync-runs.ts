import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgTinybirdSyncRuns = sqliteTable(
  "org_tinybird_sync_runs",
  {
    orgId: text("org_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    targetHost: text("target_host").notNull(),
    targetTokenCiphertext: text("target_token_ciphertext").notNull(),
    targetTokenIv: text("target_token_iv").notNull(),
    targetTokenTag: text("target_token_tag").notNull(),
    targetProjectRevision: text("target_project_revision").notNull(),
    runStatus: text("run_status").notNull(),
    phase: text("phase").notNull(),
    deploymentId: text("deployment_id"),
    deploymentStatus: text("deployment_status"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgTinybirdSyncRunRow = typeof orgTinybirdSyncRuns.$inferSelect
export type OrgTinybirdSyncRunInsert = typeof orgTinybirdSyncRuns.$inferInsert

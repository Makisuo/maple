import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const githubIntegrations = sqliteTable(
  "github_integrations",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    installationId: integer("installation_id", { mode: "number" }).notNull(),
    githubAccountLogin: text("github_account_login").notNull(),
    githubAccountType: text("github_account_type").notNull(),
    selectedRepos: text("selected_repos").notNull(), // JSON array of {id, fullName, owner, name}
    serviceRepoMappings: text("service_repo_mappings").notNull().default("[]"), // JSON array of {serviceName, repoFullName}
    defaultRepo: text("default_repo"), // JSON: {id, fullName, owner, name} or null
    enabled: integer("enabled", { mode: "number" }).notNull().default(1),
    status: text("status").notNull().default("connected"), // connected | error | suspended
    lastSyncAt: integer("last_sync_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("github_int_org_idx").on(table.orgId),
    index("github_int_installation_idx").on(table.installationId),
  ],
)

export type GitHubIntegrationRow = typeof githubIntegrations.$inferSelect
export type GitHubIntegrationInsert = typeof githubIntegrations.$inferInsert

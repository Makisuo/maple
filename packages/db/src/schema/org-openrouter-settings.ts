import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgOpenrouterSettings = sqliteTable(
	"org_openrouter_settings",
	{
		orgId: text("org_id").notNull(),
		apiKeyCiphertext: text("api_key_ciphertext").notNull(),
		apiKeyIv: text("api_key_iv").notNull(),
		apiKeyTag: text("api_key_tag").notNull(),
		apiKeyLast4: text("api_key_last4").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgOpenrouterSettingsRow = typeof orgOpenrouterSettings.$inferSelect
export type OrgOpenrouterSettingsInsert = typeof orgOpenrouterSettings.$inferInsert

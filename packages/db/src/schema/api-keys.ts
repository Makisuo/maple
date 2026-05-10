import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		keyHash: text("key_hash").notNull(),
		keyPrefix: text("key_prefix").notNull(),
		revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
		revokedAt: integer("revoked_at", { mode: "number" }),
		lastUsedAt: integer("last_used_at", { mode: "number" }),
		expiresAt: integer("expires_at", { mode: "number" }),
		metadataJson: text("metadata_json"),
		kind: text("kind", { enum: ["standard", "mcp"] }).notNull().default("standard"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		createdByEmail: text("created_by_email"),
	},
	(table) => [
		uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
		index("api_keys_org_id_idx").on(table.orgId),
	],
)

export type ApiKeyRow = typeof apiKeys.$inferSelect
export type ApiKeyInsert = typeof apiKeys.$inferInsert

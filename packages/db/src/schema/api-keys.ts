import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const apiKeys = pgTable(
	"api_keys",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		keyHash: text("key_hash").notNull(),
		keyPrefix: text("key_prefix").notNull(),
		revoked: boolean("revoked").notNull().default(false),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
		metadataJson: jsonb("metadata_json").$type<unknown>(),
		// v2 scope strings ("<family>:read"/"<family>:write"/"*"); null = legacy full access.
		scopes: jsonb("scopes").$type<string[]>(),
		kind: text("kind", { enum: ["standard", "mcp"] }).notNull().default("standard"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
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

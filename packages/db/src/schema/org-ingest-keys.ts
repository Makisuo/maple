import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const orgIngestKeys = sqliteTable(
	"org_ingest_keys",
	{
		orgId: text("org_id").notNull(),
		publicKey: text("public_key").notNull(),
		publicKeyHash: text("public_key_hash").notNull(),
		privateKeyCiphertext: text("private_key_ciphertext").notNull(),
		privateKeyIv: text("private_key_iv").notNull(),
		privateKeyTag: text("private_key_tag").notNull(),
		privateKeyHash: text("private_key_hash").notNull(),
		publicRotatedAt: integer("public_rotated_at", { mode: "number" }).notNull(),
		privateRotatedAt: integer("private_rotated_at", { mode: "number" }).notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId] }),
		uniqueIndex("org_ingest_keys_public_key_unique").on(table.publicKey),
		uniqueIndex("org_ingest_keys_public_key_hash_unique").on(table.publicKeyHash),
		uniqueIndex("org_ingest_keys_private_key_hash_unique").on(table.privateKeyHash),
	],
)

export type OrgIngestKeyRow = typeof orgIngestKeys.$inferSelect
export type OrgIngestKeyInsert = typeof orgIngestKeys.$inferInsert

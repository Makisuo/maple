import type { OrgId } from "@maple/domain"
import { pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const orgIngestKeys = pgTable(
	"org_ingest_keys",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		publicKey: text("public_key").notNull(),
		publicKeyHash: text("public_key_hash").notNull(),
		privateKeyCiphertext: text("private_key_ciphertext").notNull(),
		privateKeyIv: text("private_key_iv").notNull(),
		privateKeyTag: text("private_key_tag").notNull(),
		privateKeyHash: text("private_key_hash").notNull(),
		publicRotatedAt: timestamp("public_rotated_at", { withTimezone: true, mode: "date" }).notNull(),
		privateRotatedAt: timestamp("private_rotated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
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

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
		// Per-org secret salt for AI session-key hashing. The ingest gateway hashes
		// session keys as `cityHash64(concat(salt, '\0', value))` so the raw key
		// never lands in the warehouse and hashes cannot be correlated across orgs.
		// Same AES-256-GCM triple shape as the private key above, keyed by
		// MAPLE_INGEST_KEY_ENCRYPTION_KEY.
		//
		// Nullable only because existing rows predate the column — the API
		// lazily backfills on first read (OrgIngestKeysService), so treat a null
		// here as "not provisioned yet", never as "this org has no salt".
		//
		// NOT rotatable: changing the salt changes every hash, which breaks
		// SessionsApprox HLL continuity across the rotation boundary (sessions
		// before and after count twice). There is deliberately no reroll path.
		sessionSaltCiphertext: text("session_salt_ciphertext"),
		sessionSaltIv: text("session_salt_iv"),
		sessionSaltTag: text("session_salt_tag"),
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

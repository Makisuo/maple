import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"

export const cliDeviceAuthorizations = pgTable(
	"cli_device_authorizations",
	{
		deviceCodeHash: text("device_code_hash").primaryKey(),
		userCodeHash: text("user_code_hash").notNull(),
		deviceName: text("device_name").notNull(),
		approvedOrgId: text("approved_org_id").$type<OrgId>(),
		approvedUserId: text("approved_user_id").$type<UserId>(),
		approvedRoles: jsonb("approved_roles").$type<string[]>(),
		approvedUserEmail: text("approved_user_email"),
		apiKeyId: text("api_key_id").$type<ApiKeyId>(),
		tokenCiphertext: text("token_ciphertext"),
		tokenIv: text("token_iv"),
		tokenTag: text("token_tag"),
		approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
		deniedAt: timestamp("denied_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("cli_device_authorizations_user_code_unique").on(table.userCodeHash),
		index("cli_device_authorizations_expires_idx").on(table.expiresAt),
	],
)

export type CliDeviceAuthorizationRow = typeof cliDeviceAuthorizations.$inferSelect

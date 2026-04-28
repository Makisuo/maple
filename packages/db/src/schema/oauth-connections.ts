import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const oauthConnections = sqliteTable(
	"oauth_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		provider: text("provider").notNull(),
		externalUserId: text("external_user_id").notNull(),
		externalUserEmail: text("external_user_email"),
		connectedByUserId: text("connected_by_user_id").notNull(),
		scope: text("scope").notNull().default(""),
		accessTokenCiphertext: text("access_token_ciphertext").notNull(),
		accessTokenIv: text("access_token_iv").notNull(),
		accessTokenTag: text("access_token_tag").notNull(),
		refreshTokenCiphertext: text("refresh_token_ciphertext"),
		refreshTokenIv: text("refresh_token_iv"),
		refreshTokenTag: text("refresh_token_tag"),
		expiresAt: integer("expires_at", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("oauth_connections_org_provider_idx").on(table.orgId, table.provider),
		index("oauth_connections_org_idx").on(table.orgId),
	],
)

export const oauthAuthStates = sqliteTable(
	"oauth_auth_states",
	{
		state: text("state").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		provider: text("provider").notNull(),
		initiatedByUserId: text("initiated_by_user_id").notNull(),
		redirectUri: text("redirect_uri").notNull(),
		returnTo: text("return_to"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		expiresAt: integer("expires_at", { mode: "number" }).notNull(),
	},
	(table) => [index("oauth_auth_states_expires_idx").on(table.expiresAt)],
)

export type OAuthConnectionRow = typeof oauthConnections.$inferSelect
export type OAuthConnectionInsert = typeof oauthConnections.$inferInsert
export type OAuthAuthStateRow = typeof oauthAuthStates.$inferSelect
export type OAuthAuthStateInsert = typeof oauthAuthStates.$inferInsert

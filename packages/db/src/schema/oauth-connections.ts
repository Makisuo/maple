import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const oauthConnections = pgTable(
	"oauth_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		provider: text("provider").notNull(),
		externalUserId: text("external_user_id").notNull(),
		externalUserEmail: text("external_user_email"),
		// Provider-agnostic display label for the connected principal (e.g. a Cloudflare account
		// name). Kept separate from externalUserEmail so that column only ever holds real emails.
		externalAccountName: text("external_account_name"),
		connectedByUserId: text("connected_by_user_id").notNull(),
		scope: text("scope").notNull().default(""),
		accessTokenCiphertext: text("access_token_ciphertext").notNull(),
		accessTokenIv: text("access_token_iv").notNull(),
		accessTokenTag: text("access_token_tag").notNull(),
		refreshTokenCiphertext: text("refresh_token_ciphertext"),
		refreshTokenIv: text("refresh_token_iv"),
		refreshTokenTag: text("refresh_token_tag"),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("oauth_connections_org_provider_idx").on(table.orgId, table.provider),
		index("oauth_connections_org_idx").on(table.orgId),
	],
)

export const oauthAuthStates = pgTable(
	"oauth_auth_states",
	{
		state: text("state").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		provider: text("provider").notNull(),
		initiatedByUserId: text("initiated_by_user_id").notNull(),
		redirectUri: text("redirect_uri").notNull(),
		returnTo: text("return_to"),
		// PKCE code verifier (RFC 7636). Set for providers that use the Authorization Code + PKCE
		// flow (e.g. Cloudflare public clients, which carry no client secret); null otherwise.
		codeVerifier: text("code_verifier"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [index("oauth_auth_states_expires_idx").on(table.expiresAt)],
)

export type OAuthConnectionRow = typeof oauthConnections.$inferSelect
export type OAuthConnectionInsert = typeof oauthConnections.$inferInsert
export type OAuthAuthStateRow = typeof oauthAuthStates.$inferSelect
export type OAuthAuthStateInsert = typeof oauthAuthStates.$inferInsert

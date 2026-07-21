import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const mcpOAuthClients = pgTable("mcp_oauth_clients", {
	clientId: text("client_id").primaryKey(),
	clientName: text("client_name").notNull(),
	redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
	clientUri: text("client_uri"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
})

export const mcpOAuthAuthorizations = pgTable(
	"mcp_oauth_authorizations",
	{
		requestIdHash: text("request_id_hash").primaryKey(),
		clientId: text("client_id").notNull(),
		clientName: text("client_name").notNull(),
		redirectUri: text("redirect_uri").notNull(),
		state: text("state"),
		resource: text("resource").notNull(),
		scopes: jsonb("scopes").$type<string[]>().notNull(),
		codeChallenge: text("code_challenge").notNull(),
		authorizationCodeHash: text("authorization_code_hash"),
		approvedOrgId: text("approved_org_id"),
		approvedUserId: text("approved_user_id"),
		approvedRoles: jsonb("approved_roles").$type<string[]>(),
		approvedUserEmail: text("approved_user_email"),
		approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
		deniedAt: timestamp("denied_at", { withTimezone: true, mode: "date" }),
		usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("mcp_oauth_authorizations_code_unique").on(table.authorizationCodeHash),
		index("mcp_oauth_authorizations_expires_idx").on(table.expiresAt),
	],
)

export const mcpOAuthRefreshTokens = pgTable(
	"mcp_oauth_refresh_tokens",
	{
		id: text("id").primaryKey(),
		tokenHash: text("token_hash").notNull(),
		familyId: text("family_id").notNull(),
		clientId: text("client_id").notNull(),
		resource: text("resource").notNull(),
		scopes: jsonb("scopes").$type<string[]>().notNull(),
		orgId: text("org_id").notNull(),
		userId: text("user_id").notNull(),
		roles: jsonb("roles").$type<string[]>().notNull(),
		userEmail: text("user_email"),
		accessKeyId: text("access_key_id").notNull(),
		replacedById: text("replaced_by_id"),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("mcp_oauth_refresh_tokens_hash_unique").on(table.tokenHash),
		index("mcp_oauth_refresh_tokens_family_idx").on(table.familyId),
		index("mcp_oauth_refresh_tokens_expires_idx").on(table.expiresAt),
	],
)

export type McpOAuthClientRow = typeof mcpOAuthClients.$inferSelect
export type McpOAuthAuthorizationRow = typeof mcpOAuthAuthorizations.$inferSelect
export type McpOAuthRefreshTokenRow = typeof mcpOAuthRefreshTokens.$inferSelect

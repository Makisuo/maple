import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// ---------------------------------------------------------------------------
// Slack workspace installations. One row per Slack team (workspace) that has
// installed the Maple Slack app via OAuth. A row binds a Slack `teamId` to a
// Maple org and stores, encrypted, both the Slack bot token (used to post
// messages / list channels) and a minted Maple API key secret (handed to the
// Railway-hosted bot so it can call Maple's MCP server on the org's behalf).
//
// Unlike normal API keys — which are stored hash-only — the bot needs the raw
// `maple_ak_…` secret at runtime, so we keep it encrypted (AES-256-GCM, same
// column pattern as `alert_destinations`) alongside the key id.
// ---------------------------------------------------------------------------

export const slackWorkspaces = pgTable(
	"slack_workspaces",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** Slack workspace (team) id, e.g. `T0123ABCD`. Unique across all orgs. */
		teamId: text("team_id").notNull(),
		teamName: text("team_name"),
		botUserId: text("bot_user_id"),
		scope: text("scope"),
		// Encrypted Slack bot token (`xoxb-…`).
		botTokenCiphertext: text("bot_token_ciphertext").notNull(),
		botTokenIv: text("bot_token_iv").notNull(),
		botTokenTag: text("bot_token_tag").notNull(),
		// Minted Maple API key handed to the bot. `apiKeyId` references the
		// `api_keys` row (for revocation); the encrypted columns hold the raw
		// `maple_ak_…` secret so we can decrypt and forward it to the bot.
		apiKeyId: text("api_key_id"),
		apiKeySecretCiphertext: text("api_key_secret_ciphertext").notNull(),
		apiKeySecretIv: text("api_key_secret_iv").notNull(),
		apiKeySecretTag: text("api_key_secret_tag").notNull(),
		installedByUserId: text("installed_by_user_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		// Set when the install is uninstalled/revoked. Revoked rows read as "not
		// installed" and are skipped by the bot-resolve + dispatch lookups.
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		uniqueIndex("slack_workspaces_team_id_idx").on(table.teamId),
		index("slack_workspaces_org_idx").on(table.orgId),
		// Enforce at most one ACTIVE installation per org. Revoked rows are exempt so
		// history (and re-installs) can coexist. Consumers select the single active
		// row per org, so this invariant keeps that lookup unambiguous.
		uniqueIndex("slack_workspaces_active_org_idx")
			.on(table.orgId)
			.where(sql`${table.revokedAt} IS NULL`),
	],
)

export type SlackWorkspaceRow = typeof slackWorkspaces.$inferSelect
export type SlackWorkspaceInsert = typeof slackWorkspaces.$inferInsert

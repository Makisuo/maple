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
// column pattern as `alert_destinations`) alongside the key id. The ciphertexts
// are bound to `(org_id, team_id, column)` via GCM additional authenticated data
// (`slackSecretAad`), so a triple cannot be relocated to another row.
//
// `org_id` carries no foreign key: orgs live in Clerk, not Postgres, so no table
// in this schema references them. Org deletion is handled by the explicit
// `ORG_SCOPED_TABLES` purge list in `apps/api/src/services/OrganizationService.ts`
// — this table must be listed there.
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
		// Encrypted Slack bot token (`xoxb-…`). Nullable so uninstall can drop the
		// ciphertext once Slack has confirmed the token is dead — a revoked row must
		// not keep a decryptable secret around forever.
		botTokenCiphertext: text("bot_token_ciphertext"),
		botTokenIv: text("bot_token_iv"),
		botTokenTag: text("bot_token_tag"),
		// Minted Maple API key handed to the bot. `apiKeyId` references the
		// `api_keys` row (for revocation); the encrypted columns hold the raw
		// `maple_ak_…` secret so we can decrypt and forward it to the bot. Nullable
		// for the same reason as the bot token — revocation only needs `apiKeyId`.
		apiKeyId: text("api_key_id"),
		apiKeySecretCiphertext: text("api_key_secret_ciphertext"),
		apiKeySecretIv: text("api_key_secret_iv"),
		apiKeySecretTag: text("api_key_secret_tag"),
		installedByUserId: text("installed_by_user_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		// Set when the install is uninstalled/revoked. Revoked rows read as "not
		// installed" and are skipped by the bot-resolve + dispatch lookups.
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
		// Why `revoked_at` was set: `uninstalled` (dashboard), `superseded` (replaced
		// by a same-org install of another team), or a remote reason — `app_uninstalled`
		// / `tokens_revoked` (Slack event via the bot) / `reconciliation` (cron probe).
		// Remote reasons drive the "disconnected from Slack's side" status surface.
		// Null on active rows and on rows revoked before this column existed.
		revokedReason: text("revoked_reason"),
	},
	(table) => [
		// One row per Slack team, ever: a re-install upserts the existing row in
		// place, so this table holds current state, not install history.
		uniqueIndex("slack_workspaces_team_id_idx").on(table.teamId),
		index("slack_workspaces_org_idx").on(table.orgId),
		// Enforce at most one ACTIVE installation per org. Revoked rows are exempt so
		// an org can install a different team while the old row stays revoked.
		// Consumers select the single active row per org, so this invariant keeps
		// that lookup unambiguous.
		uniqueIndex("slack_workspaces_active_org_idx")
			.on(table.orgId)
			.where(sql`${table.revokedAt} IS NULL`),
	],
)

export type SlackWorkspaceRow = typeof slackWorkspaces.$inferSelect
export type SlackWorkspaceInsert = typeof slackWorkspaces.$inferInsert

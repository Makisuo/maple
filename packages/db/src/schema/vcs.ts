import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type {
	GitCommitSha,
	VcsAccountType,
	VcsBranchId,
	VcsCommitRowId,
	VcsInstallStatus,
	VcsInstallationId,
	VcsProviderId,
	VcsRepoSelection,
	VcsRepoStatus,
	VcsRepoSyncStatus,
	VcsRepositoryId,
} from "@maple/domain/http"

// Vendor-agnostic VCS integration tables. Every row carries a `provider`
// discriminator; GitHub-specific concepts never reach this layer. External
// provider ids (installation/repo/account) are stored as TEXT for
// cross-provider generality. Timestamps are stored as `timestamptz`.
//
// IMPORTANT: only `VcsRepository` (apps/api/src/services/vcs/VcsRepository.ts)
// may import these tables. All other code goes through that repo service.

/** One row per provider App installation, owned by the initiating Maple org. */
export const vcsInstallations = pgTable(
	"vcs_installations",
	{
		id: text("id").$type<VcsInstallationId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		externalInstallationId: text("external_installation_id").notNull(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type").$type<VcsAccountType>().notNull(),
		externalAccountId: text("external_account_id").notNull(),
		accountAvatarUrl: text("account_avatar_url"),
		repositorySelection: text("repository_selection").$type<VcsRepoSelection>().notNull().default("all"),
		status: text("status").$type<VcsInstallStatus>().notNull().default("active"),
		suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }),
		installedByUserId: text("installed_by_user_id").$type<UserId>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_installations_provider_external_idx").on(
			table.provider,
			table.externalInstallationId,
		),
		index("vcs_installations_org_idx").on(table.orgId),
	],
)

/** Repositories accessible to an installation, plus per-repo sync state. */
export const vcsRepositories = pgTable(
	"vcs_repositories",
	{
		id: text("id").$type<VcsRepositoryId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// Internal id of the owning vcs_installations row (NOT the provider's external
		// installation id). Provider ids are resolved at the sync/webhook boundary.
		installationId: text("installation_id").$type<VcsInstallationId>().notNull(),
		externalRepoId: text("external_repo_id").notNull(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		// The single branch this repo tracks: only its commits are backfilled and
		// ingested. Seeded to `default_branch` on discovery; user-owned thereafter
		// (a reconcile never overwrites it). Nullable to allow lazy fallback when the
		// tracked branch is deleted.
		trackedBranch: text("tracked_branch"),
		htmlUrl: text("html_url").notNull(),
		isPrivate: boolean("is_private").notNull().default(true),
		isArchived: boolean("is_archived").notNull().default(false),
		// Access lifecycle, distinct from sync_status: "active" (visible to the
		// installation) or "removed" (provider revoked access → soft-deleted; row +
		// commits kept, events ignored until re-granted). Hard delete is user-only.
		status: text("status").$type<VcsRepoStatus>().notNull().default("active"),
		syncStatus: text("sync_status").$type<VcsRepoSyncStatus>().notNull().default("pending"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
		lastSyncError: text("last_sync_error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("vcs_repositories_org_repo_idx").on(table.orgId, table.provider, table.externalRepoId),
		index("vcs_repositories_org_idx").on(table.orgId),
		index("vcs_repositories_installation_idx").on(table.installationId),
	],
)

/**
 * Resolved commits. Each commit belongs to exactly one `vcs_repositories` row
 * (`repository_id`) — a commit without a repo is not meaningful, and that link
 * is what a repo/installation purge cascades on. There is no branch link: a repo
 * stores the commits of its single tracked branch, so "the repo's commits" is the
 * whole set. The dashboard resolver matches a trace's full 40-char SHA by
 * `(org_id, sha)` — provider-agnostic, no join — so `org_id` stays denormalized
 * here. The row is self-contained (`html_url` + author fields).
 */
export const vcsCommits = pgTable(
	"vcs_commits",
	{
		id: text("id").$type<VcsCommitRowId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		// The owning repository row. `vcs_repositories` ids are globally unique so
		// this alone identifies the repo (no org/provider prefix needed in the link).
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		sha: text("sha").$type<GitCommitSha>().notNull(),
		message: text("message").notNull(),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authorLogin: text("author_login"),
		authorAvatarUrl: text("author_avatar_url"),
		authoredAt: timestamp("authored_at", { withTimezone: true, mode: "date" }),
		committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }).notNull(),
		htmlUrl: text("html_url").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One row per (repo, sha). repository_id is the leftmost column, so this
		// index also serves the cascade delete's `WHERE repository_id IN (…)`.
		uniqueIndex("vcs_commits_repo_sha_idx").on(table.repositoryId, table.sha),
		index("vcs_commits_org_sha_idx").on(table.orgId, table.sha),
	],
)

/**
 * Branches of a repository (names only — never the commits on them). This table
 * is the picker's list of branches the user can choose to track; which one is
 * tracked is named by `vcs_repositories.tracked_branch`, not a flag here.
 * `is_default` is a display hint (and the default seed for `tracked_branch`).
 */
export const vcsRepositoryBranches = pgTable(
	"vcs_repository_branches",
	{
		id: text("id").$type<VcsBranchId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		provider: text("provider").$type<VcsProviderId>().notNull(),
		repositoryId: text("repository_id").$type<VcsRepositoryId>().notNull(),
		name: text("name").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		headSha: text("head_sha").$type<GitCommitSha>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One row per (repo, branch name). repository_id leftmost ⇒ also serves the
		// per-repo branch list and the cascade delete's `WHERE repository_id IN (…)`.
		uniqueIndex("vcs_repository_branches_repo_name_idx").on(table.repositoryId, table.name),
		index("vcs_repository_branches_org_idx").on(table.orgId),
	],
)

export type VcsInstallationRow = typeof vcsInstallations.$inferSelect
export type VcsInstallationInsert = typeof vcsInstallations.$inferInsert
export type VcsRepositoryRow = typeof vcsRepositories.$inferSelect
export type VcsRepositoryInsert = typeof vcsRepositories.$inferInsert
export type VcsCommitRow = typeof vcsCommits.$inferSelect
export type VcsCommitInsert = typeof vcsCommits.$inferInsert
export type VcsRepositoryBranchRow = typeof vcsRepositoryBranches.$inferSelect
export type VcsRepositoryBranchInsert = typeof vcsRepositoryBranches.$inferInsert

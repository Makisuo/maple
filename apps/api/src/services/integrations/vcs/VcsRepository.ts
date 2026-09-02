import { randomUUID } from "node:crypto"
import {
	type BranchUpsertInput,
	type CommitUpsertInput,
	GitCommitSha,
	type OrgId,
	type RepoUpsertInput,
	type UserId,
	VcsBranch,
	type VcsBranchId,
	VcsCommit,
	VcsInstallation,
	type VcsInstallationId,
	type VcsInstallStatus,
	type VcsProviderId,
	VcsRepo,
	type VcsRepoSelection,
	VcsRepoDecodeError,
	VcsRepoPersistenceError,
	type VcsAccountType,
	type VcsRepositoryId,
	type VcsRepoSyncStatus,
} from "@maple/domain/http"
import {
	vcsCommits,
	vcsInstallations,
	vcsRepositoryBranches,
	type VcsCommitRow,
	type VcsInstallationRow,
	type VcsRepositoryBranchRow,
	vcsRepositories,
	type VcsRepositoryRow,
} from "@maple/db"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { dateToMs, msToDate } from "@/platform/time"

// Postgres caps bind parameters at 65535. Chunk unbounded `inArray(...)` filters
// and bulk inserts so a large installation (every repo/commit at once) stays well
// under the limit; the row chunk leaves ample headroom for the widest table.
const INARRAY_CHUNK_SIZE = 1000
const INSERT_CHUNK_SIZE = 1000

const decodeInstallation = Schema.decodeUnknownSync(VcsInstallation)
const decodeRepo = Schema.decodeUnknownSync(VcsRepo)
const decodeCommit = Schema.decodeUnknownSync(VcsCommit)
const decodeBranch = Schema.decodeUnknownSync(VcsBranch)
// Validate the SHA shape via the branded type (the regex lives only there);
// a malformed SHA throws and is caught into a VcsRepoDecodeError on write.
const decodeGitSha = Schema.decodeUnknownSync(GitCommitSha)

const toPersistenceError = (error: DatabaseError) => new VcsRepoPersistenceError({ message: error.message })

const decodeAll = <Row, A>(table: string, rows: ReadonlyArray<Row>, f: (row: Row) => A) =>
	Effect.try({
		try: () => rows.map(f),
		catch: (err) =>
			new VcsRepoDecodeError({
				message: err instanceof Error ? err.message : "row decode failed",
				table,
			}),
	})

const decodeOne = <Row, A>(table: string, row: Row, f: (row: Row) => A) =>
	Effect.try({
		try: () => f(row),
		catch: (err) =>
			new VcsRepoDecodeError({
				message: err instanceof Error ? err.message : "row decode failed",
				table,
			}),
	})

const rowToInstallation = (row: VcsInstallationRow): VcsInstallation =>
	decodeInstallation({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		externalInstallationId: row.externalInstallationId,
		accountLogin: row.accountLogin,
		accountType: row.accountType,
		externalAccountId: row.externalAccountId,
		accountAvatarUrl: row.accountAvatarUrl ?? null,
		repositorySelection: row.repositorySelection,
		status: row.status,
		suspendedAt: dateToMs(row.suspendedAt),
		installedByUserId: row.installedByUserId,
		createdAt: dateToMs(row.createdAt),
		updatedAt: dateToMs(row.updatedAt),
	})

const rowToRepo = (row: VcsRepositoryRow): VcsRepo =>
	decodeRepo({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		installationId: row.installationId,
		externalRepoId: row.externalRepoId,
		owner: row.owner,
		name: row.name,
		fullName: row.fullName,
		defaultBranch: row.defaultBranch,
		trackedBranch: row.trackedBranch ?? null,
		htmlUrl: row.htmlUrl,
		isPrivate: row.isPrivate,
		isArchived: row.isArchived,
		status: row.status,
		syncStatus: row.syncStatus,
		lastSyncedAt: dateToMs(row.lastSyncedAt),
		lastSyncError: row.lastSyncError ?? null,
		createdAt: dateToMs(row.createdAt),
		updatedAt: dateToMs(row.updatedAt),
	})

const rowToCommit = (row: VcsCommitRow): VcsCommit =>
	decodeCommit({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		repositoryId: row.repositoryId,
		sha: row.sha,
		message: row.message,
		authorName: row.authorName ?? null,
		authorEmail: row.authorEmail ?? null,
		authorLogin: row.authorLogin ?? null,
		authorAvatarUrl: row.authorAvatarUrl ?? null,
		authoredAt: dateToMs(row.authoredAt),
		committedAt: dateToMs(row.committedAt),
		htmlUrl: row.htmlUrl,
		createdAt: dateToMs(row.createdAt),
	})

const rowToBranch = (row: VcsRepositoryBranchRow): VcsBranch =>
	decodeBranch({
		id: row.id,
		orgId: row.orgId,
		provider: row.provider,
		repositoryId: row.repositoryId,
		name: row.name,
		isDefault: row.isDefault,
		headSha: row.headSha ?? null,
		createdAt: dateToMs(row.createdAt),
		updatedAt: dateToMs(row.updatedAt),
	})

// Note: `status` is intentionally not part of the upsert input. A new row gets
// the schema column default ("active"); all status transitions (suspend /
// disconnect / unsuspend) go through `markInstallationStatus`, so a reconciling
// upsert never touches an existing installation's status.
interface UpsertInstallationInput {
	readonly orgId: OrgId
	readonly provider: VcsProviderId
	readonly externalInstallationId: string
	readonly accountLogin: string
	readonly accountType: VcsAccountType
	readonly externalAccountId: string
	readonly accountAvatarUrl: string | null
	readonly repositorySelection: VcsRepoSelection
	readonly installedByUserId: UserId
}

interface RepoSyncStatusUpdate {
	readonly status: VcsRepoSyncStatus
	readonly error?: string | null
	readonly syncedAt?: number | null
}

/**
 * Read scope for repository queries — a required argument so every caller must
 * consciously decide whether provider-removed repos are in scope. `"active"`
 * returns only repos still visible to the installation; `"all"` includes those
 * whose access was removed (`status === "removed"`). Most business logic wants
 * `"active"`; the dashboard status (which surfaces the "re-enable / delete"
 * affordances) wants `"all"`.
 */
type RepoQueryScope = "active" | "all"

export class VcsRepository extends Context.Service<VcsRepository>()("@maple/api/services/vcs/VcsRepository", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const selectInstallationRow = (provider: VcsProviderId, externalInstallationId: string) =>
			database
				.execute((db) =>
					db
						.select()
						.from(vcsInstallations)
						.where(
							and(
								eq(vcsInstallations.provider, provider),
								eq(vcsInstallations.externalInstallationId, externalInstallationId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

		// THE external → internal resolver for installations. Returns the whole row
		// (including our internal `id`) so callers never need a resolve-then-refetch.
		const resolveInstallation = Effect.fn("VcsRepository.resolveInstallation")(function* (
			provider: VcsProviderId,
			externalInstallationId: string,
		) {
			const rows = yield* selectInstallationRow(provider, externalInstallationId)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsInstallation>()
			return Option.some(yield* decodeOne("vcs_installations", row.value, rowToInstallation))
		})

		const listInstallationsByOrg = Effect.fn("VcsRepository.listInstallationsByOrg")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) => db.select().from(vcsInstallations).where(eq(vcsInstallations.orgId, orgId)))
				.pipe(Effect.mapError(toPersistenceError))
			return yield* decodeAll("vcs_installations", rows, rowToInstallation)
		})

		// Every installation across every org — the cross-org listing the sync
		// scheduler walks. Status is not filtered here; the caller applies
		// `isInstallationProcessable` (the single place that rule lives).
		const listAllInstallations = Effect.fn("VcsRepository.listAllInstallations")(function* () {
			const rows = yield* database
				.execute((db) => db.select().from(vcsInstallations))
				.pipe(Effect.mapError(toPersistenceError))
			return yield* decodeAll("vcs_installations", rows, rowToInstallation)
		})

		// Look up an installation by Maple's own id — org-scoped as a safety bound
		// (UUIDs are globally unique, but the org filter prevents cross-tenant reads).
		const getInstallationById = Effect.fn("VcsRepository.getInstallationById")(function* (
			orgId: OrgId,
			installationId: VcsInstallationId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsInstallations)
						.where(
							and(eq(vcsInstallations.orgId, orgId), eq(vcsInstallations.id, installationId)),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsInstallation>()
			return Option.some(yield* decodeOne("vcs_installations", row.value, rowToInstallation))
		})

		const upsertInstallation = Effect.fn("VcsRepository.upsertInstallation")(function* (
			input: UpsertInstallationInput,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			const rows = yield* database
				.execute((db) =>
					db
						.insert(vcsInstallations)
						// `status`/`suspended_at` are omitted: a new row takes the schema
						// default ("active"), and on conflict they are left untouched so a
						// reconcile can't un-suspend. Status is owned by markInstallationStatus.
						.values({
							id: randomUUID() as VcsInstallation["id"],
							orgId: input.orgId,
							provider: input.provider,
							externalInstallationId: input.externalInstallationId,
							accountLogin: input.accountLogin,
							accountType: input.accountType,
							externalAccountId: input.externalAccountId,
							accountAvatarUrl: input.accountAvatarUrl,
							repositorySelection: input.repositorySelection,
							installedByUserId: input.installedByUserId,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [vcsInstallations.provider, vcsInstallations.externalInstallationId],
							// Ownership columns (org_id, installed_by_user_id, created_at) and
							// status/suspended_at are immutable on conflict — only mutable
							// provider metadata is refreshed.
							set: {
								accountLogin: sql`excluded.account_login`,
								accountType: sql`excluded.account_type`,
								externalAccountId: sql`excluded.external_account_id`,
								accountAvatarUrl: sql`excluded.account_avatar_url`,
								repositorySelection: sql`excluded.repository_selection`,
								updatedAt: sql`excluded.updated_at`,
							},
						})
						.returning(),
				)
				.pipe(Effect.mapError(toPersistenceError))

			// `.returning()` gives back the upserted row in the same round-trip, avoiding
			// a read-after-write race with a concurrent status change.
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new VcsRepoPersistenceError({ message: "Installation upsert returned no row" })
			}
			return yield* decodeOne("vcs_installations", row.value, rowToInstallation)
		})

		const markInstallationStatus = Effect.fn("VcsRepository.markInstallationStatus")(function* (
			installationId: VcsInstallationId,
			status: VcsInstallStatus,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			yield* database
				.execute((db) =>
					db
						.update(vcsInstallations)
						.set({ status, suspendedAt: status === "suspended" ? now : null, updatedAt: now })
						.where(eq(vcsInstallations.id, installationId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const listRepositoriesByInstallation = Effect.fn("VcsRepository.listRepositoriesByInstallation")(
			function* (installationId: VcsInstallationId, scope: RepoQueryScope) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(vcsRepositories)
							.where(
								and(
									eq(vcsRepositories.installationId, installationId),
									// "all" includes provider-removed repos; "active" filters them out.
									...(scope === "active" ? [eq(vcsRepositories.status, "active")] : []),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return yield* decodeAll("vcs_repositories", rows, rowToRepo)
			},
		)

		// THE external → internal resolver for repositories. Returns the whole row
		// (including internal `id` and `installationId`) so the sync path never needs
		// a separate refetch. Org-scoped so a tenant can't read another's repo.
		const resolveRepository = Effect.fn("VcsRepository.resolveRepository")(function* (
			orgId: OrgId,
			provider: VcsProviderId,
			externalRepoId: string,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.provider, provider),
								eq(vcsRepositories.externalRepoId, externalRepoId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsRepo>()
			return Option.some(yield* decodeOne("vcs_repositories", row.value, rowToRepo))
		})

		// Look up a repo by Maple's own id — org-scoped as a safety bound
		// (UUIDs are globally unique, but the org filter prevents cross-tenant reads).
		const getRepositoryById = Effect.fn("VcsRepository.getRepositoryById")(function* (
			orgId: OrgId,
			repositoryId: VcsRepositoryId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositories)
						.where(and(eq(vcsRepositories.orgId, orgId), eq(vcsRepositories.id, repositoryId)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsRepo>()
			return Option.some(yield* decodeOne("vcs_repositories", row.value, rowToRepo))
		})

		// Bulk sibling of getRepositoryById. The services table resolves a whole
		// page of deploy rows at once; issuing one read per repository would turn
		// a single request into N outbound calls, which is the dominant driver of
		// Postgres latency on this worker.
		const getRepositoriesByIds = Effect.fn("VcsRepository.getRepositoriesByIds")(function* (
			orgId: OrgId,
			repositoryIds: ReadonlyArray<VcsRepositoryId>,
		) {
			if (repositoryIds.length === 0) return [] as ReadonlyArray<VcsRepo>
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								inArray(vcsRepositories.id, [...new Set(repositoryIds)]),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return yield* Effect.forEach(rows, (row) => decodeOne("vcs_repositories", row, rowToRepo))
		})

		// Persist the installation's repositories. Takes the resolved installation
		// (not raw ids) so org/provider/internal-installation-id all come from one
		// entity — the rows link to it by our internal `installationId`.
		const upsertRepositories = Effect.fn("VcsRepository.upsertRepositories")(function* (
			installation: VcsInstallation,
			repos: ReadonlyArray<RepoUpsertInput>,
		) {
			if (repos.length === 0) return
			const now = msToDate(yield* Clock.currentTimeMillis)
			const values = repos.map((r) => ({
				id: randomUUID() as VcsRepo["id"],
				orgId: installation.orgId,
				provider: installation.provider,
				installationId: installation.id,
				externalRepoId: r.externalRepoId,
				owner: r.owner,
				name: r.name,
				fullName: r.fullName,
				defaultBranch: r.defaultBranch,
				// Seed the tracked branch to the default on first discovery. Left
				// untouched on conflict below (the user owns it thereafter).
				trackedBranch: r.defaultBranch,
				htmlUrl: r.htmlUrl,
				isPrivate: r.isPrivate,
				isArchived: r.isArchived,
				// Every repo handed to upsert is one the installation can currently
				// see, so it is active. Set explicitly (not via column default) so the
				// conflict clause below can reactivate a previously-removed repo.
				status: "active" as const,
				createdAt: now,
				updatedAt: now,
			}))
			// Share-lock the owning installation for the duration of the write. A purge
			// deletes the installation row FIRST, so it either waits for this lock and
			// then sweeps these rows, or has already won — and a worker holding a stale
			// snapshot writes nothing instead of resurrecting purged data.
			yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const parent = await tx
							.select({ id: vcsInstallations.id })
							.from(vcsInstallations)
							.where(eq(vcsInstallations.id, installation.id))
							.for("share")
						if (parent.length === 0) return
						for (const chunk of Arr.chunksOf(values, INSERT_CHUNK_SIZE)) {
							await tx
								.insert(vcsRepositories)
								.values(chunk)
								.onConflictDoUpdate({
									target: [
										vcsRepositories.orgId,
										vcsRepositories.provider,
										vcsRepositories.externalRepoId,
									],
									set: {
										// A repo can be reassigned to a different installation; refresh the link.
										installationId: sql`excluded.installation_id`,
										owner: sql`excluded.owner`,
										name: sql`excluded.name`,
										fullName: sql`excluded.full_name`,
										defaultBranch: sql`excluded.default_branch`,
										htmlUrl: sql`excluded.html_url`,
										isPrivate: sql`excluded.is_private`,
										isArchived: sql`excluded.is_archived`,
										// Reactivate on re-add: a repo present in this upsert is visible
										// again, so a prior "removed" soft-delete is cleared. (sync_status
										// is deliberately left untouched — its backfill state still holds.)
										status: sql`excluded.status`,
										updatedAt: sql`excluded.updated_at`,
									},
								})
						}
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Soft-delete: the provider revoked access to this repo. The row and its
		// synced commits are kept (so history survives and a re-grant reactivates
		// cleanly via upsertRepositories); `status` gates further event processing.
		const markRepositoryRemoved = Effect.fn("VcsRepository.markRepositoryRemoved")(function* (
			repositoryId: VcsRepositoryId,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({ status: "removed", updatedAt: now })
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Hard-delete a single repo and its commits by Maple's own repository id.
		// User-initiated only: the dashboard "delete from Maple" action. Confirm the
		// row exists for this org first (so a foreign/absent id is a no-op, not a
		// blind delete). Idempotent.
		const purgeRepository = Effect.fn("VcsRepository.purgeRepository")(function* (
			orgId: OrgId,
			repositoryId: VcsRepositoryId,
		) {
			const repoRows = yield* database.execute((db) =>
				db
					.select({ id: vcsRepositories.id })
					.from(vcsRepositories)
					.where(and(eq(vcsRepositories.orgId, orgId), eq(vcsRepositories.id, repositoryId)))
					.limit(1),
			)
			if (repoRows[0]?.id === undefined) return false
			// One atomic transaction, PARENT FIRST: deleting the repo row before its
			// children pairs with the share-lock gates in the child upserts — an
			// in-flight sync either commits before this delete acquires the row lock
			// (its rows are swept below) or sees the row gone and writes nothing.
			yield* database.execute((db) =>
				db.transaction(async (tx) => {
					await tx.delete(vcsRepositories).where(eq(vcsRepositories.id, repositoryId))
					await tx
						.delete(vcsRepositoryBranches)
						.where(eq(vcsRepositoryBranches.repositoryId, repositoryId))
					await tx.delete(vcsCommits).where(eq(vcsCommits.repositoryId, repositoryId))
				}),
			)
			return true
		}, Effect.mapError(toPersistenceError))

		// Write a sync-status transition. `last_synced_at` is touched ONLY when the
		// caller passes `syncedAt` (i.e. a sync actually completed) — so marking a repo
		// "backfilling" at the start of / mid a run never stamps a misleading sync time;
		// it stays whatever the last *successful* sync left.
		const updateRepoSyncStatus = Effect.fn("VcsRepository.updateRepoSyncStatus")(function* (
			repositoryId: VcsRepositoryId,
			update: RepoSyncStatusUpdate,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({
							syncStatus: update.status,
							lastSyncError: update.error ?? null,
							...("syncedAt" in update
								? { lastSyncedAt: msToDate(update.syncedAt) }
								: undefined),
							updatedAt: now,
						})
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Flag a single repo's sync as errored without touching its cursor /
		// last-synced time (a failed fetch must not wipe prior progress).
		const markRepoSyncError = Effect.fn("VcsRepository.markRepoSyncError")(function* (
			repositoryId: VcsRepositoryId,
			message: string,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			yield* database
				.execute((db) =>
					db
						.update(vcsRepositories)
						.set({ syncStatus: "error", lastSyncError: message, updatedAt: now })
						.where(eq(vcsRepositories.id, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Persist commits for an already-resolved repository. Commits belong to the
		// repo only (no commit↔branch link — a repo tracks one branch at a time).
		// Idempotent: upsert on (repository_id, sha). The commit row denormalizes
		// org/provider for the dashboard's (org_id, sha) lookup.
		const upsertCommits = Effect.fn("VcsRepository.upsertCommits")(function* (
			repository: VcsRepo,
			commits: ReadonlyArray<CommitUpsertInput>,
		) {
			if (commits.length === 0) return 0
			const now = msToDate(yield* Clock.currentTimeMillis)
			// Decode every SHA through the branded type before writing — a bad SHA
			// throws here and is mapped to VcsRepoDecodeError below.
			const values = yield* Effect.try({
				try: () =>
					commits.map((c) => {
						const sha = decodeGitSha(c.sha)
						return {
							id: randomUUID() as VcsCommit["id"],
							orgId: repository.orgId,
							provider: repository.provider,
							repositoryId: repository.id,
							sha,
							message: c.message,
							authorName: c.authorName,
							authorEmail: c.authorEmail,
							authorLogin: c.authorLogin,
							authorAvatarUrl: c.authorAvatarUrl,
							authoredAt: msToDate(c.authoredAt),
							committedAt: msToDate(c.committedAt),
							htmlUrl: c.htmlUrl,
							createdAt: now,
						}
					}),
				catch: (err) =>
					new VcsRepoDecodeError({
						message: err instanceof Error ? err.message : "commit decode failed",
						table: "vcs_commits",
						column: "sha",
					}),
			})

			// Upsert the immutable commit rows, refreshing mutable metadata on conflict.
			// Gated on the share-locked repo row (see upsertRepositories): a worker that
			// waited on GitHub across a purge must not reinsert a deleted repo's private
			// commits. Returns 0 when the repo is gone.
			return yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const parent = await tx
							.select({ id: vcsRepositories.id })
							.from(vcsRepositories)
							.where(eq(vcsRepositories.id, repository.id))
							.for("share")
						if (parent.length === 0) return 0
						for (const chunk of Arr.chunksOf(values, INSERT_CHUNK_SIZE)) {
							await tx
								.insert(vcsCommits)
								.values(chunk)
								.onConflictDoUpdate({
									target: [vcsCommits.repositoryId, vcsCommits.sha],
									set: {
										message: sql`excluded.message`,
										authorName: sql`excluded.author_name`,
										authorEmail: sql`excluded.author_email`,
										authorLogin: sql`excluded.author_login`,
										authorAvatarUrl: sql`excluded.author_avatar_url`,
										authoredAt: sql`excluded.authored_at`,
										committedAt: sql`excluded.committed_at`,
										htmlUrl: sql`excluded.html_url`,
									},
								})
						}
						return values.length
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const findCommitBySha = Effect.fn("VcsRepository.findCommitBySha")(function* (
			orgId: OrgId,
			sha: GitCommitSha,
		) {
			// Joins the owning repo (existence only — no columns read) so a commit
			// orphaned by a purge racing a stale write is unreadable, not leaked.
			const rows = yield* database
				.execute((db) =>
					db
						.select({ commit: vcsCommits })
						.from(vcsCommits)
						.innerJoin(vcsRepositories, eq(vcsCommits.repositoryId, vcsRepositories.id))
						.where(and(eq(vcsCommits.orgId, orgId), eq(vcsCommits.sha, sha)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) return Option.none<VcsCommit>()
			return Option.some(yield* decodeOne("vcs_commits", row.value.commit, rowToCommit))
		})

		// Bulk sibling of findCommitBySha, for resolving a whole table of deploy
		// rows in one read instead of one per SHA. Unknown SHAs are simply absent
		// from the result — callers fall back to a provider probe for those.
		const findCommitsByShas = Effect.fn("VcsRepository.findCommitsByShas")(function* (
			orgId: OrgId,
			shas: ReadonlyArray<GitCommitSha>,
		) {
			if (shas.length === 0) return [] as ReadonlyArray<VcsCommit>
			const rows = yield* database
				.execute((db) =>
					db
						.select({ commit: vcsCommits })
						.from(vcsCommits)
						// Same orphan shield as findCommitBySha.
						.innerJoin(vcsRepositories, eq(vcsCommits.repositoryId, vcsRepositories.id))
						.where(and(eq(vcsCommits.orgId, orgId), inArray(vcsCommits.sha, [...new Set(shas)]))),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return yield* Effect.forEach(rows, (row) => decodeOne("vcs_commits", row.commit, rowToCommit))
		})

		// Bulk upsert a repo's branches from a provider listing — just the picker's
		// list of names. `isDefault` is a display hint derived here (the provider is
		// oblivious to it) by matching the repo's `defaultBranch`. Which branch is
		// tracked lives on the repo (`tracked_branch`), not here.
		const upsertBranches = Effect.fn("VcsRepository.upsertBranches")(function* (
			repository: VcsRepo,
			branches: ReadonlyArray<BranchUpsertInput>,
		) {
			if (branches.length === 0) return
			const now = msToDate(yield* Clock.currentTimeMillis)
			const values = yield* Effect.try({
				try: () =>
					branches.map((b) => {
						const isDefault = b.name === repository.defaultBranch
						return {
							id: randomUUID() as VcsBranch["id"],
							orgId: repository.orgId,
							provider: repository.provider,
							repositoryId: repository.id,
							name: b.name,
							isDefault,
							headSha: b.headSha === null ? null : decodeGitSha(b.headSha),
							createdAt: now,
							updatedAt: now,
						}
					}),
				catch: (err) =>
					new VcsRepoDecodeError({
						message: err instanceof Error ? err.message : "branch decode failed",
						table: "vcs_repository_branches",
						column: "head_sha",
					}),
			})
			// Gated on the share-locked repo row (see upsertRepositories) so a stale
			// worker cannot repopulate the picker of a purged repo.
			yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const parent = await tx
							.select({ id: vcsRepositories.id })
							.from(vcsRepositories)
							.where(eq(vcsRepositories.id, repository.id))
							.for("share")
						if (parent.length === 0) return
						for (const chunk of Arr.chunksOf(values, INSERT_CHUNK_SIZE)) {
							await tx
								.insert(vcsRepositoryBranches)
								.values(chunk)
								.onConflictDoUpdate({
									target: [vcsRepositoryBranches.repositoryId, vcsRepositoryBranches.name],
									set: {
										isDefault: sql`excluded.is_default`,
										headSha: sql`excluded.head_sha`,
										updatedAt: sql`excluded.updated_at`,
									},
								})
						}
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Resolve a branch by name, creating it if absent (a push can surface a branch
		// the picker hasn't listed yet, keeping it selectable). `isDefault` is the
		// display hint derived from the repo's default branch; `head_sha` is left
		// untouched on an existing row.
		const getOrCreateBranch = Effect.fn("VcsRepository.getOrCreateBranch")(function* (
			repository: VcsRepo,
			name: string,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			const isDefault = name === repository.defaultBranch
			const rows = yield* database
				.execute((db) =>
					db
						.insert(vcsRepositoryBranches)
						.values({
							id: randomUUID() as VcsBranch["id"],
							orgId: repository.orgId,
							provider: repository.provider,
							repositoryId: repository.id,
							name,
							isDefault,
							headSha: null,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [vcsRepositoryBranches.repositoryId, vcsRepositoryBranches.name],
							set: { isDefault: sql`excluded.is_default`, updatedAt: sql`excluded.updated_at` },
						})
						.returning(),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new VcsRepoPersistenceError({ message: "Branch upsert returned no row" })
			}
			return yield* decodeOne("vcs_repository_branches", row.value, rowToBranch)
		})

		const listBranchesByRepository = Effect.fn("VcsRepository.listBranchesByRepository")(function* (
			repositoryId: VcsRepositoryId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(vcsRepositoryBranches)
						.where(eq(vcsRepositoryBranches.repositoryId, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return yield* decodeAll("vcs_repository_branches", rows, rowToBranch)
		})

		// Retarget the repo's single tracked branch: point `tracked_branch` at the new
		// branch AND wipe stored commits (they were the old branch's history). Leaves
		// `sync_status`/`last_synced_at` untouched — the sync engine owns those
		// transitions for the subsequent backfill. The update + commit-wipe run as one
		// atomic batch so we never point at the new branch while still holding old commits.
		const changeTrackedBranch = Effect.fn("VcsRepository.changeTrackedBranch")(function* (
			orgId: OrgId,
			repositoryId: VcsRepositoryId,
			branch: string,
		) {
			const now = msToDate(yield* Clock.currentTimeMillis)
			yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx
							.update(vcsRepositories)
							.set({ trackedBranch: branch, updatedAt: now })
							.where(
								and(eq(vcsRepositories.orgId, orgId), eq(vcsRepositories.id, repositoryId)),
							)
						// Org-scope the commit wipe too: without it, an id belonging to
						// another org would no-op the update but still delete that org's
						// commits. Mirrors the org-scoped delete in purgeRepository.
						await tx
							.delete(vcsCommits)
							.where(
								and(eq(vcsCommits.orgId, orgId), eq(vcsCommits.repositoryId, repositoryId)),
							)
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		// Drop the branch rows by id (their repo keeps its commits — a branch is just
		// a name in the picker now).
		const deleteBranchesByIds = (ids: ReadonlyArray<VcsBranchId>) =>
			Effect.gen(function* () {
				if (ids.length === 0) return
				yield* Effect.forEach(
					Arr.chunksOf(ids, INARRAY_CHUNK_SIZE),
					(chunk) =>
						database
							.execute((db) =>
								db
									.delete(vcsRepositoryBranches)
									.where(inArray(vcsRepositoryBranches.id, chunk)),
							)
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)
			})

		// Reconcile branch deletions after a full re-list: hard-delete local branch
		// rows absent from the provider's set, returning their names so the caller can
		// detect whether the tracked branch vanished. When the listing was truncated
		// at the page cap, skip deletion (absence isn't authoritative) and report none.
		const reconcileBranchDeletions = Effect.fn("VcsRepository.reconcileBranchDeletions")(function* (
			repositoryId: VcsRepositoryId,
			remoteNames: ReadonlySet<string>,
			options: { readonly truncated: boolean },
		) {
			if (options.truncated) return [] as ReadonlyArray<string>
			const rows = yield* database
				.execute((db) =>
					db
						.select({
							id: vcsRepositoryBranches.id,
							name: vcsRepositoryBranches.name,
						})
						.from(vcsRepositoryBranches)
						.where(eq(vcsRepositoryBranches.repositoryId, repositoryId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const stale = rows.filter((r) => !remoteNames.has(r.name))
			yield* deleteBranchesByIds(stale.map((r) => r.id))
			return stale.map((r) => r.name) as ReadonlyArray<string>
		})

		// Delete a single branch by name (a `delete` webhook), returning whether a row
		// was actually removed so the caller can react if it was the tracked branch.
		const deleteBranch = Effect.fn("VcsRepository.deleteBranch")(function* (
			repositoryId: VcsRepositoryId,
			name: string,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select({ id: vcsRepositoryBranches.id })
						.from(vcsRepositoryBranches)
						.where(
							and(
								eq(vcsRepositoryBranches.repositoryId, repositoryId),
								eq(vcsRepositoryBranches.name, name),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const id = rows[0]?.id
			if (id === undefined) return false
			yield* deleteBranchesByIds([id])
			return true
		})

		// Remove an installation and everything beneath it (its repositories and
		// their commits). The dashboard disconnect flow uses this: severing the
		// integration must not strand the org's repos/commits in the VCS tables.
		// Idempotent — re-running drops whatever still remains.
		const purgeInstallation = Effect.fn("VcsRepository.purgeInstallation")(function* (
			orgId: OrgId,
			installationId: VcsInstallationId,
		) {
			// One atomic transaction, PARENTS FIRST: the installation, then its repos,
			// then their branches + commits (chunked under the bind-variable cap). With
			// the share-lock gates in the upserts, an in-flight sync either commits
			// before a parent delete (its rows are swept below) or writes nothing. The
			// repo-id read happens INSIDE the transaction, after the installation
			// delete, so a repo created moments earlier is swept rather than escaping.
			yield* database.execute((db) =>
				db.transaction(async (tx) => {
					await tx
						.delete(vcsInstallations)
						.where(
							and(eq(vcsInstallations.orgId, orgId), eq(vcsInstallations.id, installationId)),
						)
					const repoRows = await tx
						.select({ id: vcsRepositories.id })
						.from(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.installationId, installationId),
							),
						)
					const repoIds = repoRows.map((r) => r.id)
					await tx
						.delete(vcsRepositories)
						.where(
							and(
								eq(vcsRepositories.orgId, orgId),
								eq(vcsRepositories.installationId, installationId),
							),
						)
					for (const chunk of Arr.chunksOf(repoIds, INARRAY_CHUNK_SIZE)) {
						await tx
							.delete(vcsRepositoryBranches)
							.where(inArray(vcsRepositoryBranches.repositoryId, chunk))
					}
					for (const chunk of Arr.chunksOf(repoIds, INARRAY_CHUNK_SIZE)) {
						await tx.delete(vcsCommits).where(inArray(vcsCommits.repositoryId, chunk))
					}
				}),
			)
		}, Effect.mapError(toPersistenceError))

		return {
			resolveInstallation,
			getInstallationById,
			listInstallationsByOrg,
			listAllInstallations,
			upsertInstallation,
			markInstallationStatus,
			listRepositoriesByInstallation,
			resolveRepository,
			getRepositoryById,
			getRepositoriesByIds,
			upsertRepositories,
			markRepositoryRemoved,
			purgeRepository,
			updateRepoSyncStatus,
			markRepoSyncError,
			upsertCommits,
			findCommitBySha,
			findCommitsByShas,
			upsertBranches,
			getOrCreateBranch,
			listBranchesByRepository,
			changeTrackedBranch,
			reconcileBranchDeletions,
			deleteBranch,
			purgeInstallation,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

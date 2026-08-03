import { randomBytes } from "node:crypto"
import {
	type GithubConnectionState,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	isInstallationProcessable,
	type OrgId,
	type UserId,
	type VcsAccountType,
	type VcsInstallationId,
	type VcsRepoSelection,
	type VcsRepositoryId,
	type VcsRepoStatus,
	type VcsRepoSyncStatus,
	type VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Env } from "@/lib/Env"
import { OAuthStateRepository } from "@/services/auth/OAuthStateRepository"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { BACKFILL_WINDOW_MS } from "@/services/integrations/vcs/VcsSyncService"
import { VcsSyncQueue } from "@/services/integrations/vcs/VcsSyncQueue"
import { GithubAppClient, type GithubAppError } from "./GithubAppClient"

// ---------------------------------------------------------------------------
// The dashboard connect flow for the GitHub App. Bridges a real GitHub
// installation into a `vcs_installations` row owned by a Maple org, then hands
// off to the existing sync engine (enqueues an InstallationSyncJob).
//
// Flow: the dashboard opens the GitHub App install URL (carrying our `state`).
// After install GitHub redirects to the callback with `installation_id` and the
// `state` echoed back in the query; the callback validates `state` (→ org) and
// finishes here. Account metadata comes from the App JWT
// (`GET /app/installations/{id}`); sync later mints its own installation tokens.
//
// Security: anyone can guess an `installation_id` (it's a small number), so before
// we sync someone's private repos we prove they own it. Two checks: (1) the OAuth
// `code` must show the user can manage that installation, and (2) we never bind an
// installation that already belongs to a different org.
// ---------------------------------------------------------------------------

const GITHUB_PROVIDER = "github" as const
const GITHUB_WEB_BASE = "https://github.com"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes

// ---- Service shape --------------------------------------------------------

interface GithubBranchStatus {
	readonly name: string
	readonly isDefault: boolean
}

interface GithubRepoStatus {
	readonly id: VcsRepositoryId
	readonly fullName: string
	readonly htmlUrl: string
	readonly isPrivate: boolean
	readonly status: VcsRepoStatus
	readonly syncStatus: VcsRepoSyncStatus
	readonly lastSyncedAt: number | null
	readonly lastSyncError: string | null
	/** The single branch this repo tracks (falls back to its default branch). */
	readonly trackedBranch: string | null
	/** All branch names the user can choose to track, for the picker. */
	readonly branches: ReadonlyArray<GithubBranchStatus>
}

interface GithubConnectStatus {
	readonly connected: boolean
	readonly state: GithubConnectionState
	readonly accountLogin: string | null
	readonly accountType: VcsAccountType | null
	readonly repositorySelection: VcsRepoSelection | null
	readonly repositories: ReadonlyArray<GithubRepoStatus>
}

export interface GithubConnectServiceShape {
	/** Create a single-use state row and the GitHub install URL to open. */
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		installationId: string,
		state: string,
		/**
		 * OAuth `code` from the callback. We exchange it to confirm the user can
		 * manage `installationId`. Required to connect a new installation.
		 */
		code?: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<GithubConnectStatus, IntegrationsPersistenceError>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/**
	 * Hard-delete a single repository and all of its synced commits from Maple,
	 * addressed by Maple's own repository id (the dashboard's handle). User-initiated
	 * (the "delete from Maple" action) — distinct from a provider-side removal, which
	 * only soft-deletes. Scoped to the org, so it cannot touch another tenant's data.
	 */
	readonly deleteRepository: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
	) => Effect.Effect<
		{ readonly deleted: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
	/**
	 * Set the single branch a repo tracks. Changing it is destructive by design:
	 * the repo's stored commits (the old branch's history) are wiped and a fresh
	 * 90-day backfill of the new branch is enqueued, so the stored set always
	 * reflects exactly the current tracked branch. A no-op (same branch) neither
	 * wipes nor resyncs.
	 */
	readonly setTrackedBranch: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
		trackedBranch: string,
	) => Effect.Effect<
		{ readonly trackedBranch: string; readonly backfillQueued: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
}

// Repo / queue / state errors all carry a `message`; collapse them to the
// integration persistence error the HTTP layer speaks.
const asPersistence = <A, E extends { readonly message: string }>(
	eff: Effect.Effect<A, E>,
): Effect.Effect<A, IntegrationsPersistenceError> =>
	eff.pipe(Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })))

// A gone/missing installation is a user-actionable validation error; anything
// else from GitHub is an upstream failure.
const fromGithubError = (error: GithubAppError) =>
	error.status === 404 || error.status === 410
		? new IntegrationsValidationError({
				message:
					"GitHub installation not found — it may have been removed. Restart the connect flow.",
			})
		: new IntegrationsUpstreamError({
				message: error.message,
				...(error.status === undefined ? {} : { status: error.status }),
			})

export class GithubConnectService extends Context.Service<GithubConnectService, GithubConnectServiceShape>()(
	"@maple/api/services/vcs/vendor/github/GithubConnectService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const states = yield* OAuthStateRepository
			const repo = yield* VcsRepository
			const queue = yield* VcsSyncQueue
			const githubApp = yield* GithubAppClient

			const startConnect = Effect.fn("GithubConnectService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				const slug = Option.getOrUndefined(env.GITHUB_APP_SLUG)
				if (!slug) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.connect.outcome": "app_not_configured",
						"vcs.connect.reason": "GITHUB_APP_SLUG missing",
					})
					return yield* new IntegrationsValidationError({
						message: "GitHub App is not configured (set GITHUB_APP_SLUG)",
					})
				}
				const now = yield* Clock.currentTimeMillis
				const state = randomBytes(24).toString("base64url")
				yield* asPersistence(states.purgeExpired(now))
				yield* asPersistence(
					states.insert({
						state,
						orgId,
						provider: GITHUB_PROVIDER,
						initiatedByUserId: userId,
						redirectUri: options.callbackUrl,
						returnTo: options.returnTo ?? null,
						createdAt: new Date(now),
						expiresAt: new Date(now + STATE_TTL_MS),
					}),
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.connect.outcome": "started",
				})
				const params = new URLSearchParams({ state })
				return {
					redirectUrl: `${GITHUB_WEB_BASE}/apps/${slug}/installations/new?${params.toString()}`,
					state,
				}
			})

			const completeConnect = Effect.fn("GithubConnectService.completeConnect")(function* (
				installationId: string,
				state: string,
				code?: string,
			) {
				const now = yield* Clock.currentTimeMillis
				const stateRowOpt = yield* asPersistence(states.findByState(state))
				if (Option.isNone(stateRowOpt)) {
					yield* Effect.annotateCurrentSpan({
						"vcs.connect.outcome": "state_not_found",
						"vcs.connect.reason": "no state row for supplied secret",
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session not recognized — restart the connect flow",
					})
				}
				const stateRow = stateRowOpt.value
				// Single-use: consume immediately, before any upstream call.
				yield* asPersistence(states.deleteByState(state))
				if (stateRow.provider !== GITHUB_PROVIDER) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "provider_mismatch",
						"vcs.connect.reason": `state provider "${stateRow.provider}" != "${GITHUB_PROVIDER}"`,
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session provider mismatch — restart the connect flow",
					})
				}
				if (stateRow.expiresAt.getTime() < now) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "state_expired",
						"vcs.connect.reason": "state TTL elapsed before callback",
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session expired — restart the connect flow",
					})
				}

				// Don't let one org claim an installation another org already owns.
				// (Same org is fine — that's just reconnecting your own.)
				const existingInstallation = yield* asPersistence(
					repo.resolveInstallation(GITHUB_PROVIDER, installationId),
				)
				if (
					Option.isSome(existingInstallation) &&
					existingInstallation.value.orgId !== stateRow.orgId
				) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "installation_cross_org_rejected",
						"vcs.connect.reason": "installation_id already belongs to a different org",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This GitHub installation is already connected to another Maple organization.",
					})
				}

				// Connecting a brand-new installation? Require the OAuth `code` and check
				// the user can actually manage it. No code → reject (don't guess-and-trust).
				// Reconnecting one this org already owns is allowed without a code.
				const isSameOrgReconnect = Option.isSome(existingInstallation)
				const hasCode = code !== undefined && code.length > 0
				if (hasCode) {
					const userToken = yield* githubApp.exchangeUserOAuthCode(code).pipe(
						Effect.tapError(() =>
							Effect.annotateCurrentSpan({
								orgId: stateRow.orgId,
								"vcs.connect.outcome": "oauth_exchange_failed",
								"vcs.connect.reason": "could not exchange OAuth code for a user token",
							}),
						),
						Effect.mapError(fromGithubError),
					)
					const adminInstallationIds = yield* githubApp.listUserInstallationIds(userToken).pipe(
						Effect.tapError(() =>
							Effect.annotateCurrentSpan({
								orgId: stateRow.orgId,
								"vcs.connect.outcome": "oauth_installations_failed",
								"vcs.connect.reason": "could not list the user's installations",
							}),
						),
						Effect.mapError(fromGithubError),
					)
					if (!adminInstallationIds.has(installationId)) {
						yield* Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "installation_not_administrable",
							"vcs.connect.reason":
								"authenticated user cannot administer the supplied installation_id",
						})
						return yield* new IntegrationsValidationError({
							message:
								"You are not authorized to connect this GitHub installation — restart the connect flow.",
						})
					}
				} else if (!isSameOrgReconnect) {
					// New installation, no `code` to prove ownership — refuse. (Needs the
					// App's OAuth-on-install setting enabled; see docs/github-app-setup.md.)
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "oauth_code_required",
						"vcs.connect.reason":
							"new installation binding requires an OAuth code to prove ownership",
					})
					return yield* new IntegrationsValidationError({
						message:
							"Could not verify you own this GitHub installation. Restart the connect flow from Maple, and ensure the GitHub App has user authorization during installation enabled.",
					})
				}

				const detail = yield* githubApp.getInstallation(installationId).pipe(
					Effect.tapError((error) =>
						Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "upstream_github_error",
							"vcs.connect.reason":
								error.status === 404 || error.status === 410
									? "installation gone/missing"
									: "github upstream failure",
							...(error.status === undefined ? {} : { "vcs.github.status": error.status }),
						}),
					),
					Effect.mapError(fromGithubError),
				)
				if (!detail.account) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "upstream_github_error",
						"vcs.connect.reason": "installation has no account",
					})
					return yield* new IntegrationsValidationError({
						message: "GitHub installation has no account — restart the connect flow",
					})
				}
				const account = detail.account
				const accountType: VcsAccountType = account.type === "Organization" ? "organization" : "user"
				const repositorySelection: VcsRepoSelection =
					detail.repository_selection === "selected" ? "selected" : "all"

				yield* asPersistence(
					repo.upsertInstallation({
						orgId: stateRow.orgId as OrgId,
						provider: GITHUB_PROVIDER,
						externalInstallationId: installationId,
						accountLogin: account.login,
						accountType,
						externalAccountId: String(account.id),
						accountAvatarUrl: account.avatar_url ?? null,
						repositorySelection,
						installedByUserId: stateRow.initiatedByUserId as UserId,
					}),
				)

				yield* asPersistence(
					queue.send({
						kind: "installation-sync",
						provider: GITHUB_PROVIDER,
						externalInstallationId: installationId,
						// "updated" if this org already had the install, else "created".
						reason: isSameOrgReconnect ? "updated" : "created",
					}),
				)

				yield* Effect.annotateCurrentSpan({
					orgId: stateRow.orgId,
					"vcs.connect.outcome": "connected",
					"vcs.account.type": accountType,
					"vcs.repository.selection": repositorySelection,
				})
				return { orgId: stateRow.orgId as OrgId, returnTo: stateRow.returnTo ?? null }
			})

			// Resolve an installation's repositories into the dashboard summary shape
			// (one branch query per repo — fine at current scale, tens of repos). "all"
			// scope: surface provider-removed repos too, with their dashboard affordances.
			const repositoriesOf = Effect.fn("GithubConnectService.repositoriesOf")(function* (installation: {
				readonly id: VcsInstallationId
			}) {
				const repos = yield* asPersistence(
					repo.listRepositoriesByInstallation(installation.id, "all"),
				)
				return yield* Effect.forEach(repos, (r) =>
					Effect.gen(function* () {
						const branches = yield* asPersistence(repo.listBranchesByRepository(r.id))
						return {
							id: r.id,
							fullName: r.fullName,
							htmlUrl: r.htmlUrl,
							isPrivate: r.isPrivate,
							status: r.status,
							syncStatus: r.syncStatus,
							lastSyncedAt: r.lastSyncedAt,
							lastSyncError: r.lastSyncError,
							// Fall back to the default for a legacy row whose tracked branch
							// was never set, mirroring the sync engine's resolution.
							trackedBranch: r.trackedBranch ?? r.defaultBranch,
							branches: branches.map((b) => ({
								name: b.name,
								isDefault: b.isDefault,
							})),
						}
					}),
				)
			})

			const getStatus = Effect.fn("GithubConnectService.getStatus")(function* (orgId: OrgId) {
				const installations = (yield* asPersistence(repo.listInstallationsByOrg(orgId))).filter(
					(i) => i.provider === GITHUB_PROVIDER,
				)
				const active = installations.find((i) => i.status === "active")
				if (active) {
					const repositories = yield* repositoriesOf(active)
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.status.outcome": "ok",
						"vcs.status.state": "connected",
						"vcs.status.connected": true,
						"vcs.account.type": active.accountType,
						"vcs.repository.selection": active.repositorySelection,
						"vcs.repository.count": repositories.length,
					})
					return {
						connected: true,
						state: "connected",
						accountLogin: active.accountLogin,
						accountType: active.accountType,
						repositorySelection: active.repositorySelection,
						repositories,
					} satisfies GithubConnectStatus
				}

				// No active installation. Rather than reverting to the pristine "never
				// connected" screen (which makes a deactivated integration look deleted),
				// surface the most-recently-touched deactivated row so the dashboard can
				// explain it was uninstalled/suspended on GitHub and offer a reconnect.
				// Installation rows are never auto-deleted, so one is here whenever the org
				// has connected before. Its repos/commits are kept too — shown read-only.
				const deactivated = [...installations].sort((a, b) => b.updatedAt - a.updatedAt)[0]
				if (!deactivated) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.status.outcome": "ok",
						"vcs.status.state": "not_connected",
						"vcs.status.connected": false,
					})
					return {
						connected: false,
						state: "not_connected",
						accountLogin: null,
						accountType: null,
						repositorySelection: null,
						repositories: [],
					} satisfies GithubConnectStatus
				}

				const state = deactivated.status === "suspended" ? "suspended" : "disconnected"
				const repositories = yield* repositoriesOf(deactivated)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.status.outcome": "ok",
					"vcs.status.state": state,
					"vcs.status.connected": false,
					"vcs.installation.status": deactivated.status,
					"vcs.account.type": deactivated.accountType,
					"vcs.repository.count": repositories.length,
				})
				return {
					connected: false,
					state,
					accountLogin: deactivated.accountLogin,
					accountType: deactivated.accountType,
					repositorySelection: deactivated.repositorySelection,
					repositories,
				} satisfies GithubConnectStatus
			})

			const disconnect = Effect.fn("GithubConnectService.disconnect")(function* (orgId: OrgId) {
				const installations = yield* asPersistence(repo.listInstallationsByOrg(orgId))
				const targets = installations.filter((i) => i.provider === GITHUB_PROVIDER)
				// Fully remove each installation and its repos/commits — a disconnect
				// must not strand the org's VCS data. Deleting the row (rather than only
				// flipping its status to "disconnected") also lets a later reconnect
				// re-sync cleanly: upsertInstallation never resets status on conflict, so
				// a lingering "disconnected" row would gate the reconnected installation
				// out of the sync engine.
				yield* Effect.forEach(targets, (i) => asPersistence(repo.purgeInstallation(orgId, i.id)), {
					discard: true,
				})
				const disconnected = targets.length > 0
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.disconnect.outcome": disconnected ? "disconnected" : "nothing_to_disconnect",
					"vcs.disconnect.installation_count": targets.length,
				})
				return { disconnected }
			})

			const deleteRepository = Effect.fn("GithubConnectService.deleteRepository")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
			) {
				// Deletion is only for repos whose provider access was already removed
				// (the dashboard shows the button only on those). Enforce it server-side
				// too: purging an *active* repo is both wrong (active repos are managed
				// via GitHub access, not deleted) and futile — the next installation-sync
				// re-adds and re-backfills it. The lookup is org-scoped, so an id from
				// another tenant reads as absent and an absent repo is treated as
				// already-deleted (idempotent).
				const existing = yield* asPersistence(repo.getRepositoryById(orgId, repositoryId))
				if (Option.isNone(existing)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.delete_repository.outcome": "not_found",
						"vcs.delete_repository.reason": "absent for org — treated as idempotent delete",
					})
					return { deleted: false }
				}
				if (existing.value.status !== "removed") {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.delete_repository.outcome": "still_active_rejected",
						"vcs.delete_repository.reason": `repo status "${existing.value.status}" != "removed"`,
					})
					return yield* new IntegrationsValidationError({
						message:
							"This repository is still active. Remove its access in GitHub first — only repositories whose access was removed can be deleted from Maple.",
					})
				}
				const deleted = yield* asPersistence(repo.purgeRepository(orgId, repositoryId))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.delete_repository.outcome": "deleted",
				})
				return { deleted }
			})

			const setTrackedBranch = Effect.fn("GithubConnectService.setTrackedBranch")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
				trackedBranch: string,
			) {
				const existing = yield* asPersistence(repo.getRepositoryById(orgId, repositoryId))
				if (Option.isNone(existing)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "repository_not_found",
						"vcs.set_tracked_branch.reason": "absent for org",
					})
					return yield* new IntegrationsValidationError({ message: "Repository not found" })
				}
				const repository = existing.value

				const installationOpt = yield* asPersistence(
					repo.getInstallationById(orgId, repository.installationId),
				)
				// Check the installation exists BEFORE wiping commits. If it's gone we
				// can't re-sync the new branch, so we'd leave the repo empty — reject instead.
				if (Option.isNone(installationOpt)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "installation_missing",
						"vcs.set_tracked_branch.reason":
							"installation row absent — refusing destructive branch change",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This repository's GitHub installation is no longer connected. Reconnect GitHub before changing the tracked branch.",
					})
				}
				const installation = installationOpt.value
				if (!isInstallationProcessable(installation)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "installation_suspended",
						"vcs.set_tracked_branch.reason": "installation not processable (suspended)",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This integration is suspended. Reactivate it on GitHub before changing the tracked branch.",
					})
				}

				// The chosen branch must be one the repo actually knows about (the picker's
				// list), so we don't point the tracker at a non-existent ref.
				const branches = yield* asPersistence(repo.listBranchesByRepository(repositoryId))
				if (!branches.some((b) => b.name === trackedBranch)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "unknown_branch",
						"vcs.set_tracked_branch.reason":
							"requested branch not in repository's known branches",
					})
					return yield* new IntegrationsValidationError({
						message: `Branch "${trackedBranch}" is not a known branch of this repository.`,
					})
				}

				const current = repository.trackedBranch ?? repository.defaultBranch
				// No-op when unchanged: don't wipe + resync for a redundant selection.
				if (trackedBranch === current) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "unchanged_noop",
						"vcs.set_tracked_branch.reason": "requested branch equals current tracked branch",
						"vcs.branches.tracked": trackedBranch,
						"vcs.branches.changed": false,
					})
					return { trackedBranch, backfillQueued: false }
				}

				// Change is destructive: point the tracker at the new branch AND wipe the
				// repo's stored (old-branch) commits, then backfill the new branch so the
				// stored set reflects exactly the current tracked branch.
				yield* asPersistence(repo.changeTrackedBranch(orgId, repositoryId, trackedBranch))

				const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
				yield* asPersistence(
					queue.send({
						kind: "sync-commits",
						provider: GITHUB_PROVIDER,
						externalInstallationId: installation.externalInstallationId,
						externalRepoId: repository.externalRepoId,
						owner: repository.owner,
						name: repository.name,
						branch: trackedBranch,
						sinceMs,
					} satisfies VcsSyncJob),
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.set_tracked_branch.outcome": "changed",
					"vcs.set_tracked_branch.reason": "branch changed; backfill enqueued",
					"vcs.set_tracked_branch.installation_missing": false,
					"vcs.branches.tracked": trackedBranch,
					"vcs.branches.changed": true,
					"vcs.branches.backfill_queued": true,
				})
				return { trackedBranch, backfillQueued: true }
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				disconnect,
				deleteRepository,
				setTrackedBranch,
			} satisfies GithubConnectServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

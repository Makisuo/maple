import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	isInstallationProcessable,
	type OrgId,
	type PullRequestSummary,
	type VcsInstallation,
	type VcsRepo,
} from "@maple/domain/http"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import type { VcsCodeSearchMatch, VcsSourceFile } from "./VcsProviderClient"

export class VcsSourceRepositoryNotFoundError extends Schema.TaggedError<VcsSourceRepositoryNotFoundError>()(
	"@maple/api/vcs/VcsSourceRepositoryNotFoundError",
	{ repository: Schema.String, message: Schema.String },
) {}

export class VcsSourceFileNotFoundError extends Schema.TaggedError<VcsSourceFileNotFoundError>()(
	"@maple/api/vcs/VcsSourceFileNotFoundError",
	{ repository: Schema.String, path: Schema.String, ref: Schema.String, message: Schema.String },
) {}

/**
 * Everything that can go wrong resolving *which* repository to talk to, before
 * a path is involved. Split out from `VcsSourceError` so the pull-request reads
 * do not advertise a file-not-found failure they cannot raise — a caller that
 * had to catch a dead tag to satisfy the compiler would be handling a case that
 * never happens.
 */
type VcsRepositoryScopedError =
	| IntegrationsNotConnectedError
	| IntegrationsPersistenceError
	| IntegrationsUpstreamError
	| VcsSourceRepositoryNotFoundError

type VcsSourceError = VcsRepositoryScopedError | VcsSourceFileNotFoundError

export interface ConnectedSourceRepository {
	readonly provider: VcsRepo["provider"]
	readonly fullName: string
	readonly defaultBranch: string
	readonly trackedBranch: string
	readonly htmlUrl: string
	readonly isPrivate: boolean
	readonly isArchived: boolean
}

export interface VcsSourceServiceApi {
	readonly listRepositories: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<ConnectedSourceRepository>, VcsRepositoryScopedError>
	/** Recent pull requests in one connected repository — the attach-a-PR picker's options. */
	readonly listPullRequests: (
		orgId: OrgId,
		repository: string,
		opts: { readonly limit: number },
	) => Effect.Effect<ReadonlyArray<PullRequestSummary>, VcsRepositoryScopedError>
	/**
	 * One pull request by number. `Option.none` covers both "no such PR" and — via
	 * the caller catching `VcsSourceRepositoryNotFoundError` — a repo this org has
	 * never connected, which is a routine case for a pasted link.
	 */
	readonly fetchPullRequest: (
		orgId: OrgId,
		repository: string,
		number: number,
	) => Effect.Effect<Option.Option<PullRequestSummary>, VcsRepositoryScopedError>
	readonly searchCode: (
		orgId: OrgId,
		repository: string,
		query: string,
		opts: { readonly path?: string; readonly limit: number },
	) => Effect.Effect<ReadonlyArray<VcsCodeSearchMatch>, VcsRepositoryScopedError>
	readonly readFile: (
		orgId: OrgId,
		repository: string,
		path: string,
		ref?: string,
	) => Effect.Effect<VcsSourceFile & { readonly ref: string }, VcsSourceError>
}

const asPersistence = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })))

const asUpstream = <A, E extends { readonly message: string; readonly status?: number }>(
	effect: Effect.Effect<A, E>,
) =>
	effect.pipe(
		Effect.mapError(
			(error) =>
				new IntegrationsUpstreamError({
					message: error.message,
					...(!(error.status === undefined) ? { status: error.status } : undefined),
				}),
		),
	)

export class VcsSourceService extends Context.Service<VcsSourceService, VcsSourceServiceApi>()(
	"@maple/api/services/vcs/VcsSourceService",
	{
		make: Effect.gen(function* () {
			const repoStore = yield* VcsRepository
			const providers = yield* VcsProviderRegistry

			const activeInstallations = Effect.fn("VcsSourceService.activeInstallations")(function* (
				orgId: OrgId,
			) {
				const installations = (yield* asPersistence(repoStore.listInstallationsByOrg(orgId))).filter(
					isInstallationProcessable,
				)
				if (installations.length === 0) {
					return yield* new IntegrationsNotConnectedError({
						message: "No source repository integration is connected for this organization.",
					})
				}
				return installations
			})

			const repositoriesFor = Effect.fn("VcsSourceService.repositoriesFor")(function* (
				installations: ReadonlyArray<VcsInstallation>,
			) {
				return yield* Effect.forEach(installations, (installation) =>
					asPersistence(repoStore.listRepositoriesByInstallation(installation.id, "active")).pipe(
						Effect.map((repositories) =>
							repositories.map((repository) => ({ installation, repository })),
						),
					),
				).pipe(Effect.map((groups) => groups.flat()))
			})

			const resolveRepository = Effect.fn("VcsSourceService.resolveRepository")(function* (
				orgId: OrgId,
				fullName: string,
			) {
				const installations = yield* activeInstallations(orgId)
				const entries = yield* repositoriesFor(installations)
				const found = entries.find(
					(entry) => entry.repository.fullName.toLowerCase() === fullName.toLowerCase(),
				)
				if (!found) {
					return yield* new VcsSourceRepositoryNotFoundError({
						repository: fullName,
						message: `Repository '${fullName}' is not connected to this Maple organization. Call list_source_repositories to see the available repositories.`,
					})
				}
				return found
			})

			const listRepositories = Effect.fn("VcsSourceService.listRepositories")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const entries = yield* repositoriesFor(yield* activeInstallations(orgId))
				return entries
					.map(({ repository }) => ({
						provider: repository.provider,
						fullName: repository.fullName,
						defaultBranch: repository.defaultBranch,
						trackedBranch: repository.trackedBranch ?? repository.defaultBranch,
						htmlUrl: repository.htmlUrl,
						isPrivate: repository.isPrivate,
						isArchived: repository.isArchived,
					}))
					.sort((a, b) => a.fullName.localeCompare(b.fullName))
			})

			const listPullRequests: VcsSourceServiceApi["listPullRequests"] = Effect.fn(
				"VcsSourceService.listPullRequests",
			)(function* (orgId, repositoryName, opts) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.full_name": repositoryName,
				})
				const { installation, repository } = yield* resolveRepository(orgId, repositoryName)
				const provider = yield* asUpstream(providers.resolve(repository.provider))
				const pullRequests = yield* asUpstream(
					provider.fetchPullRequests(
						installation,
						{
							externalRepoId: repository.externalRepoId,
							owner: repository.owner,
							name: repository.name,
						},
						opts,
					),
				)
				yield* Effect.annotateCurrentSpan({ "result.rowCount": pullRequests.length })
				return pullRequests
			})

			const fetchPullRequest: VcsSourceServiceApi["fetchPullRequest"] = Effect.fn(
				"VcsSourceService.fetchPullRequest",
			)(function* (orgId, repositoryName, number) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.full_name": repositoryName,
					"vcs.pull_request.number": number,
				})
				const { installation, repository } = yield* resolveRepository(orgId, repositoryName)
				const provider = yield* asUpstream(providers.resolve(repository.provider))
				return yield* asUpstream(
					provider.fetchPullRequest(
						installation,
						{
							externalRepoId: repository.externalRepoId,
							owner: repository.owner,
							name: repository.name,
						},
						number,
					),
				)
			})

			const searchCode: VcsSourceServiceApi["searchCode"] = Effect.fn("VcsSourceService.searchCode")(
				function* (orgId, repositoryName, query, opts) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.full_name": repositoryName,
						"vcs.source.query_length": query.length,
					})
					const { installation, repository } = yield* resolveRepository(orgId, repositoryName)
					const provider = yield* asUpstream(providers.resolve(repository.provider))
					return yield* asUpstream(
						provider.searchCode(
							installation,
							{
								externalRepoId: repository.externalRepoId,
								owner: repository.owner,
								name: repository.name,
							},
							query,
							opts,
						),
					)
				},
			)

			const readFile: VcsSourceServiceApi["readFile"] = Effect.fn("VcsSourceService.readFile")(
				function* (orgId, repositoryName, path, requestedRef) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.full_name": repositoryName,
						"vcs.source.path": path,
					})
					const { installation, repository } = yield* resolveRepository(orgId, repositoryName)
					const ref = requestedRef ?? repository.trackedBranch ?? repository.defaultBranch
					const provider = yield* asUpstream(providers.resolve(repository.provider))
					const file = yield* asUpstream(
						provider.fetchSourceFile(
							installation,
							{
								externalRepoId: repository.externalRepoId,
								owner: repository.owner,
								name: repository.name,
							},
							path,
							ref,
						),
					)
					if (Option.isNone(file)) {
						return yield* new VcsSourceFileNotFoundError({
							repository: repository.fullName,
							path,
							ref,
							message: `No file '${path}' exists in '${repository.fullName}' at ref '${ref}'.`,
						})
					}
					return { ...file.value, ref }
				},
			)

			return {
				listRepositories,
				listPullRequests,
				fetchPullRequest,
				searchCode,
				readFile,
			} satisfies VcsSourceServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

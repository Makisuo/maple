import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	isInstallationProcessable,
	type OrgId,
	type VcsInstallation,
	type VcsRepo,
} from "@maple/domain/http"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import type { VcsCodeSearchMatch, VcsSourceFile } from "./VcsProviderClient"

export class VcsSourceRepositoryNotFoundError extends Schema.TaggedErrorClass<VcsSourceRepositoryNotFoundError>()(
	"@maple/api/vcs/VcsSourceRepositoryNotFoundError",
	{ repository: Schema.String, message: Schema.String },
) {}

export class VcsSourceFileNotFoundError extends Schema.TaggedErrorClass<VcsSourceFileNotFoundError>()(
	"@maple/api/vcs/VcsSourceFileNotFoundError",
	{ repository: Schema.String, path: Schema.String, ref: Schema.String, message: Schema.String },
) {}

type VcsSourceError =
	| IntegrationsNotConnectedError
	| IntegrationsPersistenceError
	| IntegrationsUpstreamError
	| VcsSourceRepositoryNotFoundError
	| VcsSourceFileNotFoundError

export interface ConnectedSourceRepository {
	readonly provider: VcsRepo["provider"]
	readonly fullName: string
	readonly defaultBranch: string
	readonly trackedBranch: string
	readonly htmlUrl: string
	readonly isPrivate: boolean
	readonly isArchived: boolean
}

export interface VcsSourceServiceShape {
	readonly listRepositories: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<ConnectedSourceRepository>, VcsSourceError>
	readonly searchCode: (
		orgId: OrgId,
		repository: string,
		query: string,
		opts: { readonly path?: string; readonly limit: number },
	) => Effect.Effect<ReadonlyArray<VcsCodeSearchMatch>, VcsSourceError>
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
					...(error.status === undefined ? {} : { status: error.status }),
				}),
		),
	)

export class VcsSourceService extends Context.Service<VcsSourceService, VcsSourceServiceShape>()(
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
				yield* Effect.annotateCurrentSpan({ "maple.org_id": orgId })
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

			const searchCode: VcsSourceServiceShape["searchCode"] = Effect.fn("VcsSourceService.searchCode")(
				function* (orgId, repositoryName, query, opts) {
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": orgId,
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

			const readFile: VcsSourceServiceShape["readFile"] = Effect.fn("VcsSourceService.readFile")(
				function* (orgId, repositoryName, path, requestedRef) {
					yield* Effect.annotateCurrentSpan({
						"maple.org_id": orgId,
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

			return { listRepositories, searchCode, readFile } satisfies VcsSourceServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

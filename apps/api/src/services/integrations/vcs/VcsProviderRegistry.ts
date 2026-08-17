import { UnknownVcsProviderError } from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { GithubProvider } from "./vendor/github/GithubProvider"
import type { VcsProviderClient } from "./VcsProviderClient"

// Resolves a provider id → its `VcsProviderClient` implementation. This is the
// ONLY module that names a concrete provider. Adding a provider = implement the
// port + add one entry here; the generic orchestrator/webhook never change.

export interface VcsProviderRegistryApi {
	/** The ids of every registered provider (e.g. for static webhook routes). */
	readonly ids: ReadonlyArray<string>
	readonly resolve: (provider: string) => Effect.Effect<VcsProviderClient, UnknownVcsProviderError>
}

export class VcsProviderRegistry extends Context.Service<VcsProviderRegistry, VcsProviderRegistryApi>()(
	"@maple/api/services/vcs/VcsProviderRegistry",
	{
		make: Effect.gen(function* () {
			const github = yield* GithubProvider
			const byId: Record<string, VcsProviderClient> = { [github.id]: github } satisfies Record<
				string,
				VcsProviderClient
			>

			const resolve = (provider: string) => {
				const impl = byId[provider]
				return impl
					? Effect.succeed(impl)
					: Effect.fail(
							new UnknownVcsProviderError({
								provider,
								message: `Unknown VCS provider: ${provider}`,
							}),
						)
			}

			return { ids: Object.keys(byId), resolve } satisfies VcsProviderRegistryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

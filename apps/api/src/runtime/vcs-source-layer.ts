import { Layer } from "effect"
import { VcsProviderRegistry } from "@/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { VcsSourceService } from "@/services/integrations/vcs/VcsSourceService"
import { GithubAppClient } from "@/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubHttp } from "@/services/integrations/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/integrations/vcs/vendor/github/GithubProvider"

/**
 * The whole provider stack behind `VcsSourceService`, composed once.
 *
 * A composition root, which is what makes it the one place allowed to name a
 * vendor module — every other consumer takes this layer and stays provider-
 * agnostic. It exists because the errors side needs a source service in workers
 * that otherwise have no VCS wiring at all (the alerting worker), and rebuilding
 * the Github → provider → registry chain at each of those call sites would put
 * vendor imports in places the boundary lint rightly refuses.
 *
 * Requires `Env` and `Database` from the caller's own base layer.
 */
export const VcsSourceServiceLayer = VcsSourceService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			VcsRepository.layer,
			VcsProviderRegistry.layer.pipe(
				Layer.provide(
					GithubProvider.layer.pipe(
						Layer.provide(GithubAppClient.layer.pipe(Layer.provide(GithubHttp.layer))),
					),
				),
			),
		),
	),
)

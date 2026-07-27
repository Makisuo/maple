import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Layer } from "effect"
import { layerPg } from "./lib/DatabasePgLive"
import { Env } from "./lib/Env"
import { ApiKeysService } from "./services/ApiKeysService"
import { OAuthStateRepository } from "./services/OAuthStateRepository"
import { SlackIntegrationService } from "./services/SlackIntegrationService"

// ---------------------------------------------------------------------------
// Slack workspace reconciliation's cron layer graph — mirrors
// vcs-sync-runtime.ts's `buildScrapeRetentionLayer`, its own light graph
// (NOT the fetch path's MainLive) so the tick stays within the startup CPU
// budget. `SlackIntegrationService` needs `ApiKeysService` (to revoke the
// minted bot key) and `OAuthStateRepository` (unused by this tick, but a
// dependency of `SlackIntegrationService.make` regardless) on top of
// Database + Env; its own `static readonly layer` already provides the
// FetchHttpClient it needs to call Slack's `auth.test`.
//
// Backstop for SlackEventsRouter's app_uninstalled/tokens_revoked webhook:
// catches deliveries Slack retried and gave up on, and installs that predate
// the webhook.
// ---------------------------------------------------------------------------

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

export const buildSlackReconcileLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const ApiKeysServiceLive = ApiKeysService.layer.pipe(Layer.provide(Base))
	const OAuthStateRepositoryLive = OAuthStateRepository.layer.pipe(Layer.provide(Base))
	const SlackIntegrationServiceLive = SlackIntegrationService.layer.pipe(
		Layer.provide(Layer.mergeAll(Base, ApiKeysServiceLive, OAuthStateRepositoryLive)),
	)

	return SlackIntegrationServiceLive.pipe(Layer.provideMerge(telemetry.layer), Layer.provideMerge(ConfigLive))
}

export const flushSlackTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

/** The cron program: probe every active Slack workspace, revoke locally any Slack confirms are dead. */
export const runSlackReconciliation = Effect.gen(function* () {
	const slack = yield* SlackIntegrationService
	const result = yield* slack.reconcileWorkspaces()
	yield* Effect.logInfo("[Slack] reconciliation tick complete").pipe(
		Effect.annotateLogs({ probed: result.probed, revoked: result.revoked }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.logError("[Slack] reconciliation tick failed").pipe(Effect.annotateLogs({ error: String(cause) })),
	),
	Effect.withSpan("SlackReconciliation.tick"),
)

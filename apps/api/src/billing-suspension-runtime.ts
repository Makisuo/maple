import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer } from "effect"
import { layerPg } from "./lib/DatabasePgLive"
import { Env } from "./lib/Env"
import { BillingSuspensionService } from "./services/BillingSuspensionService"

// ---------------------------------------------------------------------------
// Per-invocation runtime for the daily billing-suspension reconcile cron.
// Mirrors `vcs-sync-runtime.ts`: its own light layer graph (NOT the fetch
// path's MainLive) so the cron invocation stays within the startup CPU budget.
// ---------------------------------------------------------------------------

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
})

export const buildBillingSuspensionLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const ServiceLive = BillingSuspensionService.layer.pipe(Layer.provide(Base))

	return ServiceLive.pipe(Layer.provideMerge(telemetry.layer), Layer.provideMerge(ConfigLive))
}

export const flushBillingTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

// The cron program: scan the overdue set, promote/clear per the policy.
export const runBillingSuspensionReconcile = Effect.gen(function* () {
	const service = yield* BillingSuspensionService
	const result = yield* service.runReconcile()
	yield* Effect.annotateCurrentSpan({
		"billing.reconcile.scanned": result.scanned,
		"billing.reconcile.suspended": result.suspended,
		"billing.reconcile.cleared": result.cleared,
		"billing.reconcile.outcome": "completed",
	})
	yield* Effect.logInfo("[billing] suspension reconcile tick complete").pipe(
		Effect.annotateLogs({
			scanned: result.scanned,
			suspended: result.suspended,
			cleared: result.cleared,
		}),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "billing.reconcile.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[billing] suspension reconcile tick failed").pipe(
					Effect.annotateLogs({ error: Cause.pretty(cause) }),
				),
			),
		),
	),
	Effect.withSpan("BillingSuspensionReconcile.tick"),
)

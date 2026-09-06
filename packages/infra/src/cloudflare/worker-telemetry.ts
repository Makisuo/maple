/**
 * Maple's own Workers' telemetry as alchemy vendor sugar — the Maple SDK's
 * counterpart of `Axiom.Telemetry(...)`. Provide it on a class-form Worker's
 * init Effect and the bridge builds the SDK's Tracer + Logger into every
 * event's request scope, so the bridge's own `HttpMiddleware.tracer` records
 * the server span with it; a scope finalizer drains the SDK's buffers once the
 * scope closes into `ctx.waitUntil`, after the response.
 *
 * Only for Workers alchemy bundles (`Cloudflare.Worker<Self>()(…)`) — the
 * alchemy import is fine there and nowhere else, see `worker-env.ts`.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import * as Telemetry from "alchemy/Telemetry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { WorkerEnvironment } from "./worker-env.ts"

export const MAPLE_REPOSITORY_URL = "https://github.com/MapleTechLabs/maple"

export interface WorkerTelemetryOptions {
	readonly serviceName: string
	/** Added to the domain's `ANTICIPATED_ERROR_IDENTIFIERS` (e.g. the MCP set). */
	readonly anticipatedErrorIdentifiers?: ReadonlyArray<string> | undefined
	/** Span-name prefixes never exported. */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
}

/** The SDK as every Maple Worker configures it: `core` namespace, repo URL, anticipated 4xx. */
export const workerTelemetrySdk = (options: WorkerTelemetryOptions): MapleCloudflareSDK.Telemetry =>
	MapleCloudflareSDK.make({
		serviceName: options.serviceName,
		serviceNamespace: "core",
		repositoryUrl: MAPLE_REPOSITORY_URL,
		dropSpanNames: options.dropSpanNames,
		anticipatedErrorIdentifiers: [
			...ANTICIPATED_ERROR_IDENTIFIERS,
			...(options.anticipatedErrorIdentifiers ?? []),
		],
	})

/**
 * The per-event layer: the SDK's exporters plus a flush when the event's scope
 * closes. `flush` yields a macrotask itself, so the tracer's deferred
 * `span.end` lands before the drain.
 */
export const requestTelemetryLayer = (
	telemetry: MapleCloudflareSDK.Telemetry,
): Layer.Layer<never, never, WorkerEnvironment> =>
	Layer.mergeAll(
		telemetry.layer,
		Layer.effectDiscard(
			Effect.gen(function* () {
				const env = yield* WorkerEnvironment
				yield* Effect.addFinalizer(() => Effect.promise(() => telemetry.flush(env)))
			}),
		),
	)

export const WorkerTelemetry = (options: WorkerTelemetryOptions): Layer.Layer<never> =>
	Telemetry.layer(requestTelemetryLayer(workerTelemetrySdk(options)))

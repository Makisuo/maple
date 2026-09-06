/**
 * Maple's own Workers' telemetry: `@maple-dev/alchemy`'s `Maple.Telemetry` with
 * the defaults every Maple Worker shares. Provide it on a class-form Worker's
 * init Effect; the bridge builds the SDK into every event's request scope and
 * flushes it after the response. The ingest key, endpoint and environment are
 * not bound here — `selfObservabilityEnv(stage)` puts them in the Worker's env
 * from the stage, with the PR-preview rules, and the SDK reads them there.
 *
 * Only for Workers alchemy bundles (`Cloudflare.Worker<Self>()(…)`) — the
 * alchemy import is fine there and nowhere else, see `worker-env.ts`.
 */
import { Telemetry, type TelemetrySdkOptions } from "@maple-dev/alchemy/telemetry"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import type * as Layer from "effect/Layer"

export const MAPLE_REPOSITORY_URL = "https://github.com/MapleTechLabs/maple"

export interface WorkerTelemetryOptions {
	readonly serviceName: string
	/** Added to the domain's `ANTICIPATED_ERROR_IDENTIFIERS` (e.g. the MCP set). */
	readonly anticipatedErrorIdentifiers?: ReadonlyArray<string> | undefined
	/** Span-name prefixes never exported. */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
}

/** The SDK options every Maple Worker uses: `core` namespace, repo URL, anticipated 4xx. */
export const workerTelemetryConfig = (options: WorkerTelemetryOptions): TelemetrySdkOptions => ({
	serviceName: options.serviceName,
	serviceNamespace: "core",
	repositoryUrl: MAPLE_REPOSITORY_URL,
	dropSpanNames: options.dropSpanNames,
	anticipatedErrorIdentifiers: [
		...ANTICIPATED_ERROR_IDENTIFIERS,
		...(options.anticipatedErrorIdentifiers ?? []),
	],
})

export const WorkerTelemetry = (options: WorkerTelemetryOptions): Layer.Layer<never> =>
	Telemetry(workerTelemetryConfig(options))

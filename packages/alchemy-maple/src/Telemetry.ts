/**
 * Export a Cloudflare Worker's telemetry to Maple — the Maple SDK as alchemy
 * vendor sugar, the way `Axiom.Telemetry` wraps alchemy's built-in exporter.
 *
 * Compose it into the Worker's init `Effect.provide`. At deploy time it binds
 * the ingest key (as a secret), endpoint and environment onto the host; at
 * runtime the Worker bridge builds the SDK's Tracer + Logger into every event's
 * request scope — its own HTTP tracer records the server span with them — and
 * the SDK flushes when that scope closes, after the response.
 *
 * ```typescript
 * import * as Maple from "@maple-dev/alchemy/telemetry"
 * import { Ingest } from "./maple.ts" // yield* Maple.IngestKeys("ingest")
 *
 * export default Cloudflare.Worker(
 *   "api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // ...
 *   }).pipe(Effect.provide(Maple.Telemetry({ serviceName: "api", ingestKey: Ingest }))),
 * )
 * ```
 *
 * Omit `ingestKey` when the host's env already carries `MAPLE_INGEST_KEY`.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import * as Output from "alchemy/Output"
import { CurrentRuntimeContext } from "alchemy/RuntimeContext"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { IngestKeys } from "./IngestKeys"

// Alchemy's bundler folds this to `true` in a deployed bundle. Alchemy declares
// it in a module this file does not import, so the declaration is repeated
// here with the identical type.
declare global {
	var __ALCHEMY_RUNTIME__: boolean | undefined
}

/**
 * A resource passed to the layer: the module-scope declaration (an Effect that
 * resolves to the instance) or an already-yielded instance.
 */
export type ResourceInput<T> = T | Effect.Effect<T, never, unknown>

/** The SDK options the layer forwards unchanged; the bound ones are declared on {@link TelemetryProps}. */
export type TelemetrySdkOptions = Omit<MapleCloudflareSDK.Config, "ingestKey" | "endpoint" | "environment">

export interface TelemetryProps extends TelemetrySdkOptions {
	/**
	 * Bound onto the host as the `MAPLE_INGEST_KEY` secret: the org's
	 * {@link IngestKeys} resource (its private key is used), or a key in hand.
	 */
	readonly ingestKey?:
		| ResourceInput<IngestKeys>
		| Redacted.Redacted<string>
		| Output.Output<Redacted.Redacted<string>>
		| undefined
	/** Bound as `MAPLE_ENDPOINT`. Default: the SDK's, `https://ingest.maple.dev`. */
	readonly endpoint?: string | Output.Output<string> | undefined
	/** Bound as `MAPLE_ENVIRONMENT` (`deployment.environment.name`). */
	readonly environment?: string | Output.Output<string> | undefined
}

const ingestKeyOutput = (
	ingestKey: NonNullable<TelemetryProps["ingestKey"]>,
): Effect.Effect<Output.Output<Redacted.Redacted<string>>, never, unknown> =>
	Effect.gen(function* () {
		if (Output.isOutput(ingestKey) || Redacted.isRedacted(ingestKey)) return Output.asOutput(ingestKey)
		// Declarations are yielded to instances (registering them on the Stack
		// if this host is the first to reference them), so the attribute
		// accessor below is a real Output.
		const keys = Effect.isEffect(ingestKey) ? yield* ingestKey : ingestKey
		return Output.asOutput(keys.privateKey)
	})

export const Telemetry = (props: TelemetryProps): Layer.Layer<never> => {
	const { ingestKey, endpoint, environment, ...config } = props
	const telemetry = MapleCloudflareSDK.make(config)
	const bind = Layer.effectDiscard(
		Effect.gen(function* () {
			const rc = yield* CurrentRuntimeContext
			// Plan-time only: in the deployed bundle the bound values are already
			// in the env, and the SDK reads them from there.
			if (rc === undefined || globalThis.__ALCHEMY_RUNTIME__) return
			if (ingestKey !== undefined) yield* rc.set("MAPLE_INGEST_KEY", yield* ingestKeyOutput(ingestKey))
			if (endpoint !== undefined) yield* rc.set("MAPLE_ENDPOINT", Output.asOutput(endpoint))
			if (environment !== undefined) yield* rc.set("MAPLE_ENVIRONMENT", Output.asOutput(environment))
		}),
	)
	// SAFETY: the only requirement is the resource declaration's provider set,
	// which the Stack supplies to the init Effect at plan time — the same shape
	// alchemy's own `Axiom.Telemetry` returns.
	return Layer.mergeAll(bind, AlchemyTelemetry.layer(telemetry.requestLayer)) as Layer.Layer<never>
}

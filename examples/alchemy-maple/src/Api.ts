/**
 * The Worker, in Alchemy's Effect-native style: one class that is both the
 * resource declaration and the runtime entrypoint (`main: import.meta.filename`).
 *
 * The seam worth looking at is `env` — a `Redacted` output from the Maple
 * provider is a first-class Worker binding, so the credentials the workload
 * needs and the resources that watch it are declared in the same graph.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import * as Maple from "@maple-dev/alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

/**
 * One source of truth for the service name: the SDK reports it as
 * `service.name`, and the alert rules in `alchemy.run.ts` filter on it. If the
 * two drift, the alerts watch a service that never reports.
 */
export const SERVICE_NAME = "checkout"

/** The org's ingest keys — declared once, bound into the Worker below. */
export const IngestKeys = Maple.IngestKeys("ingest")

/**
 * Telemetry is built at module scope: `layer` is stable for the isolate's
 * lifetime, and `flush(env)` resolves its config lazily on the first call. The
 * endpoint defaults to https://ingest.maple.dev — set `MAPLE_ENDPOINT` in `env`
 * below to point a self-hosted deployment somewhere else.
 */
const telemetry = MapleCloudflareSDK.make({
	serviceName: SERVICE_NAME,
	serviceNamespace: "backend",
})

export default class Api extends Cloudflare.Worker<Api>()(
	"checkout-api",
	{
		main: import.meta.filename,
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		workersDev: true,
		env: {
			// Alchemy resolves the resource, ships the value as a Worker secret, and
			// orders the deploy behind it — it stays `Redacted` in the plan output.
			// The SDK reads it from `env` by name; without it telemetry is a no-op.
			MAPLE_INGEST_KEY: IngestKeys.pipe(Effect.map((keys) => keys.privateKey)),
			// Becomes the `deployment.environment.name` resource attribute.
			MAPLE_ENVIRONMENT: "production",
		},
	},
	// Runs once per isolate, not per request.
	Effect.gen(function* () {
		// The actual work. `Effect.log` goes to Maple too — the same layer installs
		// the Tracer and the Effect Logger.
		const checkout = Effect.gen(function* () {
			yield* Effect.log("handling checkout request")
			return yield* HttpServerResponse.json({ ok: true, service: SERVICE_NAME })
		})

		return {
			fetch: Effect.gen(function* () {
				const ctx = yield* Cloudflare.WorkerExecutionContext
				const env = yield* Cloudflare.WorkerEnvironment
				const request = yield* HttpServerRequest

				// The span closes with `checkout`, before the flush is scheduled:
				// `waitUntil` starts the promise immediately, and a span still open at
				// that point misses the drain. Custom attributes live under the
				// `maple.*` namespace by convention.
				const response = yield* checkout.pipe(
					Effect.withSpan(`${request.method} /`, {
						attributes: { "maple.example.stack": "alchemy-maple" },
					}),
				)

				// Drain spans and logs after the response is on the wire.
				yield* ctx.waitUntil(Effect.promise(() => telemetry.flush(env)))
				return response
			}).pipe(
				// Installs the Tracer and the Effect Logger. It goes on the handler
				// rather than the impl because Alchemy only admits Worker services in a
				// handler's requirements — and it is cheap: the layer is a few
				// references over buffers that live in `telemetry`, so the per-event
				// build keeps nothing of its own.
				Effect.provide(telemetry.layer),
			),
		}
	}),
) {}

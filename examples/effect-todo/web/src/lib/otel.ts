/**
 * Browser telemetry → Maple local mode, via the Maple Effect client SDK.
 * Mirrors apps/web's otel-layer.ts.
 *
 * Every HTTP request the app makes is wrapped in an `http.client` span and
 * carries a W3C `traceparent` header, so the backend continues the SAME trace.
 * These browser spans export straight to the local-mode OTLP ingest, which is
 * what makes `todo-web` show up as its own service (and draws the
 * `todo-web → todo-api` edge on the service map).
 *
 * Two deliberate opt-outs below: `maple start` only serves the OTLP routes
 * (`/v1/traces`, `/v1/logs`, `/v1/metrics`). Session metadata and rrweb replay
 * post to `/v1/sessionReplays/meta` and `/v1/sessionReplays/blob`, which local
 * mode does not implement — leaving them on would just 404 in the console.
 * Point `VITE_MAPLE_ENDPOINT` at a hosted Maple ingest (with an ingest key) if
 * you want Sessions and Replay too.
 *
 * No ingest key is passed: local mode authenticates nothing, it gates on
 * request origin instead.
 */
import { Maple } from "@maple-dev/effect-sdk/client"

export const todoOtelLayer = Maple.layer({
	serviceName: "todo-web",
	serviceNamespace: "examples",
	environment: "development",
	endpoint: import.meta.env.VITE_MAPLE_ENDPOINT ?? "http://127.0.0.1:4318",
	replay: { enabled: false },
	emitSessionMeta: false,
	tracerExportInterval: "2 seconds",
	loggerExportInterval: "2 seconds",
	metricsExportInterval: "10 seconds",
})

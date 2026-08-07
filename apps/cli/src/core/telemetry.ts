import { Maple } from "@maple-dev/effect-sdk/server"
import { MAPLE_VERSION } from "../version"

// Publishable ("pk") ingest token, baked into the distributed binary so CLI
// telemetry works on a fresh install with zero config. The `maple_pk_` class is
// the public-key tier meant to be embedded in clients — ingest-only, scoped to
// Maple's internal workspace, never a privileged key. Rotation means shipping a
// new CLI release. An explicit `MAPLE_INGEST_KEY` still wins (see below).
const DEFAULT_INGEST_KEY = "maple_pk_bwGJomBwDO4B15sopcuinQVqNFCDjhE2"

/**
 * OpenTelemetry layer for the CLI — traces + logs about the CLI itself
 * (commands, warehouse queries) and, when running `maple start`, the server's
 * OTLP-ingest and `/local/query` request handling.
 *
 * On by default: ships with `DEFAULT_INGEST_KEY`, so telemetry flows to
 * `https://ingest.maple.dev` out of the box. Overrides:
 *   - `MAPLE_INGEST_KEY` — use a different ingest token (wins over the baked-in
 *     one; `config.ingestKey` takes precedence over the env var in the SDK, so
 *     we read it here).
 *   - `MAPLE_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` — redirect the export,
 *     e.g. at a running `maple start` to self-ingest and view in local-ui.
 * `shutdownTimeout` bounds the flush on exit so a slow or unreachable endpoint
 * never hangs a command.
 */
export const TelemetryLayer = Maple.layer({
	serviceName: "maple-cli",
	serviceNamespace: "backend",
	serviceVersion: MAPLE_VERSION,
	repositoryUrl: "https://github.com/Makisuo/maple",
	ingestKey: process.env.MAPLE_INGEST_KEY ?? DEFAULT_INGEST_KEY,
	shutdownTimeout: "3 seconds",
	// NOTE: expected user errors (bad flag, "maple is already running") still
	// record as Error spans here. `anticipatedErrorIdentifiers` — which the API
	// and alerting workers use to map 4xx-ish outcomes to Ok — is implemented in
	// Maple's flushable tracer, and this server layer wires Effect's stock
	// `Otlp.layerJson` instead. Supporting it on the CLI means giving the server
	// SDK the flushable tracer, which is an SDK change, not a CLI one.
})

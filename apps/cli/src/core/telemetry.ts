import { Maple } from "@maple-dev/effect-sdk/server"
import { MAPLE_VERSION } from "../version"

// Publishable ("pk") ingest token, baked into the distributed binary so CLI
// telemetry works on a fresh install with zero config. The `maple_pk_` class is
// the public-key tier meant to be embedded in clients — ingest-only, scoped to
// Maple's internal workspace, never a privileged key. Rotation means shipping a
// new CLI release. An explicit `MAPLE_INGEST_KEY` still wins (see below).
const DEFAULT_INGEST_KEY = "maple_pk_bwGJomBwDO4B15sopcuinQVqNFCDjhE2"

/**
 * Where this invocation is running.
 *
 * Without this the SDK falls back to `Config.withDefault("development")` — none
 * of `MAPLE_ENVIRONMENT` / `RAILWAY_ENVIRONMENT_NAME` / `DEPLOYMENT_ENV` exist
 * on a laptop — so *every* CLI install reported `development`, indistinguishable
 * from a Maple worker running locally and, worse, from our own CI. Triaging the
 * CLI's error stream meant reading paths out of error strings to guess whether a
 * failure came from a user or a GitHub Actions runner.
 *
 * `CI` is the de-facto standard variable, set by GitHub Actions, GitLab, CircleCI
 * and Buildkite alike. An explicit `MAPLE_ENVIRONMENT` still wins.
 */
const resolveEnvironment = (): string => {
	if (process.env.MAPLE_ENVIRONMENT) return process.env.MAPLE_ENVIRONMENT
	return process.env.CI ? "ci" : "cli"
}

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
	environment: resolveEnvironment(),
	repositoryUrl: "https://github.com/Makisuo/maple",
	ingestKey: process.env.MAPLE_INGEST_KEY ?? DEFAULT_INGEST_KEY,
	shutdownTimeout: "3 seconds",
	// NOTE: expected user outcomes ("maple is already running", `--help`) no
	// longer record as Error spans — `bin.ts` recovers them inside the root span
	// and annotates `maple.cli.outcome` instead. That is a CLI-side fix, not the
	// SDK's `anticipatedErrorIdentifiers`, which lives in Maple's flushable tracer
	// while this server layer wires Effect's stock `Otlp.layerJson`. Anything
	// still arriving as an Error span here is a genuine failure.
})

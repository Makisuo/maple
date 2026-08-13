#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Metric, Runtime } from "effect"
import * as Command from "effect/unstable/cli/Command"
import { FetchHttpClient } from "effect/unstable/http"
import { cli } from "./cli"
import { MapleConfig } from "./core/config"
import { Mode } from "./core/mode"
import { annotateOutcome, recoverExpected } from "./core/outcomes"
import { TelemetryLayer } from "./core/telemetry"
import { maybeNotifyUpdate } from "./core/update"
import { WarehouseExecutorFromMode } from "./core/warehouse"
import { archiveErrorMessage } from "./server/archives/errors"
import { CHECKPOINT_REOPEN_PROBE_ENV, validateCheckpointDataDir } from "./server/checkpoints"
import { MAPLE_VERSION } from "./version"

// WarehouseExecutorFromMode needs Mode (which needs MapleConfig). provideMerge
// keeps Mode + MapleConfig in the output context too, so the login/logout/whoami
// commands can read them directly. The executor's backend is resolved lazily on
// first query, so commands that never query work even with no backend configured.
const MainLayer = WarehouseExecutorFromMode.pipe(
	Layer.provideMerge(Mode.layer),
	Layer.provideMerge(MapleConfig.layer),
	Layer.provideMerge(BunServices.layer),
	Layer.provideMerge(FetchHttpClient.layer),
)

// Throttled, non-blocking "update available" notice before dispatching the
// command. It never fails and short-circuits to a cached decision on most runs
// (network is hit at most once per 24h), so the latency cost is negligible.
//
// `cli.argv` records the sub-command + flags so one root span per invocation
// ties a command to the warehouse queries it runs. TelemetryLayer is provided
// OUTERMOST (after MainLayer), not merged into it: the OTLP tracer's batch
// exporter flushes when its layer scope closes, and only the outermost provide's
// scope is the runtime's main scope that `BunRuntime.runMain` closes on exit.
// Merging it into MainLayer leaves spans unflushed for short-lived commands.
const checkpointProbeDataDir = process.env[CHECKPOINT_REOPEN_PROBE_ENV]
const cliInvocations = Metric.counter("cli.invocations_total", {
	description: "Total Maple CLI command invocations",
	incremental: true,
}).pipe(Metric.withConstantInput(1))
const cliInvocationDuration = Metric.timer("cli.invocation_duration", {
	description: "Maple CLI command duration",
})

if (checkpointProbeDataDir !== undefined) {
	// Private re-exec path used by checkpoint restore. It intentionally bypasses
	// CLI dispatch, update checks, telemetry, and schema bootstrap: success means
	// this new process loaded the persisted restored representation and queried
	// its core tables before closing chDB cleanly.
	try {
		process.stdout.write(`${JSON.stringify(validateCheckpointDataDir(checkpointProbeDataDir))}\n`)
	} catch (error) {
		process.stderr.write(
			`checkpoint reopen probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exitCode = 1
	}
} else {
	/* oxlint-disable effecttsgo/multiple-effect-provide */
	/* oxlint-disable effecttsgo/strict-effect-provide */
	maybeNotifyUpdate.pipe(
		Effect.flatMap(() =>
			Command.run(cli, { version: MAPLE_VERSION }).pipe(
				Effect.track(cliInvocations),
				Effect.trackDuration(cliInvocationDuration),
			),
		),
		// The recovery sits *inside* the span: applied outside it, a gracefully
		// handled archive error still closed the root span as Error.
		Effect.catchTag("@maple/cli/ArchiveError", (error) =>
			Effect.sync(() => {
				process.stderr.write(archiveErrorMessage(error))
				process.exitCode = 1
			}),
		),
		// Expected outcomes, recovered inside the span for the same reason as the
		// archive error above. These are the CLI behaving correctly — a refused
		// precondition, an unresolvable backend, `--help` — and letting them reach
		// `withSpan` closed the root span `Error`. They dominated the CLI's error
		// stream (~24k events for the already-running guard alone) and buried real
		// failures under outcomes nobody needs to act on.
		//
		// The outcome is annotated rather than dropped, so `maple.cli.outcome` still
		// answers "how often do people hit this?" without the span being an error.
		// Same rule `apps/ingest` applies to expected 4xx rejections.
		//
		// Genuine failures stay uncaught on purpose: `@maple/cli/ServerError` (bind
		// failure, dirty store, incompatible store) and every other tag still close
		// the span `Error` and are reported by `runMain`.
		Effect.catchTags({
			"@maple/cli/ServerStateError": recoverExpected,
			// Mode resolution ("No Maple backend found", "Cannot use --remote and
			// --local together") reaches here as a `WarehouseConfigError`, remapped by
			// `WarehouseExecutorFromMode` in core/warehouse.ts. `pipeName` is the
			// discriminator: only "mode" is an expected outcome — every other
			// `WarehouseConfigError` is a real query failure (unknown table, bad
			// column) and is re-raised so it still closes the span `Error`.
			"@maple/http/errors/WarehouseConfigError": (error) =>
				error.pipeName === "mode" ? recoverExpected(error) : Effect.fail(error),
			// `Command.runWith` renders the help text and then re-fails with the same
			// error, so `maple --help` recorded as an error span. The text is already
			// on stdout by now; only the exit code is left to honour — 0 for a plain
			// `--help`, 1 when help was shown because parsing failed.
			//
			// The tag is "ShowHelp"; `~effect/cli/CliError/ShowHelp` (what shows up in
			// telemetry) is the schema *identifier*, not the tag.
			ShowHelp: (error) =>
				annotateOutcome(error._tag).pipe(
					Effect.andThen(
						Effect.sync(() => {
							process.exitCode = Runtime.getErrorExitCode(error)
						}),
					),
				),
		}),
		Effect.withSpan("maple", { attributes: { "cli.argv": process.argv.slice(2).join(" ") } }),
		Effect.provide(MainLayer),
		Effect.provide(TelemetryLayer),
		BunRuntime.runMain,
	)
	/* oxlint-enable effecttsgo/strict-effect-provide */
	/* oxlint-enable effecttsgo/multiple-effect-provide */
}

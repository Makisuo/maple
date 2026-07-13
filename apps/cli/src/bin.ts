#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import * as Command from "effect/unstable/cli/Command"
import { cli } from "./cli"
import { MapleConfig } from "./core/config"
import { Mode } from "./core/mode"
import { TelemetryLayer } from "./core/telemetry"
import { maybeNotifyUpdate } from "./core/update"
import { WarehouseExecutorFromMode } from "./core/warehouse"
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
)

// Throttled, non-blocking "update available" notice before dispatching the
// command. It never fails and short-circuits to a cached decision on most runs
// (network is hit at most once per 24h), so the latency cost is negligible.
//
// `cli.argv` records the sub-command + flags so one root span per invocation
// ties a command to the warehouse queries it runs. A single merged layer keeps
// both layer lifecycles in the runtime's main scope, so telemetry flushes when
// `BunRuntime.runMain` closes that scope for short-lived commands.
const RuntimeLayer = Layer.merge(MainLayer, TelemetryLayer)

const checkpointProbeDataDir = process.env[CHECKPOINT_REOPEN_PROBE_ENV]

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
	maybeNotifyUpdate.pipe(
		Effect.flatMap(() => Command.run(cli, { version: MAPLE_VERSION })),
		Effect.withSpan("maple", { attributes: { "cli.argv": process.argv.slice(2).join(" ") } }),
		Effect.provide(RuntimeLayer),
		BunRuntime.runMain,
	)
}

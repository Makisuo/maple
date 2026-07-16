import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { services, diagnose, serviceMap, topOps } from "./commands/services"
import { traces, trace, slowTraces } from "./commands/traces"
import { errors, error } from "./commands/errors"
import { logs, logPatterns } from "./commands/logs"
import { attributes } from "./commands/attributes"
import { metrics, query } from "./commands/data"
import { timeseries, breakdown, compare } from "./commands/analytics"
import { login, logout, whoami } from "./commands/auth"
import { use } from "./commands/config"
import { start, stop, reset, checkpoint, restore } from "./commands/server"
import { update } from "./commands/update"

// One CLI, two backends. Every query command bottoms out at the shared
// `WarehouseExecutor`; the active mode (local chDB vs remote warehouse) is
// resolved at runtime (see core/mode.ts). The `--remote`/`--local` flags are
// declared here as shared flags so parsing accepts them and `--help` lists
// them — the mode resolver reads them back from argv.
export const cli = Command.make("maple").pipe(
	Command.withDescription(
		"Query Maple telemetry (traces, logs, errors, services) from your terminal. " +
			"Runs against the local binary (`maple start`) or a remote workspace (`maple login`); " +
			"the mode is auto-detected and can be forced with --local / --remote.",
	),
	Command.withSharedFlags({
		remote: Flag.boolean("remote").pipe(
			Flag.withDescription("Force remote mode (requires `maple login`)"),
			Flag.withDefault(false),
		),
		local: Flag.boolean("local").pipe(
			Flag.withDescription("Force local mode (requires a running `maple start`)"),
			Flag.withDefault(false),
		),
		debug: Flag.boolean("debug").pipe(
			Flag.withDescription("Print compiled SQL and per-query timing to stderr"),
			Flag.withDefault(false),
		),
		format: Flag.choice("format", ["json", "table"]).pipe(
			Flag.withDescription("Output format for query results (default: json)"),
			Flag.withDefault("json" as const),
		),
	}),
	Command.withSubcommands([
		// Server (local mode)
		start,
		stop,
		reset,
		checkpoint,
		restore,
		// Self-update
		update,
		// Services
		services,
		diagnose,
		serviceMap,
		topOps,
		// Traces
		traces,
		trace,
		slowTraces,
		// Errors
		errors,
		error,
		// Logs
		logs,
		logPatterns,
		// Attributes & metrics
		attributes,
		metrics,
		// Analytics
		timeseries,
		breakdown,
		compare,
		// Raw SQL (local only)
		query,
		// Auth / config
		login,
		logout,
		whoami,
		use,
	]),
)

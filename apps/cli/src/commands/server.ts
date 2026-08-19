import { Effect, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { HttpClient } from "effect/unstable/http"
import { openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { startServer } from "../server/serve"
import { CURRENT_LOCAL_SCHEMA } from "../server/schema-identity"
import { checkStoreCompatible, isSchemaIdentityStale, isStoreDirty } from "../server/store-version"
import { abandonLocalStoreMigration, localMigrationIsIncomplete } from "../server/local-store-migrations"
import {
	type CheckpointAvailability,
	checkpointAvailability,
	createCheckpoint,
	parseCheckpointId,
	reconcileCheckpointRecovery,
	resetLiveStorePreservingCheckpoints,
	restoreCheckpoint,
	writeBackupConfig,
} from "../server/checkpoints"
import { resolveUiAssets } from "../server/ui-assets"
import { amber, bold, cyan, dim, green, MARK_LINES, MARK_WIDTH, underline } from "../lib/style"
import {
	buildDetachedChildArgs,
	canonicalUrlHostname,
	connectionHostForBindHost,
	type DirtyStorePolicy,
	hostedDashboardUrl,
	hostedUiOrigin,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
	validateHost,
} from "./server-args"

/** A `maple start`/`maple stop` failure. The message is shown to the user and
 *  the process exits non-zero — same role the old `process.exit(1)` paths had,
 *  but typed and handled by the CLI runtime (matches `ModeError`). */
class ServerError extends Schema.TaggedError<ServerError>()("@maple/cli/ServerError", {
	message: Schema.String,
}) {}

/**
 * A refused command whose precondition simply wasn't met — the server is already
 * running, or isn't running at all. The message and the non-zero exit are
 * identical to `ServerError`; the separate tag exists so `bin.ts` can close the
 * root span `Ok` for these without also swallowing genuine start failures
 * ("failed to bind …", "did not come up within 10s"), which stay on
 * `ServerError`. Same rule the ingest gateway follows for expected 4xx.
 */
export class ServerStateError extends Schema.TaggedError<ServerStateError>()("@maple/cli/ServerStateError", {
	message: Schema.String,
}) {}

const defaultDataDir = (): string => join(homedir(), ".maple", "data")

/** Collapse the home directory to `~` for tidy paths. */
const prettyPath = (p: string): string => {
	const home = homedir()
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

/** Public origin of the deployed local-mode dashboard SPA. Overridable for
 *  testing against staging (`local-staging.maple.dev`). */
const DEFAULT_REMOTE_UI_URL = "https://local.maple.dev"

const remoteUiUrl = (): Effect.Effect<string, ServerError> => {
	const configured = process.env.MAPLE_LOCAL_UI_URL?.trim() || DEFAULT_REMOTE_UI_URL
	return Effect.try({
		try: () => {
			hostedUiOrigin(configured)
			return configured
		},
		catch: (error) =>
			new ServerError({
				message: `invalid MAPLE_LOCAL_UI_URL: ${error instanceof Error ? error.message : String(error)}`,
			}),
	})
}

const validatedHost = (source: string, value: string): Effect.Effect<string, ServerError> =>
	Effect.try({
		try: () => validateHost(value),
		catch: (error) =>
			new ServerError({
				message: `invalid ${source}: ${error instanceof Error ? error.message : String(error)}`,
			}),
	})

/** The startup banner shown once the server is listening. `dashboardUrl` is the
 *  URL the user should open (the auto-updating `local.maple.dev` by default, or
 *  the bundled same-origin UI with `--offline`); `undefined` when no UI. */
const startBanner = (
	bindAddr: string,
	connectAddr: string,
	dataDir: string,
	dashboardUrl: string | undefined,
	offline: boolean,
): string => {
	// No leading indent here — the gutter below supplies it.
	const row = (key: string, value: string) => `${dim(key.padEnd(11))}${value}`
	const content = [
		// The lockup. Mono has only one face, so the tension that carries it in
		// the UI (display vs. mono) becomes weight: `maple` bold, `local` dim.
		`${bold("maple")} ${dim("local")}`,
		`${green("●")} listening on ${cyan(underline(bindAddr))}`,
		"",
		...(connectAddr === bindAddr ? [] : [row("connect", cyan(connectAddr))]),
		row("OTLP/HTTP", `POST ${dim("/v1/{traces,logs,metrics}")}`),
		row("query", `POST ${dim("/local/query")}`),
		...(dashboardUrl
			? [
					row("dashboard", cyan(dashboardUrl)),
					...(offline ? [] : [`${" ".repeat(11)}${dim("· bundled UI: pass --offline")}`]),
				]
			: []),
		row("data", prettyPath(dataDir)),
		row("pid", `${process.pid}  ${dim("· stop with")} ${bold("maple stop")}`),
	]

	// The mark rides in a left gutter rather than sitting above the rows, so it
	// costs no vertical space: the content is already as tall as the mark. On a
	// terminal too narrow to seat it, the mark is dropped and the wordmark
	// carries local mode alone — a wrapped banner is worse than no glyph.
	//
	// The threshold covers the gutter plus the key column plus a readable value.
	// It deliberately does NOT measure the longest line: a dashboard URL or a
	// `--data-dir` can be arbitrarily long, and those already wrap today. Gating
	// on them would make the glyph blink out for reasons the user can't see.
	const lines =
		(process.stdout.columns ?? 80) >= 72
			? Array.from({ length: Math.max(MARK_LINES.length, content.length) }, (_, i) =>
					`  ${amber(MARK_LINES[i] ?? " ".repeat(MARK_WIDTH))}   ${content[i] ?? ""}`.trimEnd(),
				)
			: content.map((line) => `  ${line}`)

	return `\n${lines.join("\n")}\n\n`
}

// PID file lives one level above the data dir (e.g. ~/.maple/maple.pid) so
// `maple stop` finds it without knowing the full data path.
const pidFilePath = (dataDir: string): string => join(dirname(dataDir), "maple.pid")

/** Read the PID file, returning `none` when it is missing or unparseable. */
const readPid = (fs: FileSystem, pidPath: string): Effect.Effect<Option.Option<number>> =>
	fs.readFileString(pidPath).pipe(
		Effect.map((raw) => {
			const pid = Number.parseInt(raw.trim(), 10)
			return Number.isFinite(pid) ? Option.some(pid) : Option.none<number>()
		}),
		Effect.orElseSucceed(() => Option.none<number>()),
	)

/** Liveness probe via signal 0 — a process primitive with no FileSystem
 *  equivalent. Never throws (errors mean "not alive"). */
const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const port = Flag.integer("port").pipe(
	Flag.withDescription("Port for OTLP/HTTP ingest, the query API, and the bundled UI"),
	Flag.withDefault(4318),
)

const host = Flag.string("host").pipe(
	Flag.withDescription(
		"Local server host (env: MAPLE_LOCAL_BIND_HOST; non-loopback start exposes unauthenticated ingest and queries)",
	),
	Flag.withDefault(resolveBindHost(process.env.MAPLE_LOCAL_BIND_HOST)),
)

const advertiseHostFlag = Flag.optional(
	Flag.string("advertise-host").pipe(
		Flag.withDescription(
			"Hostname or address printed for clients and the bundled UI (env: MAPLE_LOCAL_ADVERTISE_HOST)",
		),
	),
)

const dataDirFlag = Flag.optional(
	Flag.string("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const chdbConfigFileFlag = Flag.optional(
	Flag.string("chdb-config-file").pipe(
		Flag.withDescription(
			"ClickHouse config file for embedded chDB (default: a generated backups-enabled config beside the data dir)",
		),
	),
)

const minimumRawTelemetryRetentionDaysFlag = Flag.optional(
	Flag.integer("minimum-raw-telemetry-retention-days").pipe(
		Flag.withDescription(
			"Persist a monotonic raw-table retention floor (minimum 90 days; survives reset and restore)",
		),
	),
)

const backgroundFlag = Flag.boolean("background").pipe(
	Flag.withAlias("d"),
	Flag.withDescription("Run the server detached (logs to ~/.maple/maple.log); stop with `maple stop`"),
	Flag.withDefault(false),
)

const resetFlag = Flag.boolean("reset").pipe(
	Flag.withDescription(
		"Wipe live chDB data before starting while preserving checkpoints — use after an incompatible upgrade",
	),
	Flag.withDefault(false),
)

const onDirtyStoreFlag = Flag.choice("on-dirty-store", ["wipe", "fail", "restore-checkpoint"]).pipe(
	Flag.withDescription("Recovery policy when the local chDB store was not cleanly closed"),
	Flag.withDefault("fail" as const),
)

const yesFlag = Flag.boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Skip the confirmation prompt"),
	Flag.withDefault(false),
)

const checkpointIdFlag = Flag.optional(
	Flag.string("checkpoint-id").pipe(
		Flag.withDescription("Restore one immutable checkpoint ID instead of the selected current"),
	),
)

const offlineFlag = Flag.boolean("offline").pipe(
	Flag.withDescription(
		"Use the UI bundled in this binary (served from the configured bind host) instead of local.maple.dev",
	),
	Flag.withDefault(false),
)

// Log file for `--background` runs, beside the PID file (e.g. ~/.maple/maple.log).
const logFilePath = (dataDir: string): string => join(dirname(dataDir), "maple.log")

// Generated chDB config, beside the PID and log files (e.g. ~/.maple/chdb-config.xml).
export const chdbConfigPath = (dataDir: string): string => join(dirname(dataDir), "chdb-config.xml")

/**
 * Resolve the chDB config file, generating a backups-enabled default when the
 * user did not supply one.
 *
 * `BACKUP DATABASE default TO Disk('default', …)` — how every checkpoint is
 * taken — needs `<backups><allowed_disk>` in the config of the *running* chDB
 * connection. chDB allows one connection per process, acquired once at start and
 * held for the process lifetime, and `maple checkpoint` is a separate process
 * talking over HTTP: it cannot inject config into a live connection. So a server
 * started without a backups config can never checkpoint, and `maple checkpoint`
 * could only ever report that after the fact.
 *
 * The effect was that checkpoints were unusable out of the box and, because the
 * dirty-store recovery path tells users to run `maple restore --yes`, that advice
 * pointed at a checkpoint which could not exist. Generating the default here
 * fixes both. A user-supplied `--chdb-config-file` is honoured untouched.
 */
export const resolveChdbConfigFile = (dataDir: string, supplied: string | undefined) =>
	Effect.gen(function* () {
		if (supplied !== undefined) return supplied
		const fs = yield* FileSystem
		const path = chdbConfigPath(dataDir)
		// Regenerated every start: idempotent, and it self-heals a truncated or
		// hand-edited file. Failing to write is not fatal — the server still starts,
		// checkpoints just stay unavailable, which is the old behaviour.
		yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.ignore)
		return yield* Effect.try(() => {
			writeBackupConfig(path)
			return path
		}).pipe(Effect.orElseSucceed(() => undefined))
	})

/**
 * What to tell someone whose local store was left dirty, given whether a
 * checkpoint is actually restorable. Every branch names at least one command
 * that will work from the state they are in.
 */
export const dirtyStoreRecoveryAdvice = (availability: CheckpointAvailability): string => {
	if (availability.available) {
		return (
			`Run \`${bold("maple restore --yes")}\` to restore from the last checkpoint ` +
			`(${dim(availability.checkpointId)}), or \`${bold("maple start --reset")}\` to wipe it.`
		)
	}
	const why =
		availability.reason === "none"
			? "No checkpoint has ever been taken for this store, so there is nothing to restore from"
			: `The checkpoint registry is unusable (${availability.detail}), so restoring from it is not safe`
	return (
		`${why} — the unreadable live data cannot be recovered. ` +
		`Start fresh with \`${bold("maple start --reset")}\`; ` +
		`once running, \`${bold("maple checkpoint")}\` creates a restore point for next time.`
	)
}

/** Non-fatal `/health` probe used while waiting for a detached server to bind.
 *  A transport error or a >300ms timeout collapses to `false` (not yet up).
 *
 *  Untraced: the loop below polls until the child binds, so ECONNREFUSED is the
 *  expected answer for the first ~10 attempts. Each one used to close an
 *  `http.client GET` span as `Error` inside an otherwise-`Ok` root span — 9k
 *  events of pure noise. `orElseSucceed` cannot help: it sits outside the client
 *  call, which has already ended the span by then. `TracerDisabledWhen` is the
 *  hook that skips span creation entirely, and it is scoped to this request
 *  rather than provided layer-wide so real `/health` calls stay traced. */
const probeHealth = (addr: string) =>
	HttpClient.get(`${addr}/health`).pipe(
		Effect.map((res) => res.status >= 200 && res.status < 300),
		Effect.timeout("300 millis"),
		Effect.orElseSucceed(() => false),
		Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
	)

/**
 * Re-exec `maple start` detached, dropping `--background`/`-d` so the child runs
 * the normal foreground path (writes the PID, owns chDB). Output goes to the log
 * file; we poll `/health` until it binds, then print a summary and return so the
 * parent process exits.
 */
const startDetached = (
	host: string,
	advertiseHost: string,
	port: number,
	dataDir: string,
	offline: boolean,
	chdbConfigFile: string | undefined,
	onDirtyStore: DirtyStorePolicy,
	minimumRawTelemetryRetentionDays: number | undefined,
) =>
	Effect.gen(function* () {
		const logPath = logFilePath(dataDir)
		// Rebuild the command explicitly rather than slicing argv: a Bun-compiled
		// binary injects a virtual `/$bunfs/...` entrypoint at argv[1] that must
		// not be forwarded. In dev (`bun run src/bin.ts`) argv[1] is the real
		// script and Bun needs it; in the compiled binary execPath alone suffices.
		const childArgs = buildDetachedChildArgs({
			entry: process.argv[1],
			host,
			advertiseHost,
			port,
			dataDir,
			offline,
			chdbConfigFile,
			onDirtyStore,
			minimumRawTelemetryRetentionDays,
		})

		const child = yield* Effect.try({
			try: () => {
				const fd = openSync(logPath, "a")
				const proc = Bun.spawn([process.execPath, ...childArgs], {
					stdin: "ignore",
					stdout: fd,
					stderr: fd,
				})
				proc.unref()
				return proc
			},
			catch: (e) =>
				new ServerError({
					message: `failed to spawn background server: ${e instanceof Error ? e.message : String(e)}`,
				}),
		})

		const bindAddr = serverUrl(host, port)
		const connectAddr = serverUrl(advertiseHost, port)
		const probeAddr = serverProbeUrl(host, port)
		// One span for the whole readiness wait, never one per probe. The probes
		// themselves are untraced (see `probeHealth`), so a boot shows up as a
		// single `server.wait_ready` carrying how many attempts it took — instead of
		// ~10 `Error` client spans for the ECONNREFUSEDs that are the expected
		// answer while the child is still binding. The span succeeds either way;
		// missing the deadline is reported by the `ServerError` below, once.
		const up = yield* Effect.gen(function* () {
			for (let attempt = 1; attempt <= 100; attempt++) {
				yield* Effect.sleep("100 millis")
				if (yield* probeHealth(probeAddr)) {
					yield* Effect.annotateCurrentSpan({ "maple.server.probe_attempt": attempt })
					return true
				}
				if (!isProcessAlive(child.pid)) {
					// Child died early — stop waiting.
					yield* Effect.annotateCurrentSpan({
						"maple.server.probe_attempt": attempt,
						"maple.server.exited_early": true,
					})
					return false
				}
			}
			yield* Effect.annotateCurrentSpan({ "maple.server.probe_attempt": 100 })
			return false
		}).pipe(Effect.withSpan("server.wait_ready", { attributes: { "server.address": probeAddr } }))
		if (!up) {
			return yield* new ServerError({
				message: `background server did not come up within 10s — check ${prettyPath(logPath)}`,
			})
		}

		yield* Effect.sync(() =>
			process.stdout.write(
				`${green("✓")} maple started in background ${dim(`(PID ${child.pid})`)}\n` +
					`  ${dim("listening")} ${cyan(underline(bindAddr))}\n` +
					(connectAddr === bindAddr ? "" : `  ${dim("connect")}   ${cyan(connectAddr)}\n`) +
					`  ${dim("logs")}      ${prettyPath(logPath)}\n` +
					`  ${dim("stop")}      ${bold("maple stop")}\n`,
			),
		)
	})

export const start = Command.make("start", {
	host,
	advertiseHost: advertiseHostFlag,
	port,
	dataDir: dataDirFlag,
	chdbConfigFile: chdbConfigFileFlag,
	minimumRawTelemetryRetentionDays: minimumRawTelemetryRetentionDaysFlag,
	background: backgroundFlag,
	offline: offlineFlag,
	reset: resetFlag,
	onDirtyStore: onDirtyStoreFlag,
}).pipe(
	Command.withDescription("Start the local ingest + query server (embedded ClickHouse via chDB)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const bindHost = yield* validatedHost("--host / MAPLE_LOCAL_BIND_HOST", a.host)
			const hostedUiUrl = a.offline ? DEFAULT_REMOTE_UI_URL : yield* remoteUiUrl()
			const advertiseHost = yield* validatedHost(
				"--advertise-host / MAPLE_LOCAL_ADVERTISE_HOST",
				resolveAdvertiseHost(
					Option.getOrUndefined(a.advertiseHost),
					process.env.MAPLE_LOCAL_ADVERTISE_HOST,
					bindHost,
				),
			)
			const pidPath = pidFilePath(dataDir)

			// Already-running guard.
			const existingPid = yield* readPid(fs, pidPath)
			if (Option.isSome(existingPid) && isProcessAlive(existingPid.value)) {
				return yield* new ServerStateError({
					message: `maple is already running (PID ${existingPid.value}) — stop it with \`maple stop\``,
				})
			}
			if (Option.isSome(existingPid)) yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore) // stale

			// A restore transaction lives beside dataDir and must be reconciled
			// before reset, compatibility, dirty-store, or directory creation logic.
			yield* reconcileCheckpointRecovery(dataDir).pipe(
				Effect.mapError((e) => new ServerError({ message: e.message })),
			)

			const migrationIncomplete = yield* Effect.tryPromise({
				try: () => localMigrationIsIncomplete(dataDir),
				catch: (error) =>
					new ServerError({
						message: `cannot read the local migration journal: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
			if (migrationIncomplete && !a.reset) {
				return yield* new ServerError({
					message:
						`the local store has an unfinished schema migration. ` +
						`Resume or inspect it with \`${bold("maple schema migrate --yes")}\`; ordinary startup remains fail-closed.`,
				})
			}
			if (migrationIncomplete) {
				yield* Effect.tryPromise({
					try: () => abandonLocalStoreMigration(dataDir),
					catch: (error) =>
						new ServerError({
							message: `could not preserve the unfinished migration before reset: ${error instanceof Error ? error.message : String(error)}`,
						}),
				})
			}

			// `--reset`: wipe the store (and its version marker) so we bootstrap fresh.
			// Preserve the checkpoint registry under dataDir/backups.
			if (a.reset) {
				yield* resetLiveStorePreservingCheckpoints(dataDir).pipe(
					Effect.mapError((e) => new ServerError({ message: e.message })),
				)
			}

			yield* fs.makeDirectory(dataDir, { recursive: true })

			// Refuse to open a store written by an incompatible chDB build: re-loading
			// its persisted materialized views crashes the C++ runtime natively
			// (SIGTRAP), which we cannot catch. Fresh/matching stores pass through.
			const compat = checkStoreCompatible(dataDir)
			if (!compat.compatible) {
				return yield* new ServerError({
					message:
						`the local store at ${prettyPath(dataDir)} is incompatible with this build's chDB ` +
						`(store: ${compat.found}; build: ${compat.current}) — loading it would crash chDB. ` +
						`Wipe it with \`${bold("maple reset")}\`, or start fresh via \`${bold("maple start --reset")}\`.`,
				})
			}

			// A store left "open" (the previous server died without running its close
			// finalizer) may be inconsistent — reopening it can crash chDB natively,
			// which we cannot catch. Auto-wipe and bootstrap fresh instead of walking
			// into the crash. (`--reset` already wiped above, so the marker is gone.)
			if (isStoreDirty(dataDir)) {
				// Checkpoints only exist if someone ran `maple checkpoint`, so the
				// recovery advice has to be conditioned on one actually being there.
				// Offering `maple restore --yes` unconditionally stranded users whose
				// store had never been checkpointed: start refused to open the store,
				// restore aborted with "checkpoint state not found", and nothing in
				// either message named a command that would work.
				const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
				if (a.onDirtyStore === "fail") {
					return yield* new ServerError({
						message:
							`the local store at ${prettyPath(dataDir)} was not cleanly closed. ` +
							dirtyStoreRecoveryAdvice(availability),
					})
				}
				if (a.onDirtyStore === "restore-checkpoint") {
					if (!availability.available) {
						return yield* new ServerError({
							message:
								`the local store at ${prettyPath(dataDir)} was not cleanly closed and ` +
								`--on-dirty-store=restore-checkpoint cannot proceed. ` +
								dirtyStoreRecoveryAdvice(availability),
						})
					}
					yield* Effect.sync(() =>
						process.stderr.write(
							amber(
								"⚠ the local store was left inconsistent by an unclean shutdown — " +
									"restoring the last checkpoint\n",
							),
						),
					)
					const restored = yield* restoreCheckpoint(dataDir).pipe(
						Effect.mapError((e) => new ServerError({ message: e.message })),
					)
					yield* Effect.sync(() =>
						process.stderr.write(
							`${green("✓")} restored checkpoint; quarantined dirty store at ${prettyPath(restored.quarantinePath)}\n`,
						),
					)
				} else {
					yield* Effect.sync(() =>
						process.stderr.write(
							amber(
								"⚠ the local store was left inconsistent by an unclean shutdown — " +
									"explicit wipe selected; discarding live telemetry while preserving checkpoints\n",
							),
						),
					)
					yield* resetLiveStorePreservingCheckpoints(dataDir).pipe(
						Effect.mapError((e) => new ServerError({ message: e.message })),
					)
					yield* fs.makeDirectory(dataDir, { recursive: true })
				}
			}

			// A store bootstrapped from an older bundled schema can't be evolved in
			// place: `CREATE … IF NOT EXISTS` is a no-op on existing tables, so a
			// column added to the schema (e.g. ServiceNamespace on trace_list_mv)
			// never lands and facet queries referencing it fail. Rebuild from the
			// current schema. Do not silently delete telemetry or checkpoints:
			// require an explicit reset, which preserves the checkpoint registry.
			if (isSchemaIdentityStale(dataDir, CURRENT_LOCAL_SCHEMA)) {
				return yield* new ServerError({
					message:
						`the local store at ${prettyPath(dataDir)} was built from a different schema identity. ` +
						`Maple preserved it and its checkpoints. Inspect the supported path with ` +
						`\`${bold("maple schema plan")}\`; run \`${bold("maple schema migrate --yes")}\` ` +
						`when the printed preservation envelope is acceptable. If no path is registered, ` +
						`use the explicit destructive \`${bold("maple start --reset")}\` or \`${bold("maple reset --yes")}\`.`,
				})
			}

			const requestedRetentionDays = Option.getOrUndefined(a.minimumRawTelemetryRetentionDays)
			const chdbConfigFile = yield* resolveChdbConfigFile(
				dataDir,
				Option.getOrUndefined(a.chdbConfigFile),
			)

			// Detached: spawn the same command without --background and exit.
			if (a.background)
				return yield* startDetached(
					bindHost,
					advertiseHost,
					a.port,
					dataDir,
					a.offline,
					chdbConfigFile,
					a.onDirtyStore,
					requestedRetentionDays,
				)

			yield* Effect.sync(() =>
				process.stderr.write(
					dim(`◌ opening chDB at ${prettyPath(dataDir)} (bootstrapping schema)…\n`),
				),
			)
			const assets = yield* resolveUiAssets()

			// The server, PID file, and shutdown notice are all tied to this scope.
			// On SIGINT/SIGTERM, `BunRuntime.runMain` interrupts the fiber blocked on
			// `Effect.never`, closing the scope and running finalizers in reverse
			// registration order: remove PID → stop server → close chDB → print the
			// stopped notice.
			return yield* Effect.scoped(
				Effect.gen(function* () {
					// Only announce "stopped" if we actually started. The finalizer is
					// registered up front so it fires on the SIGINT/SIGTERM shutdown, but
					// a startup failure also unwinds this scope — without the guard it
					// would print a misleading "✓ maple stopped" before the error.
					let started = false
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							if (started) process.stderr.write(`\n${green("✓")} maple stopped\n`)
						}),
					)

					const { port: boundPort } = yield* startServer({
						hostname: bindHost,
						browserHosts: Array.from(
							new Set(
								[bindHost, connectionHostForBindHost(bindHost), advertiseHost].map(
									canonicalUrlHostname,
								),
							),
						),
						corsOrigin: hostedUiOrigin(hostedUiUrl),
						port: a.port,
						dataDir,
						configFile: chdbConfigFile,
						minimumRawTelemetryRetentionDays: requestedRetentionDays,
						assets,
					}).pipe(
						Effect.mapError((e) => new ServerError({ message: `failed to start: ${e.message}` })),
					)
					started = true

					yield* Effect.acquireRelease(fs.writeFileString(pidPath, String(process.pid)), () =>
						fs.remove(pidPath, { force: true }).pipe(Effect.ignore),
					)

					const bindAddr = serverUrl(bindHost, boundPort)
					const connectAddr = serverUrl(advertiseHost, boundPort)
					// Default: send users to the auto-updating UI on local.maple.dev (it
					// reaches this binary on loopback via the encoded ?port=). --offline:
					// serve the bundled UI from this origin (only when one is embedded).
					const dashboardUrl = a.offline
						? assets !== undefined
							? `${connectAddr}/`
							: undefined
						: hostedDashboardUrl(hostedUiUrl, boundPort)
					yield* Effect.sync(() =>
						process.stdout.write(
							startBanner(bindAddr, connectAddr, dataDir, dashboardUrl, a.offline),
						),
					)

					return yield* Effect.never
				}),
			)
		}),
	),
)

/**
 * How long `maple stop` waits for the server to exit after SIGTERM, and how
 * often it checks. Sized against the server's own shutdown cost — see the note
 * in the poll loop below.
 */
const STOP_TIMEOUT_MS = 15_000
const STOP_POLL_MS = 100

export const stop = Command.make("stop", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Stop a running `maple start` server"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const pidPath = pidFilePath(dataDir)
			const pidOpt = yield* readPid(fs, pidPath)

			if (Option.isNone(pidOpt)) {
				return yield* new ServerStateError({ message: "maple is not running (no PID file found)" })
			}
			const pid = pidOpt.value
			if (!isProcessAlive(pid)) {
				yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore)
				return yield* new ServerStateError({
					message: "maple is not running (stale PID file, cleaned up)",
				})
			}

			yield* Effect.sync(() => {
				process.kill(pid, "SIGTERM")
				process.stderr.write(dim(`◌ stopping maple (PID ${pid})`))
			})

			// The budget has to exceed what a clean shutdown actually costs, not what
			// it feels like it should cost: the exiting server flushes telemetry with
			// its own 3s bound (`shutdownTimeout` in core/telemetry.ts) and then
			// closes chDB. That lands around 3.5s on a warm laptop, so the old 5s cap
			// left well under two seconds of headroom and a loaded CI runner blew
			// straight through it — the native checkpoint smoke test failed on a
			// server that was shutting down entirely correctly.
			for (let elapsed = 0; elapsed < STOP_TIMEOUT_MS; elapsed += STOP_POLL_MS) {
				yield* Effect.sleep(`${STOP_POLL_MS} millis`)
				// One dot per half-second regardless of the poll rate, so a longer
				// budget doesn't turn into a wall of dots.
				if (elapsed % 500 === 0) yield* Effect.sync(() => process.stderr.write(dim(".")))
				if (!isProcessAlive(pid)) {
					yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore)
					yield* Effect.sync(() => process.stderr.write(`${green("✓")} maple stopped\n`))
					return
				}
			}
			return yield* new ServerError({
				message: `\nmaple did not stop within ${STOP_TIMEOUT_MS / 1000}s — force-kill with \`kill -9 ${pid}\``,
			})
		}),
	),
)

export const reset = Command.make("reset", { dataDir: dataDirFlag, yes: yesFlag }).pipe(
	Command.withDescription(
		"Delete live chDB data while preserving checkpoints so the next start bootstraps fresh",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()

			// Refuse while a server still owns the store.
			const pidOpt = yield* readPid(fs, pidFilePath(dataDir))
			if (Option.isSome(pidOpt) && isProcessAlive(pidOpt.value)) {
				return yield* new ServerStateError({
					message: `maple is running (PID ${pidOpt.value}) — stop it first with \`maple stop\``,
				})
			}

			// Deleting a store is irreversible — require explicit confirmation.
			if (!a.yes) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`This permanently deletes live telemetry at ${bold(prettyPath(dataDir))}.\n` +
							`The checkpoint registry under its backups directory is preserved.\n` +
							`Re-run with ${bold("maple reset --yes")} to confirm.\n`,
					),
				)
				return
			}

			const abandonedMigration = yield* Effect.tryPromise({
				try: () => abandonLocalStoreMigration(dataDir),
				catch: (error) =>
					new ServerError({
						message: `could not preserve the unfinished migration before reset: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
			yield* resetLiveStorePreservingCheckpoints(dataDir).pipe(
				Effect.mapError((e) => new ServerError({ message: e.message })),
			)
			yield* Effect.sync(() =>
				process.stderr.write(
					`${green("✓")} reset — cleared live data and preserved checkpoints at ${prettyPath(dataDir)}\n` +
						(abandonedMigration === null
							? ""
							: `${dim("  migration")} preserved at ${prettyPath(abandonedMigration)}\n`),
				),
			)
		}),
	),
)

export const checkpoint = Command.make("checkpoint", { dataDir: dataDirFlag, host, port }).pipe(
	Command.withDescription("Create and validate a restorable checkpoint of the local chDB store"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const result = yield* createCheckpoint({
				dataDir,
				host: connectionHostForBindHost(a.host),
				port: a.port,
			}).pipe(
				// Only genuine create failures become a `ServerError`. A refused
				// precondition (`CheckpointPreconditionError`) passes straight through
				// to `bin.ts`, which recovers it like any other expected outcome —
				// re-wrapping it here is what billed a second error event per refusal.
				Effect.mapError((e) =>
					e._tag === "@maple/cli/CheckpointPreconditionError"
						? e
						: new ServerError({ message: e.message }),
				),
			)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} checkpoint created\n` +
						`  ${dim("id")}        ${result.checkpointId}\n` +
						`  ${dim("path")}      ${prettyPath(result.path)}\n` +
						`  ${dim("traces")}    ${result.manifest.validation.traces}\n` +
						`  ${dim("logs")}      ${result.manifest.validation.logs}\n` +
						`  ${dim("metrics")}   ${result.manifest.validation.metricsSum}\n` +
						`  ${dim("views")}     ${result.manifest.validation.materializedViews}\n`,
				),
			)
		}),
	),
)

export const restore = Command.make("restore", {
	dataDir: dataDirFlag,
	checkpointId: checkpointIdFlag,
	yes: yesFlag,
}).pipe(
	Command.withDescription("Restore the local chDB store from the last promoted checkpoint"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()

			const pidOpt = yield* readPid(fs, pidFilePath(dataDir))
			if (Option.isSome(pidOpt) && isProcessAlive(pidOpt.value)) {
				return yield* new ServerStateError({
					message: `maple is running (PID ${pidOpt.value}) — stop it first with \`maple stop\``,
				})
			}

			if (!a.yes) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`This replaces the local store at ${bold(prettyPath(dataDir))} with the last checkpoint.\n` +
							`The existing store is moved aside for quarantine, not deleted.\n` +
							`Re-run with ${bold("maple restore --yes")} to confirm.\n`,
					),
				)
				return
			}

			// Fail fast, and legibly, when there is nothing to restore: this used to
			// surface as a raw "checkpoint state not found at …/backups/state.json"
			// with a stack trace, which is exactly where `maple start`'s dirty-store
			// advice sent people.
			const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
			if (!availability.available) {
				return yield* new ServerError({
					message:
						availability.reason === "none"
							? `no checkpoint exists under ${prettyPath(dataDir)} — nothing to restore. ` +
								`Checkpoints are created by \`${bold("maple checkpoint")}\` while the server is running. ` +
								`To start over from an unreadable store, use \`${bold("maple start --reset")}\`.`
							: `the checkpoint registry under ${prettyPath(dataDir)} is unusable: ${availability.detail}. ` +
								`Preserve it for inspection, or start over with \`${bold("maple start --reset")}\`.`,
				})
			}

			const rawCheckpointId = Option.getOrUndefined(a.checkpointId)
			const checkpointId = yield* Effect.try({
				try: () => (rawCheckpointId === undefined ? "current" : parseCheckpointId(rawCheckpointId)),
				catch: (error) =>
					new ServerError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const result = yield* restoreCheckpoint(dataDir, checkpointId).pipe(
				Effect.mapError((e) => new ServerError({ message: e.message })),
			)
			yield* Effect.sync(() =>
				process.stderr.write(
					`${green("✓")} restored checkpoint\n` +
						`  ${dim("id")}         ${result.checkpointId}\n` +
						`  ${dim("quarantine")} ${prettyPath(result.quarantinePath)}\n` +
						`  ${dim("traces")}     ${result.validation.traces}\n` +
						`  ${dim("logs")}       ${result.validation.logs}\n` +
						`  ${dim("metrics")}    ${result.validation.metricsSum}\n` +
						`  ${dim("views")}      ${result.validation.materializedViews}\n`,
				),
			)
		}),
	),
)

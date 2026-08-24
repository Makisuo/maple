import { Duration, Effect, Option, Schema } from "effect"
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
import { debugLog } from "../lib/debug"
import {
	BackgroundServerSpawnError,
	BackgroundServerTimeoutError,
	CheckpointUnavailableError,
	LocalStoreDirtyError,
	LocalStoreIncompatibleError,
	LocalStoreMigrationError,
	LocalStoreSchemaStaleError,
	CheckpointChildError,
	ServerOptionError,
	ServerStopTimeoutError,
} from "./server-errors"
import { amber, bold, cyan, dim, green, MARK_LINES, MARK_WIDTH, underline } from "../lib/style"
import {
	buildCheckpointChildArgs,
	buildDetachedChildArgs,
	canonicalUrlHostname,
	connectionHostForBindHost,
	type DirtyStorePolicy,
	hostedDashboardUrl,
	hostedUiOrigin,
	isProcessAlive,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
	validateHost,
} from "./server-args"

/**
 * A refused command whose precondition simply wasn't met — the server is already
 * running, or isn't running at all. The message and the non-zero exit are
 * identical to a genuine failure; the separate tag exists so `bin.ts` can close
 * the root span `Ok` for these without also swallowing real start failures
 * (`ServerBindError`, `BackgroundServerTimeoutError`, `LocalStoreDirtyError`).
 * Same rule the ingest gateway follows for expected 4xx.
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

const remoteUiUrl = (): Effect.Effect<string, ServerOptionError> => {
	const configured = process.env.MAPLE_LOCAL_UI_URL?.trim() || DEFAULT_REMOTE_UI_URL
	return Effect.try({
		try: () => {
			hostedUiOrigin(configured)
			return configured
		},
		catch: (error) =>
			new ServerOptionError({
				source: "MAPLE_LOCAL_UI_URL",
				message: `invalid MAPLE_LOCAL_UI_URL: ${error instanceof Error ? error.message : String(error)}`,
			}),
	})
}

const validatedHost = (source: string, value: string): Effect.Effect<string, ServerOptionError> =>
	Effect.try({
		try: () => validateHost(value),
		catch: (error) =>
			new ServerOptionError({
				source,
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

/** Default refresh cadence. A crash costs at most this much telemetry. */
const CHECKPOINT_INTERVAL_DEFAULT = "30m"

const checkpointIntervalFlag = Flag.string("checkpoint-interval").pipe(
	Flag.withDescription(
		"How often to refresh the store's restore point while running (e.g. 45s, 30m, 2h; `off` to disable)",
	),
	Flag.withDefault(CHECKPOINT_INTERVAL_DEFAULT),
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
/** How long `maple start --background` waits for the detached child to answer
 *  its health probe, and how often it checks. Reported by
 *  `BackgroundServerTimeoutError` so the budget and the message cannot drift. */
const BACKGROUND_READY_POLL_MS = 100
const BACKGROUND_READY_ATTEMPTS = 100
const BACKGROUND_READY_TIMEOUT_MS = BACKGROUND_READY_POLL_MS * BACKGROUND_READY_ATTEMPTS

/**
 * Parse `--checkpoint-interval`. `off`/`0` disables refreshing and returns
 * `undefined`; anything unparseable is rejected rather than silently defaulted,
 * because a typo that quietly turned checkpointing off would reintroduce exactly
 * the data loss this exists to prevent.
 */
export const parseCheckpointInterval = (
	value: string,
): Duration.Duration | undefined | "invalid" => {
	const raw = value.trim().toLowerCase()
	if (raw === "off" || raw === "0" || raw === "none") return undefined
	const match = raw.match(/^(\d+)\s*(s|m|h)$/)
	if (!match) return "invalid"
	const amount = Number(match[1])
	if (amount <= 0) return undefined
	return match[2] === "s"
		? Duration.seconds(amount)
		: match[2] === "m"
			? Duration.minutes(amount)
			: Duration.hours(amount)
}

/**
 * Should `maple start` take an opening checkpoint? Only ever the first one, and
 * only for a store that actually holds something.
 *
 * A store that already has a checkpoint — and one whose registry is present but
 * *unusable* — is one the user is already managing. Taking another on every
 * start would be a background BACKUP nobody asked for, and overwriting an
 * unusable registry would destroy the evidence of why it broke.
 *
 * `hasLiveData` is what keeps this honest. Backing up an empty store produces a
 * checkpoint that restores to nothing, which is `maple start --reset` wearing a
 * kinder word — it would cost a BACKUP on every first run and buy the user no
 * data back. The case worth protecting is the store that already has telemetry
 * and has never been checkpointed, which is every existing install on the first
 * start after upgrading.
 */
export const needsInitialCheckpoint = (
	availability: CheckpointAvailability,
	hasLiveData: boolean,
): boolean => hasLiveData && !availability.available && availability.reason === "none"

/**
 * Does the store hold live data, as opposed to just the preserved checkpoint
 * registry? `backups` is skipped for the same reason it is skipped when the
 * live store is reset — it is not part of the data being protected.
 */
const storeHasLiveData = (
	fs: FileSystem,
	dataDir: string,
): Effect.Effect<boolean> =>
	fs.readDirectory(dataDir).pipe(
		Effect.map((entries) => entries.some((entry) => entry !== "backups")),
		Effect.orElseSucceed(() => false),
	)

/**
 * Take the store's FIRST checkpoint, once the server is up, if it has none.
 *
 * Nothing used to create a checkpoint except someone typing `maple checkpoint`.
 * So for almost every store `checkpointAvailability` was `{available: false,
 * reason: "none"}`, and an unclean shutdown — a laptop sleeping, an OOM kill —
 * left `maple start` with only one honest thing to say: wipe it and start over.
 * That dead end is the CLI's single largest source of real errors, and every one
 * of them is a user losing all of their local telemetry.
 *
 * One BACKUP per store lifetime, of a store that by definition has never had
 * one, buys a restore point for exactly that case. It runs AFTER the banner, so
 * it delays nothing the user is waiting on, and it is entirely non-fatal: a
 * store that cannot be checkpointed (no `<backups>` stanza, a read-only volume)
 * is still a store that should serve telemetry. Failure leaves the old
 * behaviour, which is the behaviour we already had.
 */
const ensureInitialCheckpoint = (
	dataDir: string,
	host: string,
	port: number,
	hadLiveData: boolean,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const availability = yield* Effect.promise(() => checkpointAvailability(dataDir))
		if (!needsInitialCheckpoint(availability, hadLiveData)) return

		yield* Effect.sync(() =>
			process.stderr.write(dim("◌ taking the store's first checkpoint (restore point)…\n")),
		)
		yield* takeCheckpointQuietly(dataDir, host, port, "initial")
	})

/**
 * Take a checkpoint without ever letting it end the server.
 *
 * Spawned as a CHILD process, never taken in-process. `createCheckpoint` opens
 * its own chDB connection to drive `BACKUP DATABASE`, and chDB allows one per
 * process — the server already holds it, so an in-process call returns
 * `chdb_connect returned NULL` on every attempt. Spawning `maple checkpoint` is
 * the same thing a user does by hand, against the same running server.
 *
 * Quiet on stderr but never silent: the child's own output carries the cause
 * under `--debug`, because a failing loop is otherwise indistinguishable from a
 * working one with nothing to do — and the only symptom would be a store that
 * turns out to have no restore point when it finally matters.
 *
 * `root: true` on the span is load-bearing for the refresh loop. A forked fiber
 * keeps the ambient parent span it was forked under FOREVER, so without it every
 * checkpoint this process ever takes would hang off the one root `maple` span
 * and collapse into a single, ever-growing trace.
 */
const takeCheckpointQuietly = (
	dataDir: string,
	host: string,
	port: number,
	reason: "initial" | "refresh",
): Effect.Effect<void> =>
	Effect.flatMap(
		Effect.tryPromise({
			try: async () => {
				const child = Bun.spawn(
					[
						process.execPath,
						...buildCheckpointChildArgs({ entry: process.argv[1], host, port, dataDir }),
					],
					{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
				)
				const [exitCode, stderr] = await Promise.all([
					child.exited,
					new Response(child.stderr).text(),
				])
				return { exitCode, stderr: stderr.trim() }
			},
			catch: (error): CheckpointChildError =>
				new CheckpointChildError({
					reason,
					exitCode: -1,
					message: `could not spawn maple checkpoint: ${error instanceof Error ? error.message : String(error)}`,
				}),
		}),
		({ exitCode, stderr }) =>
			exitCode === 0
				? Effect.void
				: Effect.fail(
						new CheckpointChildError({
							reason,
							exitCode,
							message: stderr || `maple checkpoint exited ${exitCode}`,
						}),
					),
	).pipe(
		Effect.matchEffect({
			onSuccess: () =>
				Effect.sync(() =>
					process.stderr.write(
						reason === "initial"
							? `${green("✓")} checkpoint taken — recover an unclean shutdown with ` +
								`${bold("maple restore --yes")}\n`
							: dim("◌ checkpoint refreshed\n"),
					),
				),
			onFailure: (error) =>
				Effect.sync(() => {
					debugLog(`checkpoint (${reason}) failed`, error.message)
					process.stderr.write(
						reason === "initial"
							? dim(`◌ could not take an initial checkpoint — run ${bold("maple checkpoint")} to retry\n`)
							: dim("◌ could not refresh the checkpoint — the previous one still stands\n"),
					)
				}),
		}),
		Effect.withSpan("cli.checkpoint", {
			root: true,
			attributes: { "maple.checkpoint.reason": reason },
		}),
	)

/**
 * Refresh the store's restore point on an interval for as long as the server
 * runs.
 *
 * The opening checkpoint only covers data that already existed at start. The
 * case that actually strands people is the ordinary one: install Maple, send it
 * telemetry, lose the process to a SIGKILL or an OOM. Nothing had ever
 * checkpointed that store, so `maple start` could only offer to wipe it.
 *
 * Bounded by the interval, a crash now costs at most that much telemetry
 * instead of all of it. This is the same operation `maple checkpoint` performs
 * against a live server — already exercised concurrently with ingest — just on
 * a timer, and the registry keeps a rotating current/previous pair rather than
 * accumulating.
 */
const checkpointRefreshLoop = (
	dataDir: string,
	host: string,
	port: number,
	interval: Duration.Duration,
): Effect.Effect<never> =>
	Effect.gen(function* () {
		while (true) {
			yield* Effect.sleep(interval)
			yield* takeCheckpointQuietly(dataDir, host, port, "refresh")
		}
	})

const startDetached = (
	host: string,
	advertiseHost: string,
	port: number,
	dataDir: string,
	offline: boolean,
	chdbConfigFile: string | undefined,
	onDirtyStore: DirtyStorePolicy,
	minimumRawTelemetryRetentionDays: number | undefined,
	checkpointInterval: string,
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
			checkpointInterval,
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
				new BackgroundServerSpawnError({
					logPath,
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
		// missing the deadline is reported by the timeout error below, once.
		const up = yield* Effect.gen(function* () {
			for (let attempt = 1; attempt <= BACKGROUND_READY_ATTEMPTS; attempt++) {
				yield* Effect.sleep(`${BACKGROUND_READY_POLL_MS} millis`)
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
			yield* Effect.annotateCurrentSpan({ "maple.server.probe_attempt": BACKGROUND_READY_ATTEMPTS })
			return false
		}).pipe(Effect.withSpan("server.wait_ready", { attributes: { "server.address": probeAddr } }))
		if (!up) {
			return yield* new BackgroundServerTimeoutError({
				logPath,
				timeoutMs: BACKGROUND_READY_TIMEOUT_MS,
				message: `background server did not come up within ${BACKGROUND_READY_TIMEOUT_MS / 1000}s — check ${prettyPath(logPath)}`,
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
	checkpointInterval: checkpointIntervalFlag,
}).pipe(
	Command.withDescription("Start the local ingest + query server (embedded ClickHouse via chDB)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const fs = yield* FileSystem
			const dataDir = Option.getOrUndefined(a.dataDir) ?? defaultDataDir()
			const bindHost = yield* validatedHost("--host / MAPLE_LOCAL_BIND_HOST", a.host)
			// Rejected up front, before anything is opened: a typo that quietly fell
			// back to the default — or worse, to off — would reintroduce the data loss
			// the refresh loop exists to prevent.
			const checkpointInterval = parseCheckpointInterval(a.checkpointInterval)
			if (checkpointInterval === "invalid") {
				return yield* new ServerOptionError({
					source: "--checkpoint-interval",
					message:
						`invalid --checkpoint-interval: ${a.checkpointInterval} — ` +
						"expected a duration like 45s, 30m or 2h, or `off`",
				})
			}
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
			yield* reconcileCheckpointRecovery(dataDir)

			const migrationIncomplete = yield* Effect.tryPromise({
				try: () => localMigrationIsIncomplete(dataDir),
				catch: (error) =>
					new LocalStoreMigrationError({
						dataDir,
						phase: "read-journal",
						message: `cannot read the local migration journal: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
			if (migrationIncomplete && !a.reset) {
				return yield* new LocalStoreMigrationError({
					dataDir,
					phase: "resume",
					message:
						`the local store has an unfinished schema migration. ` +
						`Resume or inspect it with \`${bold("maple schema migrate --yes")}\`; ordinary startup remains fail-closed.`,
				})
			}
			if (migrationIncomplete) {
				yield* Effect.tryPromise({
					try: () => abandonLocalStoreMigration(dataDir),
					catch: (error) =>
						new LocalStoreMigrationError({
							dataDir,
							phase: "preserve",
							message: `could not preserve the unfinished migration before reset: ${error instanceof Error ? error.message : String(error)}`,
						}),
				})
			}

			// `--reset`: wipe the store (and its version marker) so we bootstrap fresh.
			// Preserve the checkpoint registry under dataDir/backups.
			if (a.reset) {
				yield* resetLiveStorePreservingCheckpoints(dataDir)
			}

			// Sampled HERE, not at the point of use: `ensureInitialCheckpoint` runs
			// after `startServer`, and by then chDB has bootstrapped its schema into
			// dataDir, so every store — including one created seconds ago — looks
			// like it holds data.
			const storeHadLiveData = yield* storeHasLiveData(fs, dataDir)

			yield* fs.makeDirectory(dataDir, { recursive: true })

			// Refuse to open a store written by an incompatible chDB build: re-loading
			// its persisted materialized views crashes the C++ runtime natively
			// (SIGTRAP), which we cannot catch. Fresh/matching stores pass through.
			const compat = checkStoreCompatible(dataDir)
			if (!compat.compatible) {
				return yield* new LocalStoreIncompatibleError({
					dataDir,
					storeBuild: compat.found,
					currentBuild: compat.current,
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
					return yield* new LocalStoreDirtyError({
						dataDir,
						policy: "fail",
						checkpointAvailable: availability.available,
						message:
							`the local store at ${prettyPath(dataDir)} was not cleanly closed. ` +
							dirtyStoreRecoveryAdvice(availability),
					})
				}
				if (a.onDirtyStore === "restore-checkpoint") {
					if (!availability.available) {
						return yield* new LocalStoreDirtyError({
							dataDir,
							policy: "restore-checkpoint",
							checkpointAvailable: false,
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
					const restored = yield* restoreCheckpoint(dataDir)
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
					yield* resetLiveStorePreservingCheckpoints(dataDir)
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
				return yield* new LocalStoreSchemaStaleError({
					dataDir,
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
					a.checkpointInterval,
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
					})
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

					// After the banner, never before it: the server is already listening
					// and the user has their URL. See `ensureInitialCheckpoint`.
					yield* ensureInitialCheckpoint(
						dataDir,
						connectionHostForBindHost(bindHost),
						boundPort,
						storeHadLiveData,
					)

					// Forked into the server's scope, so shutdown interrupts it with
					// everything else rather than leaving a BACKUP racing chDB's close.
					if (checkpointInterval !== undefined) {
						yield* Effect.forkChild(
							checkpointRefreshLoop(
								dataDir,
								connectionHostForBindHost(bindHost),
								boundPort,
								checkpointInterval,
							),
						)
					}

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
			return yield* new ServerStopTimeoutError({
				pid,
				timeoutMs: STOP_TIMEOUT_MS,
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
					new LocalStoreMigrationError({
						dataDir,
						phase: "preserve",
						message: `could not preserve the unfinished migration before reset: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
			yield* resetLiveStorePreservingCheckpoints(dataDir)
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
			})
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
				return yield* new CheckpointUnavailableError({
					dataDir,
					reason: availability.reason,
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
					new ServerOptionError({
						source: "--checkpoint-id",
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			const result = yield* restoreCheckpoint(dataDir, checkpointId)
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

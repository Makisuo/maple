export type DirtyStorePolicy = "wipe" | "fail" | "restore-checkpoint"

export {
	canonicalUrlHostname,
	connectionHostForBindHost,
	defaultLocalUrl,
	hostedDashboardUrl,
	hostedUiOrigin,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
	validateHost,
} from "../lib/local-address"

export interface DetachedChildArgs {
	readonly entry: string | undefined
	readonly host: string
	readonly advertiseHost: string
	readonly port: number
	readonly dataDir: string
	readonly offline: boolean
	readonly chdbConfigFile: string | undefined
	readonly onDirtyStore: DirtyStorePolicy
	readonly minimumRawTelemetryRetentionDays: number | undefined
	/** Raw `--checkpoint-interval` text, forwarded verbatim so the child parses
	 *  and validates it exactly as the parent did. */
	readonly checkpointInterval: string
}

/** Build the foreground child argv without forwarding compiled-Bun virtual
 * entrypoints or the background flag that caused the re-exec. */
export const buildDetachedChildArgs = (options: DetachedChildArgs): string[] => {
	const runtimeArgs = options.entry && !options.entry.startsWith("/$bunfs") ? [options.entry] : []
	return [
		...runtimeArgs,
		"start",
		"--host",
		options.host,
		"--advertise-host",
		options.advertiseHost,
		"--port",
		String(options.port),
		"--data-dir",
		options.dataDir,
		"--on-dirty-store",
		options.onDirtyStore,
		// Forwarded explicitly: the child re-parses its own flags, so omitting this
		// would silently drop the user's cadence — and `--checkpoint-interval off`
		// would come back as the default — on every `--background` start.
		"--checkpoint-interval",
		options.checkpointInterval,
		...(options.chdbConfigFile ? ["--chdb-config-file", options.chdbConfigFile] : []),
		...(options.minimumRawTelemetryRetentionDays !== undefined
			? ["--minimum-raw-telemetry-retention-days", String(options.minimumRawTelemetryRetentionDays)]
			: []),
		...(options.offline ? ["--offline"] : []),
	]
}

/**
 * Argv for a `maple checkpoint` CHILD process.
 *
 * A checkpoint cannot be taken inside the running server: `createCheckpoint`
 * opens its own chDB connection to drive `BACKUP DATABASE`, and chDB allows one
 * connection per process — the server already holds it, so an in-process
 * attempt gets `chdb_connect returned NULL` every time. `maple checkpoint` works
 * precisely because it is a separate process, so the server spawns exactly that,
 * which is also what a user running it by hand would do.
 *
 * `entry` follows the same rule as `buildDetachedChildArgs`: a Bun-compiled
 * binary injects a virtual `/$bunfs/...` entrypoint that must not be forwarded.
 */
export const buildCheckpointChildArgs = (options: {
	readonly entry: string | undefined
	readonly host: string
	readonly port: number
	readonly dataDir: string
}): string[] => [
	...(options.entry && !options.entry.startsWith("/$bunfs") ? [options.entry] : []),
	"checkpoint",
	"--host",
	options.host,
	"--port",
	String(options.port),
	"--data-dir",
	options.dataDir,
]

/** Liveness probe via signal 0 — a process primitive with no FileSystem
 *  equivalent. Never throws (errors mean "not alive").
 *
 *  A PID file naming *this* process is stale by definition: the previous server
 *  is the one that wrote it, so if its number is ours it has died and the OS
 *  reused the PID. In a container that is the common case, not the edge case —
 *  `maple start` is PID 1 on every restart, the file survives on the data
 *  volume, and `kill(1, 0)` always succeeds, so without this check a container
 *  whose server died once refuses to start forever ("already running (PID 1)").
 *  Non-positive PIDs are rejected for the same reason: `kill(0, 0)` and
 *  `kill(-n, 0)` signal process groups and "succeed" for a group that exists. */
export const isProcessAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

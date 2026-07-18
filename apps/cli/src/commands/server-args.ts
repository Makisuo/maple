export type DirtyStorePolicy = "wipe" | "fail" | "restore-checkpoint"

export {
	canonicalUrlHostname,
	connectionHostForBindHost,
	defaultLocalUrl,
	hostedDashboardUrl,
	hostedUiOrigin,
	normalizeHost,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
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
		...(options.chdbConfigFile ? ["--chdb-config-file", options.chdbConfigFile] : []),
		...(options.offline ? ["--offline"] : []),
	]
}

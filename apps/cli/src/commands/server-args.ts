export type DirtyStorePolicy = "wipe" | "fail" | "restore-checkpoint"

export const resolveBindHost = (environmentValue: string | undefined): string =>
	environmentValue?.trim() || "127.0.0.1"

const urlHost = (host: string): string =>
	host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host

export const serverUrl = (host: string, port: number): string => `http://${urlHost(host)}:${port}`

/** Wildcard bind addresses are not connection targets. Use their matching
 * loopback address for the detached child's readiness probe. */
export const serverProbeUrl = (host: string, port: number): string =>
	serverUrl(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port)

export interface DetachedChildArgs {
	readonly entry: string | undefined
	readonly host: string
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

import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface DurabilityFaults {
	readonly beforeFileSync?: (path: string) => void | Promise<void>
	readonly beforeRename?: (from: string, to: string) => void | Promise<void>
	readonly beforeDirectorySync?: (path: string) => void | Promise<void>
	readonly beforeRemove?: (path: string) => void | Promise<void>
	readonly afterRetirementIntent?: (path: string) => void | Promise<void>
	readonly afterRetirementRename?: (path: string) => void | Promise<void>
	readonly afterRetiredSnapshotRemoval?: (path: string) => void | Promise<void>
	readonly afterRetirementComplete?: (path: string) => void | Promise<void>
	readonly afterRetirementCleanupRename?: (path: string) => void | Promise<void>
	readonly afterRetirementCleanupRemoval?: (path: string) => void | Promise<void>
	readonly afterCompletedOperationPreserved?: (path: string) => void | Promise<void>
}

// APFS and the target Linux filesystems support directory fsync. Keep the
// fallback deliberately narrow for filesystems that explicitly report that
// the operation is unsupported; descriptor/type errors are programming bugs.
const unsupportedDirectorySyncCodes = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])

export const isUnsupportedDirectorySyncError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	unsupportedDirectorySyncCodes.has(String((error as NodeJS.ErrnoException).code))

export const ensurePrivateDirectory = async (path: string): Promise<void> => {
	const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null
		throw error
	})
	if (before?.isSymbolicLink()) throw new Error(`refusing symlink directory: ${path}`)
	if (before && !before.isDirectory()) throw new Error(`refusing non-directory path: ${path}`)
	await mkdir(path, { recursive: true, mode: 0o700 })
	const after = await lstat(path)
	if (after.isSymbolicLink() || !after.isDirectory()) {
		throw new Error(`private directory is not a real directory: ${path}`)
	}
	await chmod(path, 0o700)
}

export const syncDirectory = async (path: string, faults: DurabilityFaults = {}): Promise<void> => {
	await faults.beforeDirectorySync?.(path)
	let handle
	try {
		handle = await open(path, constants.O_RDONLY)
		await handle.sync()
	} catch (error) {
		if (!isUnsupportedDirectorySyncError(error)) throw error
	} finally {
		await handle?.close()
	}
}

export const durableWrite = async (
	path: string,
	bytes: string | Uint8Array,
	faults: DurabilityFaults = {},
): Promise<void> => {
	const parent = dirname(path)
	await ensurePrivateDirectory(parent)
	const temporary = join(parent, `.${randomUUID()}.tmp`)
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
	try {
		await handle.writeFile(bytes)
		await faults.beforeFileSync?.(path)
		await handle.sync()
	} catch (error) {
		await handle.close().catch(() => undefined)
		await rm(temporary, { force: true }).catch(() => undefined)
		throw error
	}
	await handle.close()
	try {
		await faults.beforeRename?.(temporary, path)
		await rename(temporary, path)
		await syncDirectory(parent, faults)
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined)
		throw error
	}
}

export const durableJson = async (
	path: string,
	value: unknown,
	faults: DurabilityFaults = {},
): Promise<void> => durableWrite(path, `${JSON.stringify(value, null, 2)}\n`, faults)

export const durableRemove = async (path: string, faults: DurabilityFaults = {}): Promise<void> => {
	await faults.beforeRemove?.(path)
	await rm(path, { force: true })
	await syncDirectory(dirname(path), faults)
}

export const durableRename = async (
	from: string,
	to: string,
	faults: DurabilityFaults = {},
): Promise<void> => {
	await faults.beforeRename?.(from, to)
	await rename(from, to)
	await syncDirectory(dirname(from), faults)
	if (dirname(to) !== dirname(from)) await syncDirectory(dirname(to), faults)
}

export const syncTree = async (
	path: string,
	options: { readonly allowSymlinks?: boolean } = {},
): Promise<void> => {
	const entries = await readdir(path, { withFileTypes: true })
	for (const entry of entries) {
		const child = join(path, entry.name)
		if (entry.isDirectory()) {
			await syncTree(child, options)
		} else if (entry.isFile()) {
			const handle = await open(child, constants.O_RDONLY)
			try {
				await handle.sync()
			} finally {
				await handle.close()
			}
		} else if (entry.isSymbolicLink() && options.allowSymlinks) {
			// A closed chDB store contains engine-managed symlinks. Do not
			// follow them; syncing this directory below durably records the link.
			continue
		} else {
			throw new Error(`refusing to sync non-file checkpoint entry at ${child}`)
		}
	}
	await syncDirectory(path)
}

import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cp, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { CHDB_VERSION, MAPLE_VERSION } from "../version"
import { Chdb } from "./chdb"
import {
	type DurabilityFaults,
	durableJson,
	durableRemove,
	durableRename,
	ensurePrivateDirectory,
	syncDirectory,
	syncTree,
} from "./durable-files"
import { SCHEMA_FINGERPRINT } from "./serve"
import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import {
	markStoreClosedDurable,
	storeMarkerPath,
	storeOpenMarkerPath,
	writeStoreMarkerDurable,
} from "./store-version"

const STATE_FORMAT_VERSION = 1
const MANIFEST_FORMAT_VERSION = 1
const OPERATION_FORMAT_VERSION = 1
const RESTORE_TRANSACTION_FORMAT_VERSION = 1
const RESET_TRANSACTION_FORMAT_VERSION = 1
const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESETTABLE_CHDB_ENTRIES = new Set(["data", "metadata", "store", "tmp"])

export class CheckpointError extends Schema.TaggedErrorClass<CheckpointError>()(
	"@maple/cli/CheckpointError",
	{ message: Schema.String },
) {}

export interface CheckpointOptions {
	readonly dataDir: string
	readonly port: number
	readonly faults?: DurabilityFaults
}

export interface CheckpointValidation {
	readonly validatedAt: string
	readonly traces: number
	readonly logs: number
	readonly metricsSum: number
	readonly metricsGauge: number
	readonly metricsHistogram: number
	readonly metricsExponentialHistogram: number
	readonly materializedViews: number
}

export interface CheckpointManifest {
	readonly formatVersion: 1
	readonly checkpointId: string
	readonly operationId: string
	readonly mapleVersion: string
	readonly chdbVersion: string
	readonly schemaFingerprint: string
	readonly createdAt: string
	readonly sourceDataDir: string
	readonly backupRelativePath: string
	readonly backupBytes: number
	readonly validation: CheckpointValidation
}

export interface CheckpointState {
	readonly formatVersion: 1
	readonly revision: string
	readonly current: string
	readonly previous: string | null
	readonly committedAt: string
}

export interface ResolvedCheckpoint {
	readonly checkpointId: string
	readonly snapshotDir: string
	readonly backupDir: string
	readonly backupSqlPath: string
	readonly manifest: CheckpointManifest
}

interface CheckpointOperation {
	readonly formatVersion: 1
	readonly operationId: string
	readonly checkpointId: string
	readonly baseRevision: string | null
	readonly baseCurrent: string | null
	readonly basePrevious: string | null
	readonly phase:
		| "intent"
		| "backup-complete"
		| "manifest-complete"
		| "pointer-complete"
		| "retention-complete"
	readonly startedAt: string
}

interface MaintenanceOwner {
	readonly formatVersion: 1
	readonly operationId: string
	readonly pid: number
	readonly startedAt: string
}

interface RestoreTransaction {
	readonly formatVersion: 1
	readonly operationId: string
	readonly checkpointId: string
	readonly quarantineId: string
	readonly phase: "intent" | "restore-ready" | "old-quarantined" | "new-live" | "markers-committed"
	readonly createdAt: string
	readonly validation: CheckpointValidation | null
}

interface ResetTransaction {
	readonly formatVersion: 1
	readonly operationId: string
	readonly dataDir: string
	readonly targets: ReadonlyArray<string>
	readonly phase: "intent" | "live-cleared" | "markers-cleared"
	readonly createdAt: string
}

export interface RestoreRecoveryFaults {
	readonly afterLiveQuarantineRename?: () => void | Promise<void>
	readonly afterOldQuarantinedRecord?: () => void | Promise<void>
	readonly afterRestoredLiveRename?: () => void | Promise<void>
	readonly afterNewLiveRecord?: () => void | Promise<void>
	readonly afterStoreMarkerWrite?: () => void | Promise<void>
	readonly afterOpenMarkerRemoval?: () => void | Promise<void>
	readonly afterMarkersCommittedRecord?: () => void | Promise<void>
	readonly afterReadyMarkerRemoval?: () => void | Promise<void>
	readonly afterRestoreRootRemoval?: () => void | Promise<void>
	readonly afterResetIntent?: () => void | Promise<void>
	readonly afterResetEntryRemoval?: (entry: string) => void | Promise<void>
	readonly afterResetLiveClearedRecord?: () => void | Promise<void>
	readonly afterResetStoreMarkerRemoval?: () => void | Promise<void>
	readonly afterResetOpenMarkerRemoval?: () => void | Promise<void>
	readonly afterResetMarkersClearedRecord?: () => void | Promise<void>
	readonly afterResetTransactionRemoval?: () => void | Promise<void>
}

export const checkpointRoot = (dataDir: string): string => join(resolve(dataDir), "backups")
export const checkpointStatePath = (dataDir: string): string => join(checkpointRoot(dataDir), "state.json")
export const checkpointSnapshotsRoot = (dataDir: string): string => join(checkpointRoot(dataDir), "snapshots")
export const checkpointOperationsRoot = (dataDir: string): string =>
	join(checkpointRoot(dataDir), "operations")
export const checkpointPinsRoot = (dataDir: string): string => join(checkpointRoot(dataDir), "pins")
export const checkpointQuarantineRoot = (dataDir: string): string =>
	join(checkpointRoot(dataDir), "quarantine")
export const checkpointRetiringRoot = (dataDir: string): string => join(checkpointRoot(dataDir), "retiring")
export const checkpointSnapshotDir = (dataDir: string, checkpointId: string): string =>
	join(checkpointSnapshotsRoot(dataDir), validateId(checkpointId, "checkpoint"))

const maintenanceLockPath = (dataDir: string): string => `${resolve(dataDir)}.maple-maintenance-lock`
export const restoreTransactionPath = (dataDir: string): string =>
	`${resolve(dataDir)}.restore-transaction.json`
export const resetTransactionPath = (dataDir: string): string => `${resolve(dataDir)}.reset-transaction.json`
export const restoreRootPath = (dataDir: string, operationId: string): string =>
	`${resolve(dataDir)}.restore-${validateId(operationId, "restore operation")}`
export const restoreDataPath = (dataDir: string, operationId: string): string =>
	join(restoreRootPath(dataDir, operationId), "data")
export const restoreQuarantinePath = (dataDir: string, operationId: string, quarantineId: string): string =>
	`${resolve(dataDir)}.quarantine-${validateId(operationId, "restore operation")}-${validateId(
		quarantineId,
		"quarantine",
	)}`
const operationDir = (dataDir: string, operationId: string): string =>
	join(checkpointOperationsRoot(dataDir), `checkpoint-${validateId(operationId, "operation")}`)
const operationPath = (dataDir: string, operationId: string): string =>
	join(operationDir(dataDir, operationId), "intent.json")
const snapshotManifestPath = (dataDir: string, checkpointId: string): string =>
	join(checkpointSnapshotDir(dataDir, checkpointId), "manifest.json")
const snapshotBackupDir = (dataDir: string, checkpointId: string): string =>
	join(checkpointSnapshotDir(dataDir, checkpointId), "backup")
const snapshotBackupRelativePath = (checkpointId: string): string =>
	`snapshots/${validateId(checkpointId, "checkpoint")}/backup`
const snapshotBackupSqlPath = (checkpointId: string): string =>
	`backups/${snapshotBackupRelativePath(checkpointId)}`

const validateId = (value: string, kind: string): string => {
	if (!CHECKPOINT_ID.test(value)) throw new Error(`invalid ${kind} ID: ${value}`)
	return value.toLowerCase()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const requiredString = (record: Record<string, unknown>, key: string): string => {
	const value = record[key]
	if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`)
	return value
}

const requiredCount = (record: Record<string, unknown>, key: string): number => {
	const value = record[key]
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid ${key}`)
	}
	return value
}

const requiredIso = (record: Record<string, unknown>, key: string): string => {
	const value = requiredString(record, key)
	if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid ${key}`)
	return value
}

const assertContained = (root: string, candidate: string, label: string): string => {
	const absoluteRoot = resolve(root)
	const absoluteCandidate = resolve(candidate)
	const rel = relative(absoluteRoot, absoluteCandidate)
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`${label} escapes configured root`)
	}
	return absoluteCandidate
}

const assertNoSymlink = async (root: string, candidate: string): Promise<void> => {
	const absoluteRoot = resolve(root)
	const absoluteCandidate = assertContained(absoluteRoot, candidate, "checkpoint path")
	try {
		if ((await lstat(absoluteRoot)).isSymbolicLink()) {
			throw new Error(`refusing symlink checkpoint root: ${absoluteRoot}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const rel = relative(absoluteRoot, absoluteCandidate)
	let current = absoluteRoot
	for (const part of rel.split(sep)) {
		current = join(current, part)
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error(`refusing symlink in checkpoint path: ${current}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return
		}
	}
}

const assertRealDirectory = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`${label} must be a real directory: ${path}`)
	}
}

const assertRealFile = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error(`${label} must be a real file: ${path}`)
	}
}

const assertCheckpointInfrastructureSafe = async (dataDir: string): Promise<void> => {
	const live = resolve(dataDir)
	if (existsSync(live)) await assertRealDirectory(live, "live data directory")
	const root = checkpointRoot(dataDir)
	if (!existsSync(root)) return
	await assertRealDirectory(root, "checkpoint root")
	for (const child of ["snapshots", "operations", "pins", "quarantine", "retiring"]) {
		const path = join(root, child)
		if (existsSync(path)) await assertRealDirectory(path, `checkpoint ${child}`)
	}
	const statePath = checkpointStatePath(dataDir)
	if (existsSync(statePath)) await assertRealFile(statePath, "checkpoint state")
}

const xmlEscape = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")

const dataDirWithSlash = (dataDir: string): string => {
	const abs = resolve(dataDir)
	return abs.endsWith(sep) ? abs : `${abs}${sep}`
}

export const writeBackupConfig = (path: string, sourceDataDir?: string): void => {
	const sourceDisk = sourceDataDir
		? `
  <storage_configuration>
    <disks>
      <src>
        <path>${xmlEscape(dataDirWithSlash(sourceDataDir))}</path>
      </src>
    </disks>
  </storage_configuration>`
		: ""
	writeFileSync(
		path,
		`<clickhouse>
  <backups>
    <allowed_disk>${sourceDataDir ? "src" : "default"}</allowed_disk>
    <allowed_path>backups</allowed_path>
  </backups>${sourceDisk}
</clickhouse>
`,
		{ mode: 0o600 },
	)
}

export class LocalQueryError extends Error {
	readonly status: number
	readonly detail: string

	constructor(status: number, detail: string) {
		super(`local query failed (${status})${detail ? `: ${detail}` : ""}`)
		this.name = "LocalQueryError"
		this.status = status
		this.detail = detail
	}
}

const postLocalQuery = async (port: number, sql: string): Promise<unknown> => {
	const response = await fetch(`http://127.0.0.1:${port}/local/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql }),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new LocalQueryError(response.status, detail)
	}
	return response.json()
}

export const isMissingBackupConfigurationError = (error: unknown): boolean => {
	const detail =
		error instanceof LocalQueryError
			? error.detail
			: error instanceof Error
				? error.message
				: String(error)
	const lower = detail.toLowerCase()
	const backupSpecific =
		lower.includes("backups.allowed_disk") ||
		lower.includes("backups.allowed_path") ||
		(lower.includes("backup") &&
			(lower.includes("not allowed") ||
				lower.includes("unknown disk") ||
				lower.includes("allowed disk")))
	return backupSpecific
}

const readJsonRows = (text: string): ReadonlyArray<Record<string, unknown>> =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)

const countFrom = (rows: ReadonlyArray<Record<string, unknown>>): number => {
	const row = rows[0]
	if (!row) return 0
	const value = row["count()"] ?? row.count
	const count = typeof value === "number" ? value : Number(value ?? 0)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid count result: ${value}`)
	return count
}

const queryCount = (db: Chdb, sql: string): number => countFrom(readJsonRows(db.query(sql)))

const validateRestoredDatabase = (db: Chdb): CheckpointValidation => ({
	validatedAt: new Date().toISOString(),
	traces: queryCount(db, "SELECT count() FROM traces"),
	logs: queryCount(db, "SELECT count() FROM logs"),
	metricsSum: queryCount(db, "SELECT count() FROM metrics_sum"),
	metricsGauge: queryCount(db, "SELECT count() FROM metrics_gauge"),
	metricsHistogram: queryCount(db, "SELECT count() FROM metrics_histogram"),
	metricsExponentialHistogram: queryCount(db, "SELECT count() FROM metrics_exponential_histogram"),
	materializedViews: queryCount(
		db,
		"SELECT count() FROM system.tables WHERE database = 'default' AND engine = 'MaterializedView'",
	),
})

const dirSize = async (path: string): Promise<number> => {
	let total = 0
	const entries = await readdir(path, { withFileTypes: true })
	for (const entry of entries) {
		const child = join(path, entry.name)
		if (entry.isSymbolicLink()) throw new Error(`refusing symlink in checkpoint backup: ${child}`)
		if (entry.isDirectory()) total += await dirSize(child)
		else if (entry.isFile()) total += (await stat(child)).size
		else throw new Error(`refusing unsupported checkpoint entry: ${child}`)
	}
	return total
}

const parseValidation = (value: unknown): CheckpointValidation => {
	if (!isRecord(value)) throw new Error("invalid validation")
	return {
		validatedAt: requiredIso(value, "validatedAt"),
		traces: requiredCount(value, "traces"),
		logs: requiredCount(value, "logs"),
		metricsSum: requiredCount(value, "metricsSum"),
		metricsGauge: requiredCount(value, "metricsGauge"),
		metricsHistogram: requiredCount(value, "metricsHistogram"),
		metricsExponentialHistogram: requiredCount(value, "metricsExponentialHistogram"),
		materializedViews: requiredCount(value, "materializedViews"),
	}
}

export const parseCheckpointManifest = (
	value: unknown,
	expectedCheckpointId?: string,
	expectedSourceDataDir?: string,
): CheckpointManifest => {
	if (!isRecord(value) || value.formatVersion !== MANIFEST_FORMAT_VERSION) {
		throw new Error("unsupported or malformed checkpoint manifest")
	}
	const checkpointId = validateId(requiredString(value, "checkpointId"), "checkpoint")
	if (expectedCheckpointId && checkpointId !== validateId(expectedCheckpointId, "checkpoint")) {
		throw new Error("checkpoint manifest ID does not match its snapshot directory")
	}
	const operationId = validateId(requiredString(value, "operationId"), "operation")
	const sourceDataDir = requiredString(value, "sourceDataDir")
	if (!isAbsolute(sourceDataDir)) throw new Error("checkpoint sourceDataDir must be absolute")
	if (expectedSourceDataDir && resolve(sourceDataDir) !== resolve(expectedSourceDataDir)) {
		throw new Error("checkpoint sourceDataDir does not match its configured owner")
	}
	const backupRelativePath = requiredString(value, "backupRelativePath")
	if (backupRelativePath !== snapshotBackupRelativePath(checkpointId)) {
		throw new Error("checkpoint backup path does not match its immutable ID")
	}
	const manifest: CheckpointManifest = {
		formatVersion: 1,
		checkpointId,
		operationId,
		mapleVersion: requiredString(value, "mapleVersion"),
		chdbVersion: requiredString(value, "chdbVersion"),
		schemaFingerprint: requiredString(value, "schemaFingerprint"),
		createdAt: requiredIso(value, "createdAt"),
		sourceDataDir,
		backupRelativePath,
		backupBytes: requiredCount(value, "backupBytes"),
		validation: parseValidation(value.validation),
	}
	if (manifest.chdbVersion !== CHDB_VERSION) {
		throw new Error(
			`checkpoint chDB version mismatch (checkpoint: ${manifest.chdbVersion}; build: ${CHDB_VERSION})`,
		)
	}
	if (manifest.schemaFingerprint !== SCHEMA_FINGERPRINT) {
		throw new Error(
			`checkpoint schema mismatch (checkpoint: ${manifest.schemaFingerprint}; build: ${SCHEMA_FINGERPRINT})`,
		)
	}
	return manifest
}

export const parseCheckpointState = (value: unknown): CheckpointState => {
	if (!isRecord(value) || value.formatVersion !== STATE_FORMAT_VERSION) {
		throw new Error("unsupported or malformed checkpoint state")
	}
	const current = validateId(requiredString(value, "current"), "current checkpoint")
	const previousValue = value.previous
	const previous =
		previousValue === null
			? null
			: validateId(
					typeof previousValue === "string"
						? previousValue
						: (() => {
								throw new Error("invalid previous checkpoint")
							})(),
					"previous checkpoint",
				)
	if (previous === current) throw new Error("checkpoint current and previous IDs must differ")
	return {
		formatVersion: 1,
		revision: validateId(requiredString(value, "revision"), "state revision"),
		current,
		previous,
		committedAt: requiredIso(value, "committedAt"),
	}
}

const readStateFileOptional = async (dataDir: string): Promise<CheckpointState | null> => {
	try {
		await assertCheckpointInfrastructureSafe(dataDir)
		return parseCheckpointState(JSON.parse(await readFile(checkpointStatePath(dataDir), "utf8")))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

const checkpointLikePaths = async (dataDir: string): Promise<string[]> => {
	const root = checkpointRoot(dataDir)
	try {
		const entries = await readdir(root, { withFileTypes: true })
		const unsafe: string[] = []
		for (const entry of entries) {
			if (entry.name === "state.json" || entry.name === "quarantine") continue
			const path = join(root, entry.name)
			if (["snapshots", "operations", "pins", "retiring"].includes(entry.name)) {
				if (!entry.isDirectory() || (await readdir(path)).length > 0) unsafe.push(path)
				continue
			}
			unsafe.push(path)
		}
		return unsafe
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

const assertNoLegacyLayout = (dataDir: string): void => {
	const legacy = ["building", "current", "previous"]
		.map((name) => join(checkpointRoot(dataDir), name))
		.filter(existsSync)
	if (legacy.length > 0) {
		throw new Error(
			`legacy preview checkpoint layout detected; refusing to infer or migrate state. Preserve and move aside after inspection: ${legacy.join(", ")}`,
		)
	}
}

export const readCheckpointState = async (dataDir: string): Promise<CheckpointState> => {
	assertNoLegacyLayout(dataDir)
	const state = await readStateFileOptional(dataDir)
	if (!state) {
		const paths = await checkpointLikePaths(dataDir)
		throw new Error(
			paths.length === 0
				? `checkpoint state not found at ${checkpointStatePath(dataDir)}`
				: `checkpoint state missing while checkpoint data exists; refusing to infer selection: ${paths.join(", ")}`,
		)
	}
	await resolveCheckpoint(dataDir, state.current, state)
	if (state.previous) await resolveCheckpoint(dataDir, state.previous, state)
	return state
}

const resolveCheckpointById = async (dataDir: string, checkpointId: string): Promise<ResolvedCheckpoint> => {
	await assertCheckpointInfrastructureSafe(dataDir)
	const validatedCheckpointId = validateId(checkpointId, "checkpoint")
	const snapshotDir = checkpointSnapshotDir(dataDir, validatedCheckpointId)
	const snapshotsRoot = checkpointSnapshotsRoot(dataDir)
	await assertNoSymlink(checkpointRoot(dataDir), snapshotsRoot)
	await assertNoSymlink(snapshotsRoot, snapshotDir)
	await assertNoSymlink(snapshotsRoot, snapshotManifestPath(dataDir, validatedCheckpointId))
	await assertNoSymlink(snapshotsRoot, snapshotBackupDir(dataDir, validatedCheckpointId))
	await assertRealDirectory(snapshotDir, "checkpoint snapshot")
	await assertRealFile(snapshotManifestPath(dataDir, validatedCheckpointId), "checkpoint manifest")
	const manifest = parseCheckpointManifest(
		JSON.parse(await readFile(snapshotManifestPath(dataDir, validatedCheckpointId), "utf8")),
		validatedCheckpointId,
		dataDir,
	)
	const backupDir = snapshotBackupDir(dataDir, validatedCheckpointId)
	await assertRealDirectory(backupDir, "checkpoint backup")
	const actualBackupBytes = await dirSize(backupDir)
	if (actualBackupBytes !== manifest.backupBytes) {
		throw new Error(
			`checkpoint backup size mismatch (manifest: ${manifest.backupBytes}; actual: ${actualBackupBytes})`,
		)
	}
	return {
		checkpointId: validatedCheckpointId,
		snapshotDir,
		backupDir,
		backupSqlPath: snapshotBackupSqlPath(validatedCheckpointId),
		manifest,
	}
}

export const resolveCheckpoint = async (
	dataDir: string,
	selector: "current" | "previous" | string = "current",
	knownState?: CheckpointState,
): Promise<ResolvedCheckpoint> => {
	const state = knownState ?? (await readCheckpointState(dataDir))
	const checkpointId =
		selector === "current"
			? state.current
			: selector === "previous"
				? state.previous
				: validateId(selector, "checkpoint")
	if (!checkpointId) throw new Error("no previous checkpoint is selected")
	return resolveCheckpointById(dataDir, checkpointId)
}

export const readCheckpointManifest = async (
	dataDir: string,
	selector: "current" | "previous" | string = "current",
): Promise<CheckpointManifest> => (await resolveCheckpoint(dataDir, selector)).manifest

const restoreResolvedInto = async (
	resolvedCheckpoint: ResolvedCheckpoint,
	targetDataDir: string,
): Promise<{ readonly db: Chdb; readonly validation: CheckpointValidation }> => {
	const scratchParent = dirname(targetDataDir)
	const scratchConfig = join(scratchParent, `checkpoint-${randomUUID()}.xml`)
	writeBackupConfig(scratchConfig, resolvedCheckpoint.manifest.sourceDataDir)
	let db: Chdb | undefined
	try {
		db = Chdb.open({
			dataDir: targetDataDir,
			schemaSql,
			configFile: scratchConfig,
			bootstrapSchema: false,
		})
		db.exec("CREATE DATABASE IF NOT EXISTS default")
		db.exec(
			`RESTORE DATABASE default FROM Disk('src', '${resolvedCheckpoint.backupSqlPath}') ` +
				"SETTINGS allow_different_database_def=1",
		)
		return { db, validation: validateRestoredDatabase(db) }
	} catch (error) {
		db?.close()
		throw error
	} finally {
		rmSync(scratchConfig, { force: true })
	}
}

export const withRestoredCheckpoint = async <A>(
	resolvedCheckpoint: ResolvedCheckpoint,
	options: {
		readonly scratchRoot?: string
		readonly cleanup?: "always" | "never"
		/**
		 * A caller-supplied deterministic subdirectory name beneath scratchRoot,
		 * instead of the default random `maple-checkpoint-<uuid>`. Used by the
		 * archive generation journal so an interrupted operation records the exact
		 * scratch path it owns and reconciliation can remove only that path.
		 * Must be a single path segment (no separators) and not already in use.
		 */
		readonly scratchSubdir?: string
		/**
		 * Invoked after the owned scratch directory is created (and synced) but
		 * BEFORE the checkpoint is restored into it. Used by the archive journal
		 * to advance its phase to "scratch-allocated" so a kill during restore is
		 * reconcilable. No-op for non-archive callers.
		 */
		readonly beforeRestore?: (scratchDataDir: string) => void | Promise<void>
	},
	use: (restored: {
		readonly checkpointId: string
		readonly manifest: CheckpointManifest
		readonly scratchDataDir: string
		readonly db: Chdb
		readonly validation: CheckpointValidation
	}) => A | Promise<A>,
): Promise<A> => {
	const scratchRoot = resolve(options.scratchRoot ?? tmpdir())
	const sourceDataDir = resolve(resolvedCheckpoint.manifest.sourceDataDir)
	const sourceRelation = relative(sourceDataDir, scratchRoot)
	if (
		scratchRoot === sourceDataDir ||
		(sourceRelation !== "" && sourceRelation !== ".." && !sourceRelation.startsWith(`..${sep}`))
	) {
		throw new Error("scratch root must not be the live data directory or one of its descendants")
	}
	if (existsSync(scratchRoot) && (await lstat(scratchRoot)).isSymbolicLink()) {
		throw new Error(`scratch root must not be a symlink: ${scratchRoot}`)
	}
	await mkdir(scratchRoot, { recursive: true })
	const scratchParentName = options.scratchSubdir ?? `maple-checkpoint-${randomUUID()}`
	// A deterministic scratchSubdir (archive journal) must be a single path
	// segment so it cannot escape the scratch root, and must not already exist so
	// reuse after a crash is unambiguous (the caller reconciles the prior op
	// before allocating a new one).
	if (options.scratchSubdir !== undefined) {
		if (
			scratchParentName.length === 0 ||
			scratchParentName.includes(sep) ||
			scratchParentName.includes("/") ||
			scratchParentName === "." ||
			scratchParentName === ".."
		) {
			throw new Error(`invalid scratch subdirectory: ${scratchParentName}`)
		}
	}
	const scratchParent = join(scratchRoot, scratchParentName)
	await mkdir(scratchParent, { mode: 0o700 })
	const scratchDataDir = join(scratchParent, "data")
	let db: Chdb | undefined
	try {
		// The owned scratch dir now exists. Give the caller (archive journal) a
		// seam to durably record that fact BEFORE the restore begins, so a kill
		// mid-restore leaves a reconcilable "scratch-allocated" phase.
		if (options.beforeRestore) await options.beforeRestore(scratchDataDir)
		const restored = await restoreResolvedInto(resolvedCheckpoint, scratchDataDir)
		db = restored.db
		return await use({
			checkpointId: resolvedCheckpoint.checkpointId,
			manifest: resolvedCheckpoint.manifest,
			scratchDataDir,
			db,
			validation: restored.validation,
		})
	} finally {
		db?.close()
		if (options.cleanup !== "never") await rm(scratchParent, { recursive: true, force: true })
	}
}

const parseOperation = (value: unknown): CheckpointOperation => {
	if (!isRecord(value) || value.formatVersion !== OPERATION_FORMAT_VERSION) {
		throw new Error("unsupported or malformed checkpoint operation")
	}
	const phase = requiredString(value, "phase")
	if (
		![
			"intent",
			"backup-complete",
			"manifest-complete",
			"pointer-complete",
			"retention-complete",
		].includes(phase)
	) {
		throw new Error("invalid checkpoint operation phase")
	}
	const baseRevision =
		value.baseRevision === null
			? null
			: validateId(requiredString(value, "baseRevision"), "base state revision")
	const baseCurrent =
		value.baseCurrent === null
			? null
			: validateId(requiredString(value, "baseCurrent"), "base current checkpoint")
	const basePrevious =
		value.basePrevious === null
			? null
			: validateId(requiredString(value, "basePrevious"), "base previous checkpoint")
	if ((baseRevision === null) !== (baseCurrent === null)) {
		throw new Error("checkpoint operation has an inconsistent base state")
	}
	if (baseCurrent === null && basePrevious !== null) {
		throw new Error("checkpoint operation cannot have a previous checkpoint without a current checkpoint")
	}
	if (baseCurrent !== null && baseCurrent === basePrevious) {
		throw new Error("checkpoint operation base current and previous must differ")
	}
	return {
		formatVersion: 1,
		operationId: validateId(requiredString(value, "operationId"), "operation"),
		checkpointId: validateId(requiredString(value, "checkpointId"), "checkpoint"),
		baseRevision,
		baseCurrent,
		basePrevious,
		phase: phase as CheckpointOperation["phase"],
		startedAt: requiredIso(value, "startedAt"),
	}
}

const writeOperation = async (
	dataDir: string,
	operation: CheckpointOperation,
	faults: DurabilityFaults = {},
): Promise<void> => durableJson(operationPath(dataDir, operation.operationId), operation, faults)

const preserveCompletedOperation = async (
	dataDir: string,
	operationDirPath: string,
	operationId: string,
	faults: DurabilityFaults = {},
): Promise<void> => {
	const quarantineRoot = checkpointQuarantineRoot(dataDir)
	if (existsSync(quarantineRoot)) {
		await assertNoSymlink(checkpointRoot(dataDir), quarantineRoot)
		await assertRealDirectory(quarantineRoot, "checkpoint quarantine")
	}
	await ensurePrivateDirectory(quarantineRoot)
	const preserved = join(
		quarantineRoot,
		`completed-operation-${validateId(operationId, "operation")}-${randomUUID()}`,
	)
	await durableRename(operationDirPath, preserved, faults)
	await faults.afterCompletedOperationPreserved?.(preserved)
}

const processIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

const acquireMaintenance = async (dataDir: string, operationId: string): Promise<() => Promise<void>> => {
	const lockPath = maintenanceLockPath(dataDir)
	if (existsSync(lockPath)) await assertRealDirectory(lockPath, "maintenance lock")
	try {
		await mkdir(lockPath, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		let owner: MaintenanceOwner
		try {
			const ownerPath = join(lockPath, "owner.json")
			await assertRealFile(ownerPath, "maintenance lock owner")
			const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown
			if (!isRecord(parsed) || parsed.formatVersion !== 1) throw new Error("malformed owner")
			owner = {
				formatVersion: 1,
				operationId: validateId(requiredString(parsed, "operationId"), "operation"),
				pid: requiredCount(parsed, "pid"),
				startedAt: requiredIso(parsed, "startedAt"),
			}
		} catch {
			throw new Error(`maintenance lock is present but ownership is uncertain: ${lockPath}`)
		}
		if (processIsAlive(owner.pid)) {
			throw new Error(`another Maple maintenance operation is active (PID ${owner.pid})`)
		}
		const quarantinedLock = `${lockPath}.quarantine-${randomUUID()}`
		await durableRename(lockPath, quarantinedLock)
		await mkdir(lockPath, { mode: 0o700 })
	}
	const owner: MaintenanceOwner = {
		formatVersion: 1,
		operationId,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	}
	await durableJson(join(lockPath, "owner.json"), owner)
	return async () => {
		const ownerPath = join(lockPath, "owner.json")
		await assertRealFile(ownerPath, "maintenance lock owner")
		const current = JSON.parse(await readFile(ownerPath, "utf8")) as unknown
		if (
			!isRecord(current) ||
			requiredString(current, "operationId") !== operationId ||
			current.pid !== process.pid
		) {
			throw new Error(`maintenance lock ownership changed unexpectedly: ${lockPath}`)
		}
		await rm(lockPath, { recursive: true })
		await syncDirectory(dirname(lockPath))
	}
}

export const reconcileCheckpointOperations = async (
	dataDir: string,
	faults: DurabilityFaults = {},
): Promise<void> => {
	await assertCheckpointInfrastructureSafe(dataDir)
	const state = await readStateFileOptional(dataDir)
	const operationsRoot = checkpointOperationsRoot(dataDir)
	if (existsSync(operationsRoot)) {
		await assertNoSymlink(checkpointRoot(dataDir), operationsRoot)
		await assertRealDirectory(operationsRoot, "checkpoint operations")
	}
	let entries
	try {
		entries = await readdir(operationsRoot, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	if (entries.length === 0) return
	if (entries.length !== 1) {
		throw new Error(
			`multiple checkpoint operations require operator inspection: ${entries
				.map((entry) => join(operationsRoot, entry.name))
				.join(", ")}`,
		)
	}
	const entry = entries[0]!
	if (!entry.isDirectory() || !entry.name.startsWith("checkpoint-")) {
		throw new Error(`unrecognized checkpoint operation debris: ${join(operationsRoot, entry.name)}`)
	}
	const entryOperationId = validateId(entry.name.slice("checkpoint-".length), "operation directory")
	const entryDir = join(operationsRoot, entry.name)
	const intentPath = join(entryDir, "intent.json")
	await assertNoSymlink(operationsRoot, entryDir)
	await assertNoSymlink(operationsRoot, intentPath)
	await assertRealDirectory(entryDir, "checkpoint operation")
	await assertRealFile(intentPath, "checkpoint operation intent")
	const operation = parseOperation(JSON.parse(await readFile(intentPath, "utf8")))
	if (operation.operationId !== entryOperationId) {
		throw new Error(
			`checkpoint operation identity mismatch (directory: ${entryOperationId}; intent: ${operation.operationId})`,
		)
	}

	const baseMatches =
		operation.baseRevision === null
			? state === null
			: state !== null &&
				state.revision === operation.baseRevision &&
				state.current === operation.baseCurrent &&
				state.previous === operation.basePrevious
	const expectedMatches =
		state !== null &&
		state.revision === operation.operationId &&
		state.current === operation.checkpointId &&
		state.previous === operation.baseCurrent
	const snapshot = checkpointSnapshotDir(dataDir, operation.checkpointId)
	const manifestPath = snapshotManifestPath(dataDir, operation.checkpointId)

	if (existsSync(manifestPath)) {
		const resolved = await resolveCheckpointById(dataDir, operation.checkpointId)
		if (resolved.manifest.operationId !== operation.operationId) {
			throw new Error("checkpoint manifest operation identity does not match its operation")
		}
		if (!baseMatches && !expectedMatches) {
			throw new Error("checkpoint operation base no longer matches authoritative state")
		}
		if (baseMatches) {
			if (!["backup-complete", "manifest-complete"].includes(operation.phase)) {
				throw new Error(`checkpoint operation phase ${operation.phase} cannot publish its snapshot`)
			}
			if (operation.baseCurrent) await resolveCheckpointById(dataDir, operation.baseCurrent)
			if (operation.basePrevious) await resolveCheckpointById(dataDir, operation.basePrevious)
			const manifestComplete: CheckpointOperation = {
				...operation,
				phase: "manifest-complete",
			}
			await writeOperation(dataDir, manifestComplete)
			const nextState: CheckpointState = {
				formatVersion: 1,
				revision: operation.operationId,
				current: operation.checkpointId,
				previous: operation.baseCurrent,
				committedAt: new Date().toISOString(),
			}
			await durableJson(checkpointStatePath(dataDir), nextState)
		}
		const publishedState = await readCheckpointState(dataDir)
		if (
			publishedState.revision !== operation.operationId ||
			publishedState.current !== operation.checkpointId ||
			publishedState.previous !== operation.baseCurrent
		) {
			throw new Error("checkpoint operation publication did not produce its exact intended state")
		}
		let retirement: string | null = null
		if (operation.phase === "retention-complete") {
			const candidate = join(checkpointRetiringRoot(dataDir), `retirement-${operation.operationId}`)
			retirement = existsSync(candidate) ? candidate : null
		} else {
			await writeOperation(dataDir, { ...operation, phase: "pointer-complete" })
			retirement = await retireCheckpointIfEligible(
				dataDir,
				operation.basePrevious,
				publishedState,
				operation.operationId,
			)
			await writeOperation(dataDir, { ...operation, phase: "retention-complete" })
		}
		await removeCompletedRetirement(retirement, faults)
		await preserveCompletedOperation(dataDir, entryDir, operation.operationId, faults)
		return
	}

	if (!baseMatches || !["intent", "backup-complete"].includes(operation.phase)) {
		throw new Error("checkpoint operation is missing its manifest in an unsafe state")
	}
	const quarantineRoot = checkpointQuarantineRoot(dataDir)
	if (existsSync(quarantineRoot)) {
		await assertNoSymlink(checkpointRoot(dataDir), quarantineRoot)
		await assertRealDirectory(quarantineRoot, "checkpoint quarantine")
	}
	const quarantine = join(quarantineRoot, `operation-${operation.operationId}-${randomUUID()}`)
	await ensurePrivateDirectory(quarantineRoot)
	await ensurePrivateDirectory(quarantine)
	if (existsSync(snapshot)) {
		await assertNoSymlink(checkpointSnapshotsRoot(dataDir), snapshot)
		await assertRealDirectory(snapshot, "incomplete checkpoint snapshot")
		await durableRename(snapshot, join(quarantine, "incomplete-snapshot"))
	}
	await durableRename(entryDir, join(quarantine, "operation"))
}

const hasPins = async (dataDir: string, checkpointId: string): Promise<boolean> => {
	const path = join(checkpointPinsRoot(dataDir), checkpointId)
	try {
		await assertNoSymlink(checkpointRoot(dataDir), checkpointPinsRoot(dataDir))
		await assertNoSymlink(checkpointPinsRoot(dataDir), path)
		await assertRealDirectory(path, "checkpoint pin reservation")
		return (await readdir(path)).length > 0
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

export interface CheckpointPin {
	readonly formatVersion: 1
	readonly pinId: string
	readonly checkpointId: string
	readonly purpose: string
	readonly createdAt: string
}

const pinFilePath = (dataDir: string, checkpointId: string, pinId: string): string =>
	join(checkpointPinsRoot(dataDir), checkpointId, `${validateId(pinId, "pin")}.json`)

const PIN_PURPOSE = /^[A-Za-z0-9 _./:-]{0,128}$/

/**
 * Acquire a persistent pin on a checkpoint so retention cannot delete its
 * snapshot while the pin is held. The pin record is durably written under
 * `backups/pins/<checkpoint-id>/<pin-id>.json`; `retireCheckpointIfEligible`
 * already honors a non-empty pin directory. Callers that need pin acquisition
 * to race neither GC nor a concurrent checkpoint operation should hold the
 * maintenance lock (see {@link withMaintenanceLock}) while resolving and
 * pinning. A stale pin over-retains data rather than risking deletion.
 */
export const acquireCheckpointPin = async (
	dataDir: string,
	checkpointId: string,
	purpose = "archive",
	pinId: string = randomUUID(),
): Promise<string> => {
	const validatedCheckpointId = validateId(checkpointId, "checkpoint")
	if (!PIN_PURPOSE.test(purpose)) throw new Error(`invalid checkpoint pin purpose: ${purpose}`)
	const validatedPinId = validateId(pinId, "pin")
	// A pin on a checkpoint that does not resolve cannot protect anything; force
	// the caller to pin real, validated state.
	await resolveCheckpoint(dataDir, validatedCheckpointId)
	const pinsRoot = checkpointPinsRoot(dataDir)
	const pinDir = join(pinsRoot, validatedCheckpointId)
	await ensurePrivateDirectory(pinsRoot)
	await assertNoSymlink(checkpointRoot(dataDir), pinsRoot)
	await ensurePrivateDirectory(pinDir)
	await assertNoSymlink(pinsRoot, pinDir)
	const path = pinFilePath(dataDir, validatedCheckpointId, validatedPinId)
	// A deterministic caller-supplied pinId (archive journal) must target an
	// unused path so post-crash ownership is unambiguous: the journal records
	// this exact pinId before acquisition, and reconciliation releases exactly it.
	if (existsSync(path)) {
		throw new Error(`checkpoint pin already exists; refusing to overwrite: ${path}`)
	}
	const pin: CheckpointPin = {
		formatVersion: 1,
		pinId: validatedPinId,
		checkpointId: validatedCheckpointId,
		purpose,
		createdAt: new Date().toISOString(),
	}
	await durableJson(path, pin)
	return path
}

/**
 * Release a pin acquired by {@link acquireCheckpointPin}. Only the exact owned
 * pin record at `pinPath` is removed. If the path is absent, belongs to a
 * different checkpoint, or does not match the recorded pin identity, nothing is
 * deleted and the call fails closed — over-retention is always preferred.
 */
export const releaseCheckpointPin = async (
	dataDir: string,
	checkpointId: string,
	pinPath: string,
): Promise<void> => {
	const validatedCheckpointId = validateId(checkpointId, "checkpoint")
	const pinsRoot = checkpointPinsRoot(dataDir)
	const pinDir = join(pinsRoot, validatedCheckpointId)
	// The pin file must live directly under the named checkpoint's pin dir.
	const resolvedPinPath = resolve(pinPath)
	if (relative(pinDir, resolvedPinPath).startsWith(`..${sep}`)) {
		throw new Error(`pin path escapes checkpoint pin directory: ${pinPath}`)
	}
	if (!resolvedPinPath.endsWith(".json") || dirname(resolvedPinPath) !== resolve(pinDir)) {
		throw new Error(`pin path is not a direct child of the checkpoint pin directory: ${pinPath}`)
	}
	const baseName = basename(resolvedPinPath, ".json")
	await assertNoSymlink(checkpointRoot(dataDir), pinsRoot)
	await assertNoSymlink(pinsRoot, pinDir)
	if (!existsSync(resolvedPinPath)) {
		throw new Error(`checkpoint pin not found (already released?): ${pinPath}`)
	}
	await assertNoSymlink(pinDir, resolvedPinPath)
	await assertRealFile(resolvedPinPath, "checkpoint pin")
	const parsed = JSON.parse(await readFile(resolvedPinPath, "utf8")) as unknown
	if (
		!isRecord(parsed) ||
		parsed.formatVersion !== 1 ||
		validateId(requiredString(parsed, "pinId"), "pin") !== baseName ||
		validateId(requiredString(parsed, "checkpointId"), "checkpoint") !== validatedCheckpointId
	) {
		throw new Error(`checkpoint pin identity mismatch; refusing to remove: ${pinPath}`)
	}
	await durableRemove(resolvedPinPath)
}

/**
 * Run `fn` while holding the sibling maintenance lock so checkpoint creation,
 * restore, reset, and archive operations cannot overlap. A live owner is busy;
 * an unprovable owner fails closed; a provably dead owner is reconciled by
 * exact operation identity (see {@link acquireMaintenance}). PID age alone never
 * authorizes deletion. The lock is released when `fn` settles.
 */
export const withMaintenanceLock = async <A>(
	dataDir: string,
	operationId: string,
	fn: () => A | Promise<A>,
): Promise<A> => {
	const release = await acquireMaintenance(dataDir, validateId(operationId, "operation"))
	try {
		return await fn()
	} finally {
		await release()
	}
}

export const retireCheckpointIfEligible = async (
	dataDir: string,
	checkpointId: string | null,
	state: CheckpointState,
	retirementId: string = randomUUID(),
	faults: DurabilityFaults = {},
): Promise<string | null> => {
	if (!checkpointId || state.current === checkpointId || state.previous === checkpointId) return null
	const validatedCheckpointId = validateId(checkpointId, "checkpoint")
	if (await hasPins(dataDir, validatedCheckpointId)) return null
	const validatedRetirementId = validateId(retirementId, "retirement")
	const retirementRoot = checkpointRetiringRoot(dataDir)
	const retirement = join(retirementRoot, `retirement-${validatedRetirementId}`)
	const retirementIntent = join(retirement, "intent.json")
	const retirementComplete = join(retirement, "complete.json")
	const retiredSnapshot = join(retirement, validatedCheckpointId)
	if (existsSync(checkpointRetiringRoot(dataDir))) {
		await assertNoSymlink(checkpointRoot(dataDir), retirementRoot)
		await assertRealDirectory(retirementRoot, "checkpoint retirement root")
	}
	if (!existsSync(retirement)) {
		await resolveCheckpoint(dataDir, validatedCheckpointId, state)
		await ensurePrivateDirectory(retirement)
		await durableJson(retirementIntent, {
			formatVersion: 1,
			retirementId: validatedRetirementId,
			checkpointId: validatedCheckpointId,
			stateRevision: state.revision,
		})
		await faults.afterRetirementIntent?.(retirement)
	} else {
		await assertNoSymlink(retirementRoot, retirement)
		await assertRealDirectory(retirement, "checkpoint retirement")
		await assertNoSymlink(retirement, retirementIntent)
		await assertRealFile(retirementIntent, "checkpoint retirement intent")
		const parsed = JSON.parse(await readFile(retirementIntent, "utf8")) as unknown
		if (
			!isRecord(parsed) ||
			parsed.formatVersion !== 1 ||
			validateId(requiredString(parsed, "retirementId"), "retirement") !== validatedRetirementId ||
			validateId(requiredString(parsed, "checkpointId"), "checkpoint") !== validatedCheckpointId ||
			validateId(requiredString(parsed, "stateRevision"), "state revision") !== state.revision
		) {
			throw new Error(`checkpoint retirement identity mismatch: ${retirement}`)
		}
	}
	if (existsSync(retirementComplete)) {
		await assertNoSymlink(retirement, retirementComplete)
		await assertRealFile(retirementComplete, "checkpoint retirement completion")
		const complete = JSON.parse(await readFile(retirementComplete, "utf8")) as unknown
		if (
			!isRecord(complete) ||
			complete.formatVersion !== 1 ||
			validateId(requiredString(complete, "retirementId"), "retirement") !== validatedRetirementId ||
			validateId(requiredString(complete, "checkpointId"), "checkpoint") !== validatedCheckpointId ||
			validateId(requiredString(complete, "stateRevision"), "state revision") !== state.revision
		) {
			throw new Error(`checkpoint retirement completion identity mismatch: ${retirement}`)
		}
		if (
			existsSync(checkpointSnapshotDir(dataDir, validatedCheckpointId)) ||
			existsSync(retiredSnapshot)
		) {
			throw new Error("completed checkpoint retirement still has snapshot data")
		}
		return retirement
	}
	const source = checkpointSnapshotDir(dataDir, validatedCheckpointId)
	const sourceExists = existsSync(source)
	const retiredExists = existsSync(retiredSnapshot)
	if (sourceExists && retiredExists) {
		throw new Error("checkpoint retirement has both source and retired snapshots")
	}
	if (sourceExists) {
		await assertNoSymlink(checkpointSnapshotsRoot(dataDir), source)
		await durableRename(source, retiredSnapshot, faults)
		await faults.afterRetirementRename?.(retirement)
	}
	if (existsSync(retiredSnapshot)) {
		await rm(retiredSnapshot, { recursive: true })
		await syncDirectory(retirement)
		await faults.afterRetiredSnapshotRemoval?.(retirement)
	}
	await durableJson(retirementComplete, {
		formatVersion: 1,
		retirementId: validatedRetirementId,
		checkpointId: validatedCheckpointId,
		stateRevision: state.revision,
	})
	await faults.afterRetirementComplete?.(retirement)
	return retirement
}

const removeCompletedRetirement = async (
	retirement: string | null,
	faults: DurabilityFaults = {},
): Promise<void> => {
	if (!retirement || !existsSync(retirement)) return
	const intent = join(retirement, "intent.json")
	const complete = join(retirement, "complete.json")
	await assertNoSymlink(dirname(retirement), retirement)
	await assertRealDirectory(retirement, "checkpoint retirement")
	const entries = (await readdir(retirement)).sort()
	if (entries.length !== 2 || entries[0] !== "complete.json" || entries[1] !== "intent.json") {
		throw new Error(`completed checkpoint retirement contains unexpected state: ${retirement}`)
	}
	await assertNoSymlink(retirement, intent)
	await assertNoSymlink(retirement, complete)
	await assertRealFile(intent, "checkpoint retirement intent")
	await assertRealFile(complete, "checkpoint retirement completion")
	const intentValue = JSON.parse(await readFile(intent, "utf8")) as unknown
	const completeValue = JSON.parse(await readFile(complete, "utf8")) as unknown
	if (
		!isRecord(intentValue) ||
		!isRecord(completeValue) ||
		JSON.stringify(intentValue) !== JSON.stringify(completeValue)
	) {
		throw new Error(`checkpoint retirement records do not match: ${retirement}`)
	}
	const cleanup = `${retirement}.cleanup-${randomUUID()}`
	await durableRename(retirement, cleanup, faults)
	await faults.afterRetirementCleanupRename?.(cleanup)
	await rm(cleanup, { recursive: true })
	await syncDirectory(dirname(cleanup))
	await faults.afterRetirementCleanupRemoval?.(cleanup)
}

export const createCheckpoint = (
	options: CheckpointOptions,
): Effect.Effect<
	{
		readonly checkpointId: string
		readonly path: string
		readonly state: CheckpointState
		readonly manifest: CheckpointManifest
	},
	CheckpointError
> =>
	Effect.tryPromise({
		try: async () => {
			const operationId = randomUUID()
			const checkpointId = randomUUID()
			const release = await acquireMaintenance(options.dataDir, operationId)
			try {
				assertCheckpointRootSafe(options.dataDir)
				await assertCheckpointInfrastructureSafe(options.dataDir)
				assertNoLegacyLayout(options.dataDir)
				await reconcileCheckpointOperations(options.dataDir, options.faults)
				const oldState = await readStateFileOptional(options.dataDir)
				if (!oldState && (await checkpointLikePaths(options.dataDir)).length > 0) {
					throw new Error(
						"checkpoint state is missing while checkpoint data exists; refusing to infer selection",
					)
				}
				if (oldState) {
					await resolveCheckpoint(options.dataDir, oldState.current, oldState)
					if (oldState.previous) {
						await resolveCheckpoint(options.dataDir, oldState.previous, oldState)
					}
				}
				for (const path of [
					checkpointRoot(options.dataDir),
					checkpointSnapshotsRoot(options.dataDir),
					checkpointOperationsRoot(options.dataDir),
					checkpointPinsRoot(options.dataDir),
					checkpointQuarantineRoot(options.dataDir),
					checkpointRetiringRoot(options.dataDir),
				]) {
					await ensurePrivateDirectory(path)
				}
				const startedAt = new Date().toISOString()
				let operation: CheckpointOperation = {
					formatVersion: 1,
					operationId,
					checkpointId,
					baseRevision: oldState?.revision ?? null,
					baseCurrent: oldState?.current ?? null,
					basePrevious: oldState?.previous ?? null,
					phase: "intent",
					startedAt,
				}
				await writeOperation(options.dataDir, operation, options.faults)
				const snapshot = checkpointSnapshotDir(options.dataDir, checkpointId)
				await assertNoSymlink(checkpointSnapshotsRoot(options.dataDir), snapshot)
				await mkdir(snapshot, { mode: 0o700 })
				try {
					await postLocalQuery(
						options.port,
						`BACKUP DATABASE default TO Disk('default', '${snapshotBackupSqlPath(checkpointId)}')`,
					)
				} catch (error) {
					if (isMissingBackupConfigurationError(error)) {
						throw new Error(
							"checkpoints require the local server to be started with `--chdb-config-file` " +
								"pointing at a ClickHouse backups config",
							{ cause: error },
						)
					}
					throw error
				}
				await syncTree(snapshotBackupDir(options.dataDir, checkpointId))
				operation = { ...operation, phase: "backup-complete" }
				await writeOperation(options.dataDir, operation, options.faults)
				const provisionalManifest: CheckpointManifest = {
					formatVersion: 1,
					checkpointId,
					operationId,
					mapleVersion: MAPLE_VERSION,
					chdbVersion: CHDB_VERSION,
					schemaFingerprint: SCHEMA_FINGERPRINT,
					createdAt: startedAt,
					sourceDataDir: resolve(options.dataDir),
					backupRelativePath: snapshotBackupRelativePath(checkpointId),
					backupBytes: await dirSize(snapshotBackupDir(options.dataDir, checkpointId)),
					validation: {
						validatedAt: startedAt,
						traces: 0,
						logs: 0,
						metricsSum: 0,
						metricsGauge: 0,
						metricsHistogram: 0,
						metricsExponentialHistogram: 0,
						materializedViews: 0,
					},
				}
				const provisional: ResolvedCheckpoint = {
					checkpointId,
					snapshotDir: snapshot,
					backupDir: snapshotBackupDir(options.dataDir, checkpointId),
					backupSqlPath: snapshotBackupSqlPath(checkpointId),
					manifest: provisionalManifest,
				}
				const validation = await withRestoredCheckpoint(
					provisional,
					{ cleanup: "always" },
					(restored) => restored.validation,
				)
				const manifest: CheckpointManifest = { ...provisionalManifest, validation }
				await durableJson(
					snapshotManifestPath(options.dataDir, checkpointId),
					manifest,
					options.faults,
				)
				await syncDirectory(snapshot)
				operation = { ...operation, phase: "manifest-complete" }
				await writeOperation(options.dataDir, operation, options.faults)
				const state: CheckpointState = {
					formatVersion: 1,
					revision: operationId,
					current: checkpointId,
					previous: oldState?.current ?? null,
					committedAt: new Date().toISOString(),
				}
				await durableJson(checkpointStatePath(options.dataDir), state, options.faults)
				operation = { ...operation, phase: "pointer-complete" }
				await writeOperation(options.dataDir, operation, options.faults)
				const retirement = await retireCheckpointIfEligible(
					options.dataDir,
					oldState?.previous ?? null,
					state,
					operationId,
					options.faults,
				)
				operation = { ...operation, phase: "retention-complete" }
				await writeOperation(options.dataDir, operation, options.faults)
				await removeCompletedRetirement(retirement, options.faults)
				await preserveCompletedOperation(
					options.dataDir,
					operationDir(options.dataDir, operationId),
					operationId,
					options.faults,
				)
				return { checkpointId, path: snapshot, state, manifest }
			} finally {
				await release()
			}
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})

const parseResetTransaction = (value: unknown, expectedDataDir: string): ResetTransaction => {
	if (!isRecord(value) || value.formatVersion !== RESET_TRANSACTION_FORMAT_VERSION) {
		throw new Error("unsupported or malformed reset transaction")
	}
	const phase = requiredString(value, "phase")
	if (!["intent", "live-cleared", "markers-cleared"].includes(phase)) {
		throw new Error("invalid reset transaction phase")
	}
	const dataDir = requiredString(value, "dataDir")
	if (!isAbsolute(dataDir) || resolve(dataDir) !== resolve(expectedDataDir)) {
		throw new Error("reset transaction data directory does not match its configured owner")
	}
	if (!Array.isArray(value.targets)) throw new Error("invalid reset transaction targets")
	const targets = value.targets.map((target) => {
		if (typeof target !== "string" || !RESETTABLE_CHDB_ENTRIES.has(target)) {
			throw new Error(`unsafe reset transaction target: ${String(target)}`)
		}
		return target
	})
	if (new Set(targets).size !== targets.length || [...targets].sort().join("\0") !== targets.join("\0")) {
		throw new Error("reset transaction targets must be unique and sorted")
	}
	return {
		formatVersion: 1,
		operationId: validateId(requiredString(value, "operationId"), "reset operation"),
		dataDir: resolve(dataDir),
		targets,
		phase: phase as ResetTransaction["phase"],
		createdAt: requiredIso(value, "createdAt"),
	}
}

const readResetTransaction = async (dataDir: string): Promise<ResetTransaction | null> => {
	const path = resetTransactionPath(dataDir)
	try {
		await assertRealFile(path, "reset transaction")
		return parseResetTransaction(JSON.parse(await readFile(path, "utf8")), dataDir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

const writeResetTransaction = async (dataDir: string, transaction: ResetTransaction): Promise<void> =>
	durableJson(resetTransactionPath(dataDir), transaction)

const reconcileResetTransactionUnlocked = async (
	dataDir: string,
	faults: RestoreRecoveryFaults = {},
): Promise<boolean> => {
	let transaction = await readResetTransaction(dataDir)
	if (!transaction) return false
	if (existsSync(restoreTransactionPath(dataDir))) {
		throw new Error("reset and restore transactions both exist; refusing to choose one")
	}
	const live = resolve(dataDir)
	if (existsSync(live)) await assertRealDirectory(live, "live data directory")

	if (transaction.phase === "intent") {
		for (const target of transaction.targets) {
			const path = join(live, target)
			if (!existsSync(path)) continue
			await assertRealDirectory(path, `reset target ${target}`)
			await rm(path, { recursive: true })
			await syncDirectory(live)
			await faults.afterResetEntryRemoval?.(target)
		}
		transaction = { ...transaction, phase: "live-cleared" }
		await writeResetTransaction(dataDir, transaction)
		await faults.afterResetLiveClearedRecord?.()
	}

	if (transaction.phase === "live-cleared") {
		for (const target of transaction.targets) {
			if (existsSync(join(live, target))) {
				throw new Error(`reset transaction target reappeared before marker removal: ${target}`)
			}
		}
		const marker = storeMarkerPath(dataDir)
		if (existsSync(marker)) await durableRemove(marker)
		await faults.afterResetStoreMarkerRemoval?.()
		const openMarker = storeOpenMarkerPath(dataDir)
		if (existsSync(openMarker)) await durableRemove(openMarker)
		await faults.afterResetOpenMarkerRemoval?.()
		transaction = { ...transaction, phase: "markers-cleared" }
		await writeResetTransaction(dataDir, transaction)
		await faults.afterResetMarkersClearedRecord?.()
	}

	for (const target of transaction.targets) {
		if (existsSync(join(live, target))) {
			throw new Error(`reset transaction target reappeared after deletion: ${target}`)
		}
	}
	await durableRemove(resetTransactionPath(dataDir))
	await faults.afterResetTransactionRemoval?.()
	return true
}

const beginResetTransactionUnlocked = async (
	dataDir: string,
	operationId: string,
	faults: RestoreRecoveryFaults = {},
): Promise<void> => {
	await assertCheckpointInfrastructureSafe(dataDir)
	const live = resolve(dataDir)
	const targets: string[] = []
	const unknown: string[] = []
	if (existsSync(live)) {
		await assertRealDirectory(live, "live data directory")
		const entries = await readdir(live, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.name === "backups") continue
			if (!RESETTABLE_CHDB_ENTRIES.has(entry.name)) {
				unknown.push(join(live, entry.name))
				continue
			}
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new Error(`reset target is not a real chDB directory: ${join(live, entry.name)}`)
			}
			targets.push(entry.name)
		}
	}
	if (unknown.length > 0) {
		throw new Error(
			`unrecognized data-directory entries were preserved; refusing reset: ${unknown.sort().join(", ")}`,
		)
	}
	const transaction: ResetTransaction = {
		formatVersion: 1,
		operationId: validateId(operationId, "reset operation"),
		dataDir: live,
		targets: targets.sort(),
		phase: "intent",
		createdAt: new Date().toISOString(),
	}
	await writeResetTransaction(dataDir, transaction)
	await faults.afterResetIntent?.()
	await reconcileResetTransactionUnlocked(dataDir, faults)
}

const parseRestoreTransaction = (value: unknown): RestoreTransaction => {
	if (!isRecord(value) || value.formatVersion !== RESTORE_TRANSACTION_FORMAT_VERSION) {
		throw new Error("unsupported or malformed restore transaction")
	}
	const phase = requiredString(value, "phase")
	if (!["intent", "restore-ready", "old-quarantined", "new-live", "markers-committed"].includes(phase)) {
		throw new Error("invalid restore transaction phase")
	}
	return {
		formatVersion: 1,
		operationId: validateId(requiredString(value, "operationId"), "restore operation"),
		checkpointId: validateId(requiredString(value, "checkpointId"), "checkpoint"),
		quarantineId: validateId(requiredString(value, "quarantineId"), "quarantine"),
		phase: phase as RestoreTransaction["phase"],
		createdAt: requiredIso(value, "createdAt"),
		validation: value.validation === null ? null : parseValidation(value.validation),
	}
}

const readRestoreTransaction = async (dataDir: string): Promise<RestoreTransaction | null> => {
	try {
		await assertRealFile(restoreTransactionPath(dataDir), "restore transaction")
		return parseRestoreTransaction(JSON.parse(await readFile(restoreTransactionPath(dataDir), "utf8")))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

const writeRestoreTransaction = async (dataDir: string, transaction: RestoreTransaction) =>
	durableJson(restoreTransactionPath(dataDir), transaction)

const restoreReadyPath = (dataDir: string, operationId: string): string =>
	join(restoreDataPath(dataDir, operationId), ".maple-restore-ready.json")

const readyIdentityMatches = (dataDir: string, transaction: RestoreTransaction): boolean => {
	const candidates = [
		restoreReadyPath(dataDir, transaction.operationId),
		join(resolve(dataDir), ".maple-restore-ready.json"),
	]
	for (const path of candidates) {
		if (!existsSync(path)) continue
		try {
			const info = lstatSync(path)
			if (info.isSymbolicLink() || !info.isFile()) return false
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
			if (
				isRecord(parsed) &&
				parsed.formatVersion === 1 &&
				parsed.operationId === transaction.operationId &&
				parsed.checkpointId === transaction.checkpointId
			) {
				return true
			}
		} catch {
			return false
		}
	}
	return false
}

const finalizeRestoreMarkers = async (
	dataDir: string,
	transaction: RestoreTransaction,
	faults: RestoreRecoveryFaults = {},
): Promise<RestoreTransaction> => {
	if (!readyIdentityMatches(dataDir, transaction)) {
		throw new Error("restored live store identity is missing or does not match the transaction")
	}
	await writeStoreMarkerDurable(dataDir, MAPLE_VERSION, new Date().toISOString(), SCHEMA_FINGERPRINT)
	await faults.afterStoreMarkerWrite?.()
	await markStoreClosedDurable(dataDir)
	await faults.afterOpenMarkerRemoval?.()
	const committed: RestoreTransaction = { ...transaction, phase: "markers-committed" }
	await writeRestoreTransaction(dataDir, committed)
	await faults.afterMarkersCommittedRecord?.()
	return committed
}

const completeRestoreTransaction = async (
	dataDir: string,
	transaction: RestoreTransaction,
	faults: RestoreRecoveryFaults = {},
): Promise<void> => {
	const readyPath = join(resolve(dataDir), ".maple-restore-ready.json")
	if (existsSync(readyPath)) await durableRemove(readyPath)
	await faults.afterReadyMarkerRemoval?.()
	const root = restoreRootPath(dataDir, transaction.operationId)
	if (existsSync(root)) {
		await rm(root, { recursive: true })
		await syncDirectory(dirname(root))
	}
	await faults.afterRestoreRootRemoval?.()
	await durableRemove(restoreTransactionPath(dataDir))
}

const reconcileRestoreTransactionUnlocked = async (
	dataDir: string,
	faults: RestoreRecoveryFaults = {},
): Promise<void> => {
	if (existsSync(resolve(dataDir))) {
		await assertRealDirectory(resolve(dataDir), "live data directory")
	}
	let transaction = await readRestoreTransaction(dataDir)
	if (!transaction) {
		const parent = dirname(resolve(dataDir))
		const prefix = `${basename(resolve(dataDir))}.restore-`
		let names: string[]
		try {
			names = await readdir(parent)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		const debris = names
			.filter(
				(name) =>
					(name.startsWith(prefix) && !name.includes(".quarantine-")) ||
					name === `${basename(resolve(dataDir))}.restore-transaction.json`,
			)
			.map((name) => join(parent, name))
		if (debris.length > 0) {
			throw new Error(
				`restore-like paths exist without a valid transaction; refusing to infer ownership: ${debris.join(", ")}`,
			)
		}
		return
	}
	const live = resolve(dataDir)
	const restoreRoot = restoreRootPath(dataDir, transaction.operationId)
	const restoreData = restoreDataPath(dataDir, transaction.operationId)
	const quarantine = restoreQuarantinePath(dataDir, transaction.operationId, transaction.quarantineId)
	const liveExists = existsSync(live)
	const restoreExists = existsSync(restoreData)
	const quarantineExists = existsSync(quarantine)
	if (liveExists) await assertRealDirectory(live, "live data directory")
	if (existsSync(restoreRoot)) await assertRealDirectory(restoreRoot, "restore root")
	if (restoreExists) await assertRealDirectory(restoreData, "restored data directory")
	if (quarantineExists) await assertRealDirectory(quarantine, "restore quarantine")

	if (transaction.phase === "intent") {
		if (!liveExists || quarantineExists) {
			throw new Error(
				`ambiguous restore intent topology; live=${liveExists} restore=${restoreExists} quarantine=${quarantineExists}`,
			)
		}
		if (existsSync(restoreRoot)) {
			await durableRename(restoreRoot, `${restoreRoot}.quarantine-${randomUUID()}`)
		}
		await durableRename(
			restoreTransactionPath(dataDir),
			`${restoreTransactionPath(dataDir)}.quarantine-${randomUUID()}`,
		)
		return
	}

	if (transaction.phase === "restore-ready" && liveExists && restoreExists && !quarantineExists) {
		if (!readyIdentityMatches(dataDir, transaction)) {
			throw new Error("restore-ready identity is missing or mismatched")
		}
		await durableRename(live, quarantine)
		await faults.afterLiveQuarantineRename?.()
		transaction = { ...transaction, phase: "old-quarantined" }
		await writeRestoreTransaction(dataDir, transaction)
		await faults.afterOldQuarantinedRecord?.()
	}

	if (
		(transaction.phase === "restore-ready" || transaction.phase === "old-quarantined") &&
		!existsSync(live) &&
		existsSync(restoreData) &&
		existsSync(quarantine)
	) {
		await durableRename(restoreData, live)
		await faults.afterRestoredLiveRename?.()
		transaction = { ...transaction, phase: "new-live" }
		await writeRestoreTransaction(dataDir, transaction)
		await faults.afterNewLiveRecord?.()
	}

	if (
		(transaction.phase === "old-quarantined" || transaction.phase === "new-live") &&
		existsSync(live) &&
		!existsSync(restoreData) &&
		existsSync(quarantine)
	) {
		transaction = await finalizeRestoreMarkers(
			dataDir,
			{
				...transaction,
				phase: "new-live",
			},
			faults,
		)
	}

	if (transaction.phase === "markers-committed" && existsSync(live) && existsSync(quarantine)) {
		await completeRestoreTransaction(dataDir, transaction, faults)
		return
	}

	throw new Error(
		`restore transaction could not be reconciled safely; phase=${transaction.phase} live=${existsSync(live)} restore=${existsSync(restoreData)} quarantine=${existsSync(quarantine)}`,
	)
}

export const reconcileCheckpointRecovery = (
	dataDir: string,
	faults: RestoreRecoveryFaults = {},
): Effect.Effect<void, CheckpointError> =>
	Effect.tryPromise({
		try: async () => {
			const operationId = randomUUID()
			const release = await acquireMaintenance(dataDir, operationId)
			try {
				const resetReconciled = await reconcileResetTransactionUnlocked(dataDir, faults)
				if (!resetReconciled) await reconcileRestoreTransactionUnlocked(dataDir, faults)
			} finally {
				await release()
			}
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})

/**
 * Explicitly remove the live chDB store while preserving the checkpoint
 * registry below `<dataDir>/backups`. The maintenance lock serializes this
 * destructive operation with checkpoint, restore, and archive work.
 */
export const resetLiveStorePreservingCheckpoints = (
	dataDir: string,
	faults: RestoreRecoveryFaults = {},
): Effect.Effect<void, CheckpointError> =>
	Effect.tryPromise({
		try: async () => {
			const operationId = randomUUID()
			const release = await acquireMaintenance(dataDir, operationId)
			try {
				const resetReconciled = await reconcileResetTransactionUnlocked(dataDir, faults)
				if (!resetReconciled) {
					await reconcileRestoreTransactionUnlocked(dataDir)
					await beginResetTransactionUnlocked(dataDir, operationId, faults)
				}
			} finally {
				await release()
			}
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})

export const restoreCheckpoint = (
	dataDir: string,
	selector: "current" | "previous" | string = "current",
): Effect.Effect<
	{
		readonly checkpointId: string
		readonly quarantinePath: string
		readonly validation: CheckpointValidation
	},
	CheckpointError
> =>
	Effect.tryPromise({
		try: async () => {
			const operationId = randomUUID()
			const quarantineId = randomUUID()
			const release = await acquireMaintenance(dataDir, operationId)
			try {
				await reconcileResetTransactionUnlocked(dataDir)
				await reconcileRestoreTransactionUnlocked(dataDir)
				const resolvedCheckpoint = await resolveCheckpoint(dataDir, selector)
				const restoreRoot = restoreRootPath(dataDir, operationId)
				const restoreData = restoreDataPath(dataDir, operationId)
				const quarantinePath = restoreQuarantinePath(dataDir, operationId, quarantineId)
				if (existsSync(restoreRoot) || existsSync(quarantinePath)) {
					throw new Error("restore or quarantine path already exists")
				}
				let transaction: RestoreTransaction = {
					formatVersion: 1,
					operationId,
					checkpointId: resolvedCheckpoint.checkpointId,
					quarantineId,
					phase: "intent",
					createdAt: new Date().toISOString(),
					validation: null,
				}
				await writeRestoreTransaction(dataDir, transaction)
				await mkdir(restoreRoot, { mode: 0o700 })
				const restored = await restoreResolvedInto(resolvedCheckpoint, restoreData)
				const validation = restored.validation
				restored.db.close()
				await cp(checkpointRoot(dataDir), join(restoreData, "backups"), {
					recursive: true,
					force: false,
					errorOnExist: true,
				})
				await syncTree(join(restoreData, "backups"))
				await durableJson(restoreReadyPath(dataDir, operationId), {
					formatVersion: 1,
					operationId,
					checkpointId: resolvedCheckpoint.checkpointId,
				})
				await syncTree(restoreData, { allowSymlinks: true })
				transaction = { ...transaction, phase: "restore-ready", validation }
				await writeRestoreTransaction(dataDir, transaction)
				await reconcileRestoreTransactionUnlocked(dataDir)
				return {
					checkpointId: resolvedCheckpoint.checkpointId,
					quarantinePath,
					validation,
				}
			} finally {
				await release()
			}
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})

// Test helper: assert generated operation IDs remain unique and valid without
// exposing an override in production command paths.
export const newCheckpointId = (): string => validateId(randomUUID(), "checkpoint")

// Refuse pre-existing symlink roots even before an operation allocates paths.
export const assertCheckpointRootSafe = (dataDir: string): void => {
	const root = checkpointRoot(dataDir)
	if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
		throw new Error(`refusing symlink checkpoint root: ${root}`)
	}
	if (basename(root) !== "backups") throw new Error("invalid checkpoint root")
}

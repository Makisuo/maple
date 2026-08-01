// Generic local-store migration coordinator.
//
// The coordinator owns process safety, journaling, chain progression, staging,
// and promotion. Transition-specific table names, transforms, verification,
// and recovery live in compile-time migration modules.

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, statfsSync } from "node:fs"
import { lstat, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Chdb } from "./chdb"
import {
	CURRENT_LOCAL_SCHEMA,
	LEGACY_LOCAL_SCHEMA,
	LOCAL_SCHEMA_V1,
	LOCAL_SCHEMA_SQL,
	identityLabel,
	type LocalSchemaIdentity,
} from "./schema-identity"
import {
	checkStoreCompatible,
	ensureStoreMarkerDurable,
	isStoreDirty,
	markStoreClosedDurable,
	markStoreOpenDurable,
	readMarker,
	storeHasData,
	storeMarkerPath,
	storeOpenMarkerPath,
	type StoreMarker,
	type StoreMarkerV2,
} from "./store-version"
import { durableJson, durableRename, ensurePrivateDirectory } from "./durable-files"
import { MAPLE_VERSION } from "../version"
import { legacyToCurrentModule } from "./local-store-migrations/legacy-to-current"
import type {
	AnyLocalStoreMigrationModule,
	LocalStoreMigration,
	MigrationDbOptions,
	MigrationModuleContext,
	MigrationPhase,
	MigrationStepJournal,
	MigrationStepStatus,
} from "./local-store-migration-module"

export {
	type AnyLocalStoreMigrationModule,
	type LocalStoreMigration,
	type LocalStoreMigrationModule,
	type MigrationDbOptions,
	type MigrationModuleContext,
	type MigrationOperation,
	type MigrationPhase,
	type MigrationStepJournal,
	type MigrationStepStatus,
	type StateDisposition,
	type StateDispositionEntry,
} from "./local-store-migration-module"

export { legacyToCurrentModule } from "./local-store-migrations/legacy-to-current"

const NONTERMINAL_PHASES = new Set<MigrationPhase>([
	"planned",
	"preflight-complete",
	"target-created",
	"copying",
	"copy-verified",
	"promotion-started",
	"failed",
])

export const isMigrationIncomplete = (phase: MigrationPhase): boolean => NONTERMINAL_PHASES.has(phase)

export interface MigrationPlan {
	readonly source: LocalSchemaIdentity
	readonly target: LocalSchemaIdentity
	readonly chain: ReadonlyArray<LocalStoreMigration>
	readonly operations: ReadonlyArray<LocalStoreMigration["operations"][number]>
	readonly dispositions: ReadonlyArray<LocalStoreMigration["dispositions"][number]>
	readonly requiresQuiescence: boolean
	readonly rollbackBoundary: string
	readonly checkpointDisposition: string
}

export interface MigrationJournal {
	readonly formatVersion: 2
	readonly migrationId: string
	readonly phase: MigrationPhase
	readonly chain: ReadonlyArray<MigrationStepJournal>
	readonly currentStepIndex: number
	readonly sourceDataDir: string
	readonly sourceStoreId: string
	readonly sourceChdb: string
	readonly sourceFingerprint: string
	readonly sourceDigest: string
	readonly sourceVersion: number
	readonly targetDataDir: string
	readonly targetStoreId: string
	readonly targetChdb: string
	readonly targetFingerprint: string
	readonly targetDigest: string
	readonly targetVersion: number
	readonly cutoffAt: string
	readonly createdAt: string
	readonly failure?: string
}

export interface MigrationResult {
	readonly migrationId: string
	readonly phase: MigrationPhase
	readonly cutoffAt: string
	readonly sourceRollbackDir: string
	readonly targetDataDir: string
	readonly completedSteps: number
	/** Kept for CLI/API compatibility; transition modules may expose a richer
	 * typed progress summary through their own progress state. */
	readonly copiedRows: Readonly<Record<string, number>>
}

export const localStoreMigrations: ReadonlyArray<AnyLocalStoreMigrationModule> = [legacyToCurrentModule]

export const validateMigrationRegistry = (
	registry: ReadonlyArray<AnyLocalStoreMigrationModule>,
): ReadonlyArray<AnyLocalStoreMigrationModule> => {
	const ids = new Set<string>()
	const fromVersions = new Set<number>()
	for (const migration of registry) {
		if (ids.has(migration.id)) throw new Error(`duplicate local migration id: ${migration.id}`)
		ids.add(migration.id)
		if (fromVersions.has(migration.from.version)) {
			throw new Error(`ambiguous local migration path from schema version ${migration.from.version}`)
		}
		fromVersions.add(migration.from.version)
		if (!Number.isInteger(migration.moduleVersion) || migration.moduleVersion < 1) {
			throw new Error(`migration ${migration.id} has an invalid module version`)
		}
		if (!Number.isInteger(migration.from.version) || !Number.isInteger(migration.to.version)) {
			throw new Error(`migration ${migration.id} has a non-integer schema version`)
		}
		if (migration.to.version <= migration.from.version) {
			throw new Error(`migration ${migration.id} is not a forward migration`)
		}
		if (migration.operations.length === 0) throw new Error(`migration ${migration.id} has no operations`)
		for (const handler of [
			migration.preflight,
			migration.prepareTarget,
			migration.apply,
			migration.verify,
			migration.recover,
		]) {
			if (typeof handler !== "function")
				throw new Error(`migration ${migration.id} is missing a module handler`)
		}
	}
	return registry
}

validateMigrationRegistry(localStoreMigrations)

export type MigrationResolutionErrorKind =
	| "unknown-schema"
	| "unknown-future-schema"
	| "unsupported-downgrade"
	| "missing-path"
	| "chdb-mismatch"

export class MigrationResolutionError extends Error {
	readonly kind: MigrationResolutionErrorKind
	constructor(kind: MigrationResolutionErrorKind, message: string) {
		super(message)
		this.name = "MigrationResolutionError"
		this.kind = kind
	}
}

export const identityFromMarker = (marker: StoreMarker): LocalSchemaIdentity | null => {
	if (marker.formatVersion === 2) {
		return {
			version: marker.schemaVersion,
			fingerprint: marker.schema,
			digest: marker.schemaDigest,
			chdb: marker.chdb,
		}
	}
	if (marker.schema === LEGACY_LOCAL_SCHEMA.fingerprint)
		return { ...LEGACY_LOCAL_SCHEMA, chdb: marker.chdb }
	if (marker.schema === LOCAL_SCHEMA_V1.fingerprint) return { ...LOCAL_SCHEMA_V1, chdb: marker.chdb }
	return null
}

export const resolveMigrationChain = (
	source: LocalSchemaIdentity,
	target: LocalSchemaIdentity = CURRENT_LOCAL_SCHEMA,
	registry: ReadonlyArray<AnyLocalStoreMigrationModule> = localStoreMigrations,
): ReadonlyArray<AnyLocalStoreMigrationModule> => {
	if (source.chdb !== target.chdb && source.chdb !== "dev" && target.chdb !== "dev") {
		throw new MigrationResolutionError(
			"chdb-mismatch",
			`migration requires a version-matched chDB reader (store ${source.chdb}; build ${target.chdb})`,
		)
	}
	if (source.version > target.version) {
		if (source.version > CURRENT_LOCAL_SCHEMA.version) {
			throw new MigrationResolutionError(
				"unknown-future-schema",
				`local store schema ${identityLabel(source)} is newer than this build's ${identityLabel(target)}`,
			)
		}
		throw new MigrationResolutionError(
			"unsupported-downgrade",
			`downgrading local schema ${identityLabel(source)} to ${identityLabel(target)} is unsupported`,
		)
	}
	if (source.version === target.version) {
		if (source.fingerprint === target.fingerprint && source.digest === target.digest) return []
		throw new MigrationResolutionError(
			"unknown-schema",
			`schema version ${source.version} has an unknown fingerprint ${source.fingerprint || "<none>"}`,
		)
	}

	const byFrom = new Map(
		validateMigrationRegistry(registry).map((migration) => [migration.from.version, migration]),
	)
	const chain: AnyLocalStoreMigrationModule[] = []
	let current = source
	const visited = new Set<number>()
	while (current.version < target.version) {
		if (visited.has(current.version))
			throw new MigrationResolutionError("missing-path", "local migration registry contains a cycle")
		visited.add(current.version)
		const migration = byFrom.get(current.version)
		if (
			!migration ||
			migration.from.fingerprint !== current.fingerprint ||
			(migration.from.digest !== "" &&
				current.digest !== "" &&
				migration.from.digest !== current.digest)
		) {
			throw new MigrationResolutionError(
				"missing-path",
				`no registered local migration from schema ${identityLabel(current)} to v${target.version}`,
			)
		}
		chain.push(migration)
		current = { ...migration.to, chdb: target.chdb }
	}
	if (
		current.version !== target.version ||
		current.fingerprint !== target.fingerprint ||
		current.digest !== target.digest
	) {
		throw new MigrationResolutionError(
			"missing-path",
			`registered migrations stop at ${identityLabel(current)}; target is ${identityLabel(target)}`,
		)
	}
	return chain
}

export const planMigration = (source: LocalSchemaIdentity, target = CURRENT_LOCAL_SCHEMA): MigrationPlan => {
	const chain = resolveMigrationChain(source, target)
	const operations = chain.flatMap((migration) => migration.operations)
	return {
		source,
		target,
		chain,
		operations,
		dispositions: chain.flatMap((migration) => migration.dispositions),
		requiresQuiescence: operations.some((operation) => operation.requiresQuiescence),
		rollbackBoundary:
			"The retained source is a pre-cutover rollback point only; telemetry accepted after promotion is not present there.",
		checkpointDisposition:
			"Existing checkpoints remain with the retained legacy store and are not claimed restorable by the current binary; create a new checkpoint after promotion.",
	}
}

export const formatMigrationPlan = (plan: MigrationPlan): string => {
	const lines = [
		`source schema: ${identityLabel(plan.source)}`,
		`target schema: ${identityLabel(plan.target)}`,
		`chDB: ${plan.target.chdb}`,
		`quiescence required: ${plan.requiresQuiescence ? "yes" : "no"}`,
		"migration chain:",
		...plan.chain.map((migration) => `  - ${migration.id}: ${migration.description}`),
		"ordered operations:",
		...plan.operations.map(
			(operation) =>
				`  - ${operation.id}: ${operation.description}${operation.phase === undefined ? "" : ` [${operation.phase}]`}`,
		),
		"state dispositions:",
		...plan.dispositions.map(
			(entry) =>
				`  - ${entry.name}: ${entry.disposition}${entry.preservationInterval === undefined ? "" : ` [${entry.preservationInterval}]`} — ${entry.guarantee}`,
		),
		`checkpoint: ${plan.checkpointDisposition}`,
		`rollback: ${plan.rollbackBoundary}`,
	]
	return `${lines.join("\n")}\n`
}

export const migrationJournalPath = (dataDir: string): string =>
	join(dirname(resolve(dataDir)), "maple-store-migration.json")

export const migrationRootPath = (dataDir: string, migrationId: string): string =>
	join(dirname(resolve(dataDir)), ".maple-migrations", migrationId)

export const migrationHistoryPath = (dataDir: string, migrationId: string): string =>
	join(migrationRootPath(dataDir, migrationId), "journal.json")

const migrationIdPattern = /^[A-Za-z0-9._-]+$/

const safeMigrationPath = (path: string, root: string, label: string): string => {
	const absolute = resolve(path)
	const relativePath = relative(resolve(root), absolute)
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		resolve(root) === absolute
	) {
		throw new Error(`${label} escapes migration root`)
	}
	return absolute
}

const assertJournalPaths = (dataDir: string, journal: MigrationJournal): void => {
	const source = resolve(dataDir)
	if (resolve(journal.sourceDataDir) !== source)
		throw new Error("local migration journal source does not match the configured data directory")
	const root = migrationRootPath(dataDir, journal.migrationId)
	safeMigrationPath(journal.targetDataDir, root, "migration target")
	if (resolve(dirname(journal.targetDataDir)) !== resolve(join(root, "target")))
		throw new Error("local migration journal target is outside its owned target directory")
	if (
		journal.chain.length === 0 ||
		journal.currentStepIndex < 0 ||
		journal.currentStepIndex > journal.chain.length
	)
		throw new Error("local migration journal chain state is invalid")
	const final = journal.chain[journal.chain.length - 1]!
	if (
		final.to.version !== journal.targetVersion ||
		final.to.fingerprint !== journal.targetFingerprint ||
		final.to.digest !== journal.targetDigest
	)
		throw new Error("local migration journal final target does not match its chain")
}

const parsePhase = (value: unknown): MigrationPhase => {
	if (
		value !== "planned" &&
		value !== "preflight-complete" &&
		value !== "target-created" &&
		value !== "copying" &&
		value !== "copy-verified" &&
		value !== "promotion-started" &&
		value !== "promoted" &&
		value !== "failed"
	)
		throw new Error(`invalid local migration phase: ${String(value)}`)
	return value
}

const parseIdentity = (value: unknown, label: string): LocalSchemaIdentity => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`migration journal ${label} identity is invalid`)
	const identity = value as Record<string, unknown>
	if (
		!Number.isInteger(identity.version) ||
		typeof identity.fingerprint !== "string" ||
		typeof identity.digest !== "string" ||
		typeof identity.chdb !== "string"
	)
		throw new Error(`migration journal ${label} identity is invalid`)
	return {
		version: identity.version as number,
		fingerprint: identity.fingerprint,
		digest: identity.digest,
		chdb: identity.chdb,
		...(typeof identity.manifestDigest === "string" ? { manifestDigest: identity.manifestDigest } : {}),
		...(typeof identity.projectRevision === "string"
			? { projectRevision: identity.projectRevision }
			: {}),
	}
}

const parseStep = (value: unknown, index: number): MigrationStepJournal => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`migration journal step ${index} is invalid`)
	const step = value as Record<string, unknown>
	const status = step.status
	if (
		typeof step.id !== "string" ||
		!Number.isInteger(step.moduleVersion) ||
		(status !== "pending" && status !== "running" && status !== "verified" && status !== "completed")
	)
		throw new Error(`migration journal step ${index} is invalid`)
	return {
		id: step.id,
		moduleVersion: step.moduleVersion as number,
		from: parseIdentity(step.from, `step ${index} from`),
		to: parseIdentity(step.to, `step ${index} to`),
		status: status as MigrationStepStatus,
		...(step.state === undefined ? {} : { state: step.state }),
		...(step.progress === undefined ? {} : { progress: step.progress }),
	}
}

const parseJournal = (value: unknown): MigrationJournal => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("migration journal is not an object")
	const record = value as Record<string, unknown>
	const requiredStrings = [
		"migrationId",
		"sourceDataDir",
		"sourceStoreId",
		"sourceChdb",
		"sourceFingerprint",
		"targetDataDir",
		"targetStoreId",
		"targetChdb",
		"targetFingerprint",
		"targetDigest",
		"cutoffAt",
		"createdAt",
	] as const
	for (const key of requiredStrings)
		if (typeof record[key] !== "string" || record[key] === "")
			throw new Error(`migration journal ${key} is invalid`)
	for (const key of ["sourceVersion", "targetVersion", "currentStepIndex"] as const)
		if (!Number.isInteger(record[key])) throw new Error(`migration journal ${key} is invalid`)
	if (record.formatVersion !== 2)
		throw new Error(`unsupported migration journal format ${String(record.formatVersion)}`)
	if (!migrationIdPattern.test(record.migrationId as string))
		throw new Error("migration journal id is unsafe")
	if (!Array.isArray(record.chain) || record.chain.length === 0)
		throw new Error("migration journal chain is invalid")
	const chain = record.chain.map(parseStep)
	if ((record.currentStepIndex as number) < 0 || (record.currentStepIndex as number) > chain.length)
		throw new Error("migration journal currentStepIndex is invalid")
	return {
		formatVersion: 2,
		migrationId: record.migrationId as string,
		phase: parsePhase(record.phase),
		chain,
		currentStepIndex: record.currentStepIndex as number,
		sourceDataDir: resolve(record.sourceDataDir as string),
		sourceStoreId: record.sourceStoreId as string,
		sourceChdb: record.sourceChdb as string,
		sourceFingerprint: record.sourceFingerprint as string,
		sourceDigest: typeof record.sourceDigest === "string" ? record.sourceDigest : "",
		sourceVersion: record.sourceVersion as number,
		targetDataDir: resolve(record.targetDataDir as string),
		targetStoreId: record.targetStoreId as string,
		targetChdb: record.targetChdb as string,
		targetFingerprint: record.targetFingerprint as string,
		targetDigest: record.targetDigest as string,
		targetVersion: record.targetVersion as number,
		cutoffAt: record.cutoffAt as string,
		createdAt: record.createdAt as string,
		...(record.failure === undefined ? {} : { failure: String(record.failure) }),
	}
}

export const readMigrationJournal = async (dataDir: string): Promise<MigrationJournal | null> => {
	try {
		return parseJournal(JSON.parse(await readFile(migrationJournalPath(dataDir), "utf8")) as unknown)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw new Error(
			`cannot read local migration journal: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

const writeMigrationJournal = async (dataDir: string, journal: MigrationJournal): Promise<void> =>
	durableJson(migrationJournalPath(dataDir), journal)

const updateJournal = async (
	dataDir: string,
	journal: MigrationJournal,
	update: Partial<MigrationJournal>,
): Promise<MigrationJournal> => {
	const next = { ...journal, ...update }
	await writeMigrationJournal(dataDir, next)
	return next
}

const archiveCompletedMigration = async (dataDir: string, journal: MigrationJournal): Promise<void> => {
	if (journal.phase !== "promoted") return
	const canonical = migrationJournalPath(dataDir)
	if (!existsSync(canonical)) return
	const root = migrationRootPath(dataDir, journal.migrationId)
	await ensurePrivateDirectory(root)
	const archive = migrationHistoryPath(dataDir, journal.migrationId)
	if (existsSync(archive)) throw new Error(`completed migration history already exists: ${archive}`)
	await durableRename(canonical, archive)
}

export const localMigrationIsIncomplete = async (dataDir: string): Promise<boolean> => {
	const journal = await readMigrationJournal(dataDir)
	return journal !== null && isMigrationIncomplete(journal.phase)
}

/** Explicit reset-only abandonment. Completed transactions are archived and
 * therefore cannot block a later migration. */
export const abandonLocalStoreMigration = async (dataDir: string): Promise<string | null> => {
	const path = migrationJournalPath(dataDir)
	const journal = await readMigrationJournal(dataDir)
	if (journal === null || !isMigrationIncomplete(journal.phase)) return null
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("migration journal must be a real file")
	const abandonedPath = join(
		dirname(path),
		`maple-store-migration-abandoned-${journal.migrationId}-${randomUUID()}.json`,
	)
	await durableRename(path, abandonedPath)
	return abandonedPath
}

const assertNoLiveServer = (dataDir: string): void => {
	const pidPath = join(dirname(resolve(dataDir)), "maple.pid")
	if (!existsSync(pidPath)) return
	const raw = readFileSync(pidPath, "utf8").trim()
	const pid = Number.parseInt(raw, 10)
	if (!Number.isInteger(pid) || pid <= 0) return
	try {
		process.kill(pid, 0)
		throw new Error(`maple is running (PID ${pid}); stop it before migrating`)
	} catch (error) {
		if (error instanceof Error && error.message.includes("maple is running")) throw error
	}
}

const parseJsonEachRow = <A>(value: string): A[] =>
	value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as A)

const MIN_MIGRATION_FREE_BYTES = 128 * 1024 * 1024

type MigrationStoreRole = "source" | "target"

const openDb = (dataDir: string, bootstrapSchema: boolean, options: MigrationDbOptions = {}): Chdb =>
	Chdb.open({
		dataDir,
		schemaSql: options.schemaSql ?? LOCAL_SCHEMA_SQL,
		bootstrapSchema: options.bootstrapSchema ?? bootstrapSchema,
	})

/** Every migration connection is sentinel-managed. A source sentinel left by
 * an abrupt kill is a hard stop; staged-target evidence can be explicitly
 * abandoned and rebuilt, but is never silently reopened. */
const withDb = async <A>(
	dataDir: string,
	bootstrapSchema: boolean,
	fn: (db: Chdb) => A | Promise<A>,
	options: MigrationDbOptions & { readonly role?: MigrationStoreRole } = {},
): Promise<A> => {
	const role = options.role ?? "source"
	if (isStoreDirty(dataDir)) {
		throw new Error(
			`${role} store at ${dataDir} was not cleanly closed; refusing to reopen it during migration. ` +
				(role === "target"
					? "Discard the incomplete migration and rebuild its staged target explicitly."
					: "Preserve the source and inspect the open sentinel before retrying."),
		)
	}
	await markStoreOpenDurable(dataDir)
	let db: Chdb | undefined
	try {
		db = openDb(dataDir, bootstrapSchema, options)
		return await fn(db)
	} finally {
		if (db !== undefined) {
			let closed = false
			try {
				db.close()
				closed = true
			} finally {
				if (closed) await markStoreClosedDurable(dataDir)
			}
		}
	}
}

const ensureMigrationCapacity = async (dataDir: string): Promise<void> => {
	const treeBytes = async (path: string): Promise<number> => {
		const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null
			throw error
		})
		if (info === null) return 0
		if (info.isSymbolicLink()) throw new Error(`refusing symlink in checkpoint tree: ${path}`)
		if (info.isFile()) return info.size
		if (!info.isDirectory()) throw new Error(`unsupported checkpoint entry: ${path}`)
		const entries = await readdir(path)
		let total = 0
		for (const entry of entries) total += await treeBytes(join(path, entry))
		return total
	}
	const rows = await withDb(dataDir, false, (db) =>
		parseJsonEachRow<{ bytes: string | number }>(
			db.query(
				"SELECT coalesce(sum(bytes_on_disk), 0) AS bytes FROM system.parts WHERE database = 'default' AND active = 1",
			),
		),
	)
	const sourceBytes = Number(rows[0]?.bytes ?? 0)
	if (!Number.isFinite(sourceBytes) || sourceBytes < 0)
		throw new Error("could not estimate source store size")
	const filesystem = statfsSync(dirname(resolve(dataDir)))
	const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
	const checkpointBytes = await treeBytes(join(resolve(dataDir), "backups"))
	const requiredBytes = Math.max(MIN_MIGRATION_FREE_BYTES, sourceBytes * 2 + checkpointBytes)
	if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
		throw new Error(
			`insufficient free space for a side-by-side migration (estimated source: ${Math.round(sourceBytes)} bytes; checkpoints: ${Math.round(checkpointBytes)} bytes; free: ${Math.round(freeBytes)} bytes; required: ${Math.round(requiredBytes)} bytes)`,
		)
	}
}

const assertRealDirectory = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`${label} must be a real directory: ${path}`)
}

const assertRealFile = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real file: ${path}`)
}

const assertSameFilesystemPromotion = async (dataDir: string, journal: MigrationJournal): Promise<void> => {
	const source = await stat(resolve(dataDir))
	const targetParent = await stat(dirname(resolve(journal.targetDataDir)))
	const sourceParent = await stat(dirname(resolve(dataDir)))
	if (source.dev !== targetParent.dev || source.dev !== sourceParent.dev) {
		throw new Error(
			"side-by-side promotion would cross filesystems (EXDEV); keep the source and its migration root on the same filesystem and retry",
		)
	}
}

const markerMatches = (
	marker: StoreMarker | null,
	identity: LocalSchemaIdentity,
	storeId: string,
	activation: "active" | "staging",
): marker is StoreMarkerV2 =>
	marker?.formatVersion === 2 &&
	marker.storeId === storeId &&
	marker.chdb === identity.chdb &&
	marker.schemaVersion === identity.version &&
	marker.schema === identity.fingerprint &&
	marker.schemaDigest === identity.digest &&
	marker.activation === activation

const assertPromotionStoresClosed = (dataDir: string, journal: MigrationJournal): void => {
	const paths = [
		dataDir,
		journal.targetDataDir,
		join(migrationRootPath(dataDir, journal.migrationId), "source", "data"),
	]
	for (const path of paths) {
		if (existsSync(storeOpenMarkerPath(path)))
			throw new Error(`promotion found an open-store sentinel; refusing to move ${path}`)
	}
}

const archiveAndReturn = async (dataDir: string, journal: MigrationJournal): Promise<MigrationResult> => {
	await archiveCompletedMigration(dataDir, journal)
	return {
		migrationId: journal.migrationId,
		phase: journal.phase,
		cutoffAt: journal.cutoffAt,
		sourceRollbackDir: join(migrationRootPath(dataDir, journal.migrationId), "source", "data"),
		targetDataDir: resolve(dataDir),
		completedSteps: journal.chain.filter((step) => step.status === "completed").length,
		copiedRows: {},
	}
}

const promote = async (dataDir: string, input: MigrationJournal): Promise<MigrationResult> => {
	let journal = input
	const root = migrationRootPath(dataDir, journal.migrationId)
	const targetData = safeMigrationPath(journal.targetDataDir, root, "target data")
	const sourceRoot = join(root, "source")
	const sourceData = join(sourceRoot, "data")
	const activeData = resolve(dataDir)
	const activeMarker = storeMarkerPath(dataDir)
	const sourceMarker = storeMarkerPath(sourceData)
	const stagedMarker = storeMarkerPath(journal.targetDataDir)
	await ensurePrivateDirectory(root)
	await ensurePrivateDirectory(sourceRoot)
	if (existsSync(join(root, "target")))
		await assertRealDirectory(join(root, "target"), "migration target root")
	assertPromotionStoresClosed(dataDir, journal)
	journal = await updateJournal(dataDir, journal, { phase: "promotion-started" })

	const validateTargetMarker = (
		marker: StoreMarker | null,
		activation: "active" | "staging",
	): StoreMarkerV2 => {
		if (
			!markerMatches(
				marker,
				journal.chain[journal.chain.length - 1]!.to,
				journal.targetStoreId,
				activation,
			)
		)
			throw new Error(
				`migration target marker is missing or not ${activation} with the journal's final identity`,
			)
		return marker
	}

	const finish = async (marker: StoreMarkerV2): Promise<MigrationResult> => {
		await durableJson(activeMarker, {
			...marker,
			activation: "active",
			lastMigration: {
				id: journal.migrationId,
				completedAt: new Date().toISOString(),
				fromVersion: journal.sourceVersion,
				toVersion: journal.targetVersion,
			},
		})
		const promoted: MigrationJournal = { ...journal, phase: "promoted" }
		await writeMigrationJournal(dataDir, promoted)
		return archiveAndReturn(dataDir, promoted)
	}

	const activeExists = existsSync(activeData)
	const sourceExists = existsSync(sourceData)
	const targetExists = existsSync(targetData)
	if (existsSync(activeMarker)) await assertRealFile(activeMarker, "active store marker")

	// This branch includes the crash window after stagedMarker was moved to the
	// active marker path but before activation was rewritten from staging to
	// active. It is intentionally reachable from the public resume path.
	if (activeExists && sourceExists && !targetExists) {
		await assertRealDirectory(activeData, "active target data")
		await assertRealDirectory(sourceData, "retained source data")
		await assertRealFile(sourceMarker, "retained source marker")
		const marker = readMarker(activeData)
		if (marker === null) {
			if (!existsSync(stagedMarker))
				throw new Error("promotion has an active target but no marker to recover")
			await assertRealFile(stagedMarker, "staged target marker")
			await durableRename(stagedMarker, activeMarker)
			return finish(validateTargetMarker(readMarker(activeData), "staging"))
		}
		return finish(
			validateTargetMarker(marker, marker.formatVersion === 2 ? marker.activation : "staging"),
		)
	}
	if (activeExists && sourceExists)
		throw new Error(
			"source and active directories both exist before target cutover; promotion is ambiguous",
		)
	if (!activeExists && !sourceExists)
		throw new Error("both the source and rollback directories are missing; promotion is ambiguous")
	if (!targetExists) throw new Error("migration target disappeared before promotion")
	await assertRealDirectory(targetData, "migration target")
	const marker = validateTargetMarker(readMarker(journal.targetDataDir), "staging")
	await assertRealFile(stagedMarker, "staged target marker")

	if (!sourceExists) {
		await assertRealDirectory(activeData, "source data")
		if (!existsSync(activeMarker)) throw new Error("source marker is missing before promotion")
		await assertRealFile(activeMarker, "active source marker")
		await durableRename(activeData, sourceData)
	}
	if (existsSync(activeMarker)) {
		if (existsSync(sourceMarker))
			throw new Error("source marker already exists with an active marker; promotion is ambiguous")
		await assertRealFile(activeMarker, "active source marker")
		await durableRename(activeMarker, sourceMarker)
	} else if (!existsSync(sourceMarker)) {
		throw new Error("source marker disappeared before promotion could retain it")
	} else {
		await assertRealFile(sourceMarker, "retained source marker")
	}
	if (existsSync(activeData))
		throw new Error("active data appeared before target cutover; promotion is ambiguous")
	await durableRename(targetData, activeData)
	if (existsSync(activeMarker)) throw new Error("active marker unexpectedly exists after target cutover")
	if (!existsSync(stagedMarker)) throw new Error("staged target marker disappeared before target cutover")
	await durableRename(stagedMarker, activeMarker)
	return finish(marker)
}

const reconcilePromotion = async (dataDir: string, journal: MigrationJournal): Promise<MigrationResult> => {
	assertJournalPaths(dataDir, journal)
	assertPromotionStoresClosed(dataDir, journal)
	const activeMarker = readMarker(dataDir)
	const finalIdentity = journal.chain[journal.chain.length - 1]!.to
	if (
		existsSync(resolve(dataDir)) &&
		markerMatches(activeMarker, finalIdentity, journal.targetStoreId, "active")
	) {
		if (existsSync(journal.targetDataDir))
			throw new Error("promotion has an active target and a duplicate staged target; refusing to guess")
		await assertRealDirectory(dataDir, "active target data")
		const retainedSourceData = join(migrationRootPath(dataDir, journal.migrationId), "source", "data")
		await assertRealDirectory(retainedSourceData, "retained source data")
		await assertRealFile(storeMarkerPath(retainedSourceData), "retained source marker")
		const promoted: MigrationJournal = { ...journal, phase: "promoted" }
		await writeMigrationJournal(dataDir, promoted)
		return archiveAndReturn(dataDir, promoted)
	}
	if (
		!existsSync(resolve(dataDir)) &&
		!existsSync(journal.targetDataDir) &&
		!existsSync(join(migrationRootPath(dataDir, journal.migrationId), "source", "data"))
	)
		throw new Error(
			"migration promotion was interrupted in an ambiguous filesystem state; preserve all directories and inspect the journal",
		)
	return promote(dataDir, journal)
}

/** Filesystem-only promotion recovery seam used by fault-injection tests and
 * by the public coordinator after a process restart. */
export const reconcileLocalStorePromotion = reconcilePromotion

const moduleForStep = (
	step: MigrationStepJournal,
	modules: ReadonlyArray<AnyLocalStoreMigrationModule>,
): AnyLocalStoreMigrationModule => {
	const module = modules.find(
		(candidate) =>
			candidate.id === step.id &&
			candidate.moduleVersion === step.moduleVersion &&
			candidate.from.version === step.from.version &&
			candidate.from.fingerprint === step.from.fingerprint &&
			candidate.from.digest === step.from.digest &&
			candidate.from.chdb === step.from.chdb &&
			candidate.to.version === step.to.version &&
			candidate.to.fingerprint === step.to.fingerprint &&
			candidate.to.digest === step.to.digest &&
			candidate.to.chdb === step.to.chdb,
	)
	if (!module) throw new Error(`unfinished local migration step ${step.id} is not available in this build`)
	return module
}

const makeModuleContext = (
	dataDir: string,
	journal: MigrationJournal,
	stepIndex: number,
): {
	readonly context: MigrationModuleContext
	readonly current: () => MigrationJournal
	readonly setPhase: (phase: MigrationPhase) => void
} => {
	let current = journal
	const step = journal.chain[stepIndex]!
	const sourceDataDir = stepIndex === 0 ? dataDir : journal.targetDataDir
	const context: MigrationModuleContext = {
		dataDir,
		sourceDataDir,
		targetDataDir: journal.targetDataDir,
		source: step.from,
		target: step.to,
		cutoffAt: journal.cutoffAt,
		step,
		openSource: (fn, options = {}) =>
			withDb(sourceDataDir, options.bootstrapSchema ?? false, fn, { ...options, role: "source" }),
		openTarget: (fn, options = {}) =>
			withDb(journal.targetDataDir, options.bootstrapSchema ?? false, fn, {
				...options,
				role: "target",
			}),
		ensureCapacity: () => (stepIndex === 0 ? ensureMigrationCapacity(dataDir) : Promise.resolve()),
		saveStep: async (update) => {
			const previous = current.chain[stepIndex]!
			const nextStep: MigrationStepJournal = {
				...previous,
				...(update.state === undefined ? {} : { state: update.state }),
				...(update.progress === undefined ? {} : { progress: update.progress }),
			}
			current = {
				...current,
				chain: current.chain.map((candidate, index) => (index === stepIndex ? nextStep : candidate)),
			}
			await writeMigrationJournal(dataDir, current)
		},
	}
	return {
		context,
		current: () => current,
		setPhase: (phase) => {
			current = { ...current, phase }
		},
	}
}

/** Execute one module's typed lifecycle without giving it ownership of the
 * coordinator journal phase. This is also the seam used by fixture modules to
 * prove that a later conversion can be added without editing the coordinator. */
export const executeMigrationModule = async (
	migration: AnyLocalStoreMigrationModule,
	context: MigrationModuleContext,
	step: MigrationStepJournal,
	options: {
		readonly prepareTarget: boolean
		readonly onPhase?: (
			phase: "preflight-complete" | "target-created" | "copying" | "copy-verified",
		) => Promise<void>
	},
): Promise<{ readonly state: unknown; readonly progress: unknown }> => {
	let state = step.state
	let progress = step.progress
	if (step.status === "pending") {
		state = await migration.preflight(context)
		await context.saveStep({ state })
		await options.onPhase?.("preflight-complete")
	} else {
		const recovered = await migration.recover(context, state, progress)
		state = recovered.state ?? state
		progress = recovered.progress ?? progress
		await context.saveStep({ state, progress })
		if (step.state === undefined) {
			// A process can die after the step is marked running but before its
			// preflight state is durable. Recovery may repair target-side progress,
			// but it must not let the step skip its transition-specific preflight.
			state = await migration.preflight(context)
			await context.saveStep({ state })
			await options.onPhase?.("preflight-complete")
		}
	}
	if (options.prepareTarget || step.status === "pending") {
		state = await migration.prepareTarget(context, state)
		await context.saveStep({ state })
		await options.onPhase?.("target-created")
	}
	if (step.status !== "verified" && step.status !== "completed") {
		await options.onPhase?.("copying")
		progress = await migration.apply(context, state, progress)
		await context.saveStep({ progress })
		await migration.verify(context, state, progress)
		await options.onPhase?.("copy-verified")
	}
	return { state, progress }
}

const executeMigrationChain = async (
	dataDir: string,
	input: MigrationJournal,
	modules: ReadonlyArray<AnyLocalStoreMigrationModule>,
	onProgress?: (message: string) => void,
): Promise<MigrationJournal> => {
	let journal = input
	while (journal.currentStepIndex < journal.chain.length) {
		const stepIndex = journal.currentStepIndex
		const lifecycleStep = journal.chain[stepIndex]!
		let step = lifecycleStep
		const migration = moduleForStep(lifecycleStep, modules)
		if (step.status === "pending") {
			step = { ...step, status: "running" }
			journal = await updateJournal(dataDir, journal, {
				chain: journal.chain.map((candidate, index) => (index === stepIndex ? step : candidate)),
			})
		}
		const targetMarker = readMarker(journal.targetDataDir)
		const prepareTarget = !markerMatches(targetMarker, migration.to, journal.targetStoreId, "staging")
		journal = await updateJournal(dataDir, journal, {
			phase: lifecycleStep.status === "pending" ? "planned" : "copying",
		})
		const { context, current, setPhase } = makeModuleContext(dataDir, journal, stepIndex)
		// Keep the persisted step running before invoking the handlers, but pass
		// the pre-transition status to the lifecycle seam. A newly started step
		// must preflight/apply; only a step recovered after a restart should call
		// recover first.
		await executeMigrationModule(migration, context, lifecycleStep, {
			prepareTarget,
			onPhase: async (phase) => {
				setPhase(phase)
				journal = await updateJournal(dataDir, current(), { phase })
			},
		})
		journal = await updateJournal(dataDir, current(), { phase: "copy-verified" })
		const activeStep = current().chain[stepIndex]!
		if (activeStep.status !== "verified" && activeStep.status !== "completed") {
			const verifiedStep: MigrationStepJournal = { ...activeStep, status: "verified" }
			journal = await updateJournal(
				dataDir,
				{
					...current(),
					chain: current().chain.map((candidate, index) =>
						index === stepIndex ? verifiedStep : candidate,
					),
				},
				{},
			)
		}

		await ensureStoreMarkerDurable(
			journal.targetDataDir,
			migration.to,
			MAPLE_VERSION,
			journal.createdAt,
			{
				activation: "staging",
				storeId: journal.targetStoreId,
			},
		)
		const completedStep: MigrationStepJournal = { ...current().chain[stepIndex]!, status: "completed" }
		journal = await updateJournal(
			dataDir,
			{
				...current(),
				chain: current().chain.map((candidate, index) =>
					index === stepIndex ? completedStep : candidate,
				),
			},
			{
				currentStepIndex: stepIndex + 1,
				phase: stepIndex + 1 < current().chain.length ? "target-created" : "copy-verified",
			},
		)
		onProgress?.(`${migration.id}: step ${stepIndex + 1}/${journal.chain.length} verified`)
	}
	return journal
}

const withMigrationMaintenanceLock = async <A>(
	dataDir: string,
	operationId: string,
	fn: () => Promise<A>,
): Promise<A> => {
	const { resetTransactionPath, restoreTransactionPath, withMaintenanceLock } =
		await import("./checkpoints")
	return withMaintenanceLock(dataDir, operationId, async () => {
		if (existsSync(restoreTransactionPath(dataDir)) || existsSync(resetTransactionPath(dataDir)))
			throw new Error(
				"checkpoint recovery is pending; run maple start once to reconcile it before migrating the local store",
			)
		return fn()
	})
}

const sourceStoreId = (marker: StoreMarker): string =>
	marker.formatVersion === 2 ? marker.storeId : `legacy-${marker.schema || "unversioned"}-${randomUUID()}`

const createJournal = (dataDir: string, plan: MigrationPlan, marker: StoreMarker): MigrationJournal => {
	const migrationId = `local-migration-${randomUUID()}`
	return {
		formatVersion: 2,
		migrationId,
		phase: "planned",
		chain: plan.chain.map(
			(migration): MigrationStepJournal => ({
				id: migration.id,
				moduleVersion: migration.moduleVersion,
				from: migration.from,
				to: migration.to,
				status: "pending",
			}),
		),
		currentStepIndex: 0,
		sourceDataDir: resolve(dataDir),
		sourceStoreId: sourceStoreId(marker),
		sourceChdb: plan.source.chdb,
		sourceFingerprint: plan.source.fingerprint,
		sourceDigest: plan.source.digest,
		sourceVersion: plan.source.version,
		targetDataDir: join(migrationRootPath(dataDir, migrationId), "target", "data"),
		targetStoreId: randomUUID(),
		targetChdb: plan.target.chdb,
		targetFingerprint: plan.target.fingerprint,
		targetDigest: plan.target.digest,
		targetVersion: plan.target.version,
		cutoffAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
	}
}

const journalModules = (
	journal: MigrationJournal,
	modules: ReadonlyArray<AnyLocalStoreMigrationModule>,
): ReadonlyArray<AnyLocalStoreMigrationModule> => journal.chain.map((step) => moduleForStep(step, modules))

const migrationPlanFromJournal = (journal: MigrationJournal): MigrationPlan => {
	const chain = journalModules(journal, localStoreMigrations)
	const source: LocalSchemaIdentity = {
		version: journal.sourceVersion,
		fingerprint: journal.sourceFingerprint,
		digest: journal.sourceDigest,
		chdb: journal.sourceChdb,
	}
	const target = journal.chain[journal.chain.length - 1]!.to
	const operations = chain.flatMap((migration) => migration.operations)
	return {
		source,
		target,
		chain,
		operations,
		dispositions: chain.flatMap((migration) => migration.dispositions),
		requiresQuiescence: operations.some((operation) => operation.requiresQuiescence),
		rollbackBoundary:
			"The retained source is a pre-cutover rollback point only; telemetry accepted after promotion is not present there.",
		checkpointDisposition:
			"Existing checkpoints remain with the retained source and are not claimed restorable by the current schema; create a new checkpoint after promotion.",
	}
}

const sameIdentity = (a: LocalSchemaIdentity, b: LocalSchemaIdentity): boolean =>
	a.version === b.version && a.fingerprint === b.fingerprint && a.digest === b.digest && a.chdb === b.chdb

const migrationResult = (journal: MigrationJournal, dataDir: string): MigrationResult => ({
	migrationId: journal.migrationId,
	phase: journal.phase,
	cutoffAt: journal.cutoffAt,
	sourceRollbackDir: join(migrationRootPath(dataDir, journal.migrationId), "source", "data"),
	targetDataDir: resolve(dataDir),
	completedSteps: journal.chain.filter((step) => step.status === "completed").length,
	copiedRows: {},
})

/** Resume only the journal-bound promotion phase. This public seam is kept
 * separate from ordinary source compatibility checks so a staged active
 * marker is accepted only when the journal proves that it belongs to the
 * target being promoted. */
export const resumeLocalStoreMigrationPromotion = async (dataDir: string): Promise<MigrationResult> => {
	const resolvedDataDir = resolve(dataDir)
	assertNoLiveServer(resolvedDataDir)
	return withMigrationMaintenanceLock(resolvedDataDir, randomUUID(), async () => {
		const current = await readMigrationJournal(resolvedDataDir)
		if (current === null || current.phase !== "promotion-started")
			throw new Error("promotion journal disappeared before recovery")
		return reconcilePromotion(resolvedDataDir, current)
	})
}

export interface RunMigrationOptions {
	readonly dataDir: string
	readonly dryRun?: boolean
	readonly onProgress?: (message: string) => void
}

export const runLocalStoreMigration = async (
	options: RunMigrationOptions,
): Promise<MigrationResult | MigrationPlan> => {
	const dataDir = resolve(options.dataDir)
	let journal = await readMigrationJournal(dataDir)
	let markerState = readMarker(dataDir)

	// Promotion recovery is journal-bound and must happen before ordinary marker
	// compatibility checks. A staging marker in this phase is expected evidence,
	// not an active store that should be rejected by checkStoreCompatible().
	if (journal?.phase === "promotion-started") {
		assertJournalPaths(dataDir, journal)
		return options.dryRun
			? migrationPlanFromJournal(journal)
			: resumeLocalStoreMigrationPromotion(dataDir)
	}

	if (journal?.phase === "promoted") {
		if (!markerState || markerState.formatVersion !== 2)
			throw new Error("completed migration has no readable active v2 marker")
		const completedTarget = journal.chain[journal.chain.length - 1]!.to
		if (!markerMatches(markerState, completedTarget, journal.targetStoreId, "active"))
			throw new Error("completed migration journal does not match the active store; refusing to guess")
		if (options.dryRun) return planMigration(completedTarget)
		await archiveCompletedMigration(dataDir, journal)
		if (sameIdentity(completedTarget, CURRENT_LOCAL_SCHEMA)) return migrationResult(journal, dataDir)
		markerState = readMarker(dataDir)
		journal = null
	}

	if (!markerState && journal === null)
		throw new Error(
			"the source store has no readable marker; unknown stores fail closed and cannot be migrated",
		)
	if (!markerState && journal !== null && journal.phase !== "promotion-started")
		throw new Error("unfinished migration has no readable source marker; refusing to resume")

	const sourceIdentity =
		markerState !== null
			? identityFromMarker(markerState)
			: journal === null
				? null
				: {
						version: journal.sourceVersion,
						fingerprint: journal.sourceFingerprint,
						digest: journal.sourceDigest,
						chdb: journal.sourceChdb,
					}
	if (!sourceIdentity)
		throw new Error(
			`the source fingerprint ${markerState?.schema ?? journal?.sourceFingerprint ?? "<none>"} is not registered; use an explicit reset only if data loss is acceptable`,
		)

	const compatibility = checkStoreCompatible(dataDir)
	if (!compatibility.compatible)
		throw new Error(`source is not compatible with this chDB build: ${compatibility.found}`)
	const plan = journal === null ? planMigration(sourceIdentity) : null
	if (options.dryRun) {
		if (plan !== null) return plan
		const resumedChain = journalModules(journal!, localStoreMigrations)
		return {
			source: sourceIdentity,
			target: journal!.chain[journal!.chain.length - 1]!.to,
			chain: resumedChain,
			operations: resumedChain.flatMap((migration) => migration.operations),
			dispositions: resumedChain.flatMap((migration) => migration.dispositions),
			requiresQuiescence: true,
			rollbackBoundary:
				"The retained source is a pre-cutover rollback point only; telemetry accepted after promotion is not present there.",
			checkpointDisposition:
				"Existing checkpoints remain with the retained source and are not claimed restorable by the current schema; create a new checkpoint after promotion.",
		}
	}
	assertNoLiveServer(dataDir)
	if (!storeHasData(dataDir))
		throw new Error("the local store is empty; start normally to bootstrap it instead of migrating")
	await assertRealDirectory(dataDir, "source data")
	await assertRealFile(storeMarkerPath(dataDir), "source store marker")
	if (isStoreDirty(dataDir))
		throw new Error("source store was not cleanly closed; preserve it and retry after inspection")

	if (journal === null) {
		if (!plan || plan.chain.length === 0) throw new Error("store already has the current schema")
		journal = createJournal(dataDir, plan, markerState!)
		await ensurePrivateDirectory(migrationRootPath(dataDir, journal.migrationId))
		await ensurePrivateDirectory(join(migrationRootPath(dataDir, journal.migrationId), "target"))
		if (existsSync(journal.targetDataDir))
			throw new Error(
				"migration target directory already exists without a journal; refusing to reuse it",
			)
		await writeMigrationJournal(dataDir, journal)
	} else {
		assertJournalPaths(dataDir, journal)
		journalModules(journal, localStoreMigrations)
		if (markerState?.formatVersion === 2 && markerState.storeId !== journal.sourceStoreId)
			throw new Error("unfinished local migration source store id does not match the active marker")
	}

	const operationId = randomUUID()
	return withMigrationMaintenanceLock(dataDir, operationId, async () => {
		assertNoLiveServer(dataDir)
		if (isStoreDirty(dataDir))
			throw new Error(
				"source store became dirty before the migration lock was acquired; refusing to continue",
			)
		let current = (await readMigrationJournal(dataDir)) ?? journal!
		try {
			const modules = journalModules(current, localStoreMigrations)
			current = await executeMigrationChain(dataDir, current, modules, options.onProgress)
			if (current.currentStepIndex !== current.chain.length)
				throw new Error("migration chain did not reach its final verified step")
			await assertSameFilesystemPromotion(dataDir, current)
			return promote(dataDir, current)
		} catch (error) {
			const persisted = await readMigrationJournal(dataDir).catch(() => null)
			const failed = persisted ?? current
			if (failed.phase !== "promoted") {
				await updateJournal(dataDir, failed, {
					phase:
						failed.phase === "planned" ||
						failed.phase === "preflight-complete" ||
						failed.phase === "promotion-started"
							? failed.phase
							: "failed",
					failure: error instanceof Error ? error.message : String(error),
				}).catch(() => undefined)
			}
			throw error
		}
	})
}

export const migrationStatus = async (
	dataDir: string,
): Promise<{
	readonly marker: StoreMarker | null
	readonly journal: MigrationJournal | null
	readonly physicalCheck: "not-run" | "available-after-open"
}> => ({
	marker: readMarker(dataDir),
	journal: await readMigrationJournal(dataDir),
	physicalCheck: storeHasData(dataDir) ? "available-after-open" : "not-run",
})

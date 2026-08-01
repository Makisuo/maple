// Versioned local-store migration coordinator.
//
// The coordinator is deliberately independent of normal server startup. A
// migration operates on a stopped source, builds a fresh staged target, and
// promotes it only after the source and target have been verified. The source
// is retained under a rollback directory; it is never removed automatically.

import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, statfsSync } from "node:fs"
import { lstat, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Chdb } from "./chdb"
import {
	CURRENT_LOCAL_SCHEMA,
	LEGACY_LOCAL_SCHEMA,
	LOCAL_SCHEMA_MANIFEST,
	LOCAL_SCHEMA_SQL,
	identityLabel,
	type LocalSchemaIdentity,
} from "./schema-identity"
import type { LocalSchemaColumn } from "./schema-manifest"
import { assertCurrentPhysicalSchema } from "./schema-physical"
import {
	checkStoreCompatible,
	ensureStoreMarkerDurable,
	isStoreDirty,
	readMarker,
	storeMarkerPath,
	storeHasData,
	type StoreMarker,
	type StoreMarkerV2,
} from "./store-version"
import { durableJson, durableRename, ensurePrivateDirectory } from "./durable-files"
import { MAPLE_VERSION } from "../version"

export type MigrationPhase =
	| "planned"
	| "preflight-complete"
	| "target-created"
	| "copying"
	| "copy-verified"
	| "promotion-started"
	| "promoted"
	| "failed"

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

export type StateDisposition =
	| "preserve-exact"
	| "copy-transform"
	| "rebuild-complete"
	| "rebuild-within-retention-horizon"
	| "retain-as-legacy-rollback-only"
	| "invalidate"
	| "discard-with-confirmation"
	| "unsupported"

export interface MigrationOperation {
	readonly id: string
	readonly description: string
	readonly requiresQuiescence: boolean
	readonly phase: Exclude<MigrationPhase, "failed" | "promoted">
}

export interface StateDispositionEntry {
	readonly name: string
	readonly classification: "authoritative" | "derived" | "ephemeral" | "operational" | "unknown"
	readonly disposition: StateDisposition
	readonly guarantee: string
	readonly preservationInterval?: string
	readonly sourceRetentionDays?: number
	readonly targetRetentionDays?: number
}

export interface LocalStoreMigration {
	readonly id: string
	readonly moduleVersion: number
	readonly description: string
	readonly fromVersion: number
	readonly toVersion: number
	readonly fromFingerprint?: string
	readonly toFingerprint: string
	readonly operations: ReadonlyArray<MigrationOperation>
	readonly dispositions: ReadonlyArray<StateDispositionEntry>
}

export interface MigrationPlan {
	readonly source: LocalSchemaIdentity
	readonly target: LocalSchemaIdentity
	readonly chain: ReadonlyArray<LocalStoreMigration>
	readonly operations: ReadonlyArray<MigrationOperation>
	readonly dispositions: ReadonlyArray<StateDispositionEntry>
	readonly requiresQuiescence: boolean
	readonly rollbackBoundary: string
	readonly checkpointDisposition: string
}

export interface MigrationJournal {
	readonly formatVersion: 1
	readonly migrationId: string
	readonly moduleDigest: string
	readonly phase: MigrationPhase
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
	readonly sourceInventory?: Readonly<Record<string, TableInventory>>
	readonly copied?: Readonly<Record<string, CopyProgress>>
	readonly pendingBatch?: PendingBatch
	readonly failure?: string
}

export interface TableInventory {
	readonly table: string
	readonly rowCount: string
	readonly retentionStartAt: string
	readonly minTime: string | null
	readonly maxTime: string | null
	readonly hashSum: string
	readonly hashXor: string
}

export interface CopyProgress {
	readonly rows: number
	readonly bytes: number
	readonly lastTimestamp: string | null
	readonly lastHash: string | null
	readonly lastTieBreak: string | null
	readonly duplicateCount: number
}

export interface PendingBatch {
	readonly table: string
	readonly rowCount: number
	readonly byteLength: number
	readonly firstTimestamp: string | null
	readonly firstHash: string | null
	readonly firstTieBreak: string | null
	readonly lastTimestamp: string | null
	readonly lastHash: string | null
	readonly lastTieBreak: string | null
	readonly lastKeyCount: number
	readonly signature: string
}

export interface MigrationResult {
	readonly migrationId: string
	readonly phase: MigrationPhase
	readonly cutoffAt: string
	readonly sourceRollbackDir: string
	readonly targetDataDir: string
	readonly copiedRows: Readonly<Record<string, number>>
}

const RAW_TABLES = [
	{ name: "logs", timeColumn: "TimestampTime", retentionDays: 30, batchRows: 25, batchBytes: 256 * 1024 },
	{ name: "traces", timeColumn: "Timestamp", retentionDays: 30, batchRows: 100, batchBytes: 512 * 1024 },
	{
		name: "metrics_sum",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 500,
		batchBytes: 1024 * 1024,
	},
	{
		name: "metrics_gauge",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 500,
		batchBytes: 1024 * 1024,
	},
	{
		name: "metrics_histogram",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 250,
		batchBytes: 1024 * 1024,
	},
	{
		name: "metrics_exponential_histogram",
		timeColumn: "TimeUnix",
		retentionDays: 90,
		batchRows: 250,
		batchBytes: 1024 * 1024,
	},
] as const

const RAW_TABLE_NAMES = new Set<string>(RAW_TABLES.map((table) => table.name))
const OPERATIONAL_TABLE_NAMES = new Set([
	"alert_checks",
	"session_events",
	"session_replay_events",
	"session_replays",
])
const MIN_MIGRATION_FREE_BYTES = 128 * 1024 * 1024

const derivedDisposition = (name: string): StateDispositionEntry => ({
	name,
	classification: "derived",
	disposition: "rebuild-within-retention-horizon",
	preservationInterval:
		"within the retention horizon of the raw source tables; older aggregate-only rows remain under legacy semantics",
	guarantee:
		"recomputed from retained raw telemetry; aggregate-only history stays with the retained legacy source and is not given a fabricated new dimension",
})

const knownDispositions: ReadonlyArray<StateDispositionEntry> = [
	...RAW_TABLES.map((table) => ({
		name: table.name,
		classification: "authoritative" as const,
		disposition: "preserve-exact" as const,
		preservationInterval: `[cutoff - ${table.retentionDays} days, cutoff]`,
		sourceRetentionDays: table.retentionDays,
		targetRetentionDays: table.retentionDays,
		guarantee:
			"all source columns and rows inside this table's configured retention horizon are copied explicitly after exact type compatibility checks; rows older than the interval remain in the retained source",
	})),
	...["alert_checks", "session_events", "session_replay_events", "session_replays"].map((name) => ({
		name,
		classification: "operational" as const,
		disposition: "retain-as-legacy-rollback-only" as const,
		preservationInterval: "entire retained source store",
		guarantee:
			"not copied into the new target; the old store remains available for rollback and inspection",
	})),
	...[...LOCAL_SCHEMA_MANIFEST.objects]
		.filter(
			(object) =>
				!RAW_TABLE_NAMES.has(object.name) &&
				!OPERATIONAL_TABLE_NAMES.has(object.name) &&
				object.kind === "table",
		)
		.map((object) => derivedDisposition(object.name)),
	...[...LOCAL_SCHEMA_MANIFEST.objects]
		.filter((object) => object.kind !== "table")
		.map((object) => ({
			name: object.name,
			classification: "derived" as const,
			disposition: "rebuild-complete" as const,
			preservationInterval:
				"within the retention horizon of the raw source tables; older aggregate-only rows remain under legacy semantics",
			guarantee: "recreated by the current target schema and repopulated by retained raw replay",
		})),
	{
		name: "checkpoint tree",
		classification: "operational",
		disposition: "retain-as-legacy-rollback-only",
		preservationInterval: "entire retained checkpoint tree",
		guarantee:
			"moves with the retained source; current-schema restore does not claim these fingerprint-bound checkpoints are compatible",
	},
	{
		name: "archive manifests and calibration",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "external archive root",
		guarantee:
			"the external ~/.maple/archive tree is not rewritten by local-store migration; its own schema and fingerprint checks remain authoritative",
	},
	{
		name: "source marker and store identity",
		classification: "operational",
		disposition: "retain-as-legacy-rollback-only",
		preservationInterval: "pre-cutover source",
		guarantee: "the source marker and stable store id are retained beside the rollback directory",
	},
	{
		name: "active-store selection",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "promotion commit",
		guarantee:
			"the configured data path remains the active path; selection changes only after target verification and the promotion journal is durable",
	},
	{
		name: "open sentinel, PID, and maintenance lock",
		classification: "ephemeral",
		disposition: "invalidate",
		preservationInterval: "migration operation",
		guarantee:
			"the source must be stopped and clean; no live-process or open-sentinel state is copied to the target, and the shared lock is released normally",
	},
	{
		name: "migration journal",
		classification: "operational",
		disposition: "preserve-exact",
		preservationInterval: "planned through promoted",
		guarantee:
			"durably records identities, cutoff, pending work, verification, and promotion recovery state",
	},
] as const

const LEGACY_TO_CURRENT: LocalStoreMigration = {
	id: "local-0000-to-0001-raw-replay",
	moduleVersion: 1,
	description: "Rebuild the current local store from the known fingerprint-only legacy store",
	fromVersion: LEGACY_LOCAL_SCHEMA.version,
	toVersion: CURRENT_LOCAL_SCHEMA.version,
	fromFingerprint: LEGACY_LOCAL_SCHEMA.fingerprint,
	toFingerprint: CURRENT_LOCAL_SCHEMA.fingerprint,
	operations: [
		{
			id: "preflight",
			description:
				"Validate the stopped source, chDB identity, raw-table columns, capacity, and migration cutoff",
			requiresQuiescence: true,
			phase: "preflight-complete",
		},
		{
			id: "bootstrap-target",
			description: "Create a fresh current-schema target and mark it staged",
			requiresQuiescence: true,
			phase: "target-created",
		},
		{
			id: "replay-raw-telemetry",
			description: "Copy the six authoritative raw tables with bounded, resumable JSONEachRow batches",
			requiresQuiescence: true,
			phase: "copying",
		},
		{
			id: "verify-and-promote",
			description:
				"Recheck source inventories, verify the target physical schema, then promote and retain the source",
			requiresQuiescence: true,
			phase: "copy-verified",
		},
	],
	dispositions: knownDispositions,
}

export const localStoreMigrations: ReadonlyArray<LocalStoreMigration> = [LEGACY_TO_CURRENT]

const moduleDigest = (migration: LocalStoreMigration): string =>
	createHash("sha256")
		.update(
			JSON.stringify({
				id: migration.id,
				moduleVersion: migration.moduleVersion,
				fromVersion: migration.fromVersion,
				toVersion: migration.toVersion,
				fromFingerprint: migration.fromFingerprint,
				toFingerprint: migration.toFingerprint,
				operations: migration.operations,
				dispositions: migration.dispositions,
			}),
		)
		.digest("hex")

/** Construction-time registry validation. The initial framework supports one
 * forward edge per version; this keeps chain selection deterministic without a
 * speculative general DAG. */
export const validateMigrationRegistry = (
	registry: ReadonlyArray<LocalStoreMigration>,
): ReadonlyArray<LocalStoreMigration> => {
	const ids = new Set<string>()
	const fromVersions = new Set<number>()
	for (const migration of registry) {
		if (ids.has(migration.id)) throw new Error(`duplicate local migration id: ${migration.id}`)
		ids.add(migration.id)
		if (fromVersions.has(migration.fromVersion)) {
			throw new Error(`ambiguous local migration path from schema version ${migration.fromVersion}`)
		}
		fromVersions.add(migration.fromVersion)
		if (!Number.isInteger(migration.moduleVersion) || migration.moduleVersion < 1) {
			throw new Error(`migration ${migration.id} has an invalid module version`)
		}
		if (!Number.isInteger(migration.fromVersion) || !Number.isInteger(migration.toVersion)) {
			throw new Error(`migration ${migration.id} has a non-integer schema version`)
		}
		if (migration.toVersion <= migration.fromVersion) {
			throw new Error(`migration ${migration.id} is not a forward migration`)
		}
		if (migration.operations.length === 0) throw new Error(`migration ${migration.id} has no operations`)
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
	if (marker.schema === CURRENT_LOCAL_SCHEMA.fingerprint) {
		return {
			...CURRENT_LOCAL_SCHEMA,
			chdb: marker.chdb,
		}
	}
	return null
}

export const resolveMigrationChain = (
	source: LocalSchemaIdentity,
	target: LocalSchemaIdentity = CURRENT_LOCAL_SCHEMA,
	registry: ReadonlyArray<LocalStoreMigration> = localStoreMigrations,
): ReadonlyArray<LocalStoreMigration> => {
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
		validateMigrationRegistry(registry).map((migration) => [migration.fromVersion, migration]),
	)
	const chain: LocalStoreMigration[] = []
	let current = source
	const visited = new Set<number>()
	while (current.version < target.version) {
		if (visited.has(current.version))
			throw new MigrationResolutionError("missing-path", "local migration registry contains a cycle")
		visited.add(current.version)
		const migration = byFrom.get(current.version)
		if (
			!migration ||
			(migration.fromFingerprint !== undefined && migration.fromFingerprint !== current.fingerprint)
		) {
			throw new MigrationResolutionError(
				"missing-path",
				`no registered local migration from schema ${identityLabel(current)} to v${target.version}`,
			)
		}
		chain.push(migration)
		current = {
			version: migration.toVersion,
			fingerprint: migration.toFingerprint,
			digest: migration.toVersion === target.version ? target.digest : "",
			chdb: target.chdb,
		}
	}
	if (current.version !== target.version || current.fingerprint !== target.fingerprint) {
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
		...plan.operations.map((operation, index) => `  ${index + 1}. ${operation.description}`),
		"preservation envelope:",
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
	if (resolve(journal.sourceDataDir) !== source) {
		throw new Error("local migration journal source does not match the configured data directory")
	}
	const root = migrationRootPath(dataDir, journal.migrationId)
	safeMigrationPath(journal.targetDataDir, root, "migration target")
	if (resolve(dirname(journal.targetDataDir)) !== resolve(join(root, "target"))) {
		throw new Error("local migration journal target is outside its owned target directory")
	}
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

const parseJournal = (value: unknown): MigrationJournal => {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("migration journal is not an object")
	const record = value as Record<string, unknown>
	const requiredStrings = [
		"migrationId",
		"moduleDigest",
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
	for (const key of ["sourceVersion", "targetVersion"] as const)
		if (!Number.isInteger(record[key])) throw new Error(`migration journal ${key} is invalid`)
	if (record.formatVersion !== 1)
		throw new Error(`unsupported migration journal format ${String(record.formatVersion)}`)
	if (!migrationIdPattern.test(record.migrationId as string))
		throw new Error("migration journal id is unsafe")
	return {
		formatVersion: 1,
		migrationId: record.migrationId as string,
		moduleDigest: record.moduleDigest as string,
		phase: parsePhase(record.phase),
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
		...(record.sourceInventory === undefined
			? {}
			: { sourceInventory: record.sourceInventory as Record<string, TableInventory> }),
		...(record.copied === undefined ? {} : { copied: record.copied as Record<string, CopyProgress> }),
		...(record.pendingBatch === undefined ? {} : { pendingBatch: record.pendingBatch as PendingBatch }),
		...(record.failure === undefined ? {} : { failure: record.failure as string }),
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

export const localMigrationIsIncomplete = async (dataDir: string): Promise<boolean> => {
	const journal = await readMigrationJournal(dataDir)
	return journal !== null && isMigrationIncomplete(journal.phase)
}

/** Explicitly abandon an unfinished transaction while preserving its journal
 * and every source/target directory for forensic recovery. This is only used
 * by the destructive reset path; ordinary startup and migration never discard
 * an incomplete transaction. */
export const abandonLocalStoreMigration = async (dataDir: string): Promise<string | null> => {
	const path = migrationJournalPath(dataDir)
	const journal = await readMigrationJournal(dataDir)
	if (journal === null || !isMigrationIncomplete(journal.phase)) return null
	await assertRealFile(path, "migration journal")
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

const identifier = (value: string): string => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe ClickHouse identifier: ${value}`)
	return `\`${value}\``
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`

const timestampLiteral = (value: string): string => `parseDateTime64BestEffort(${sqlString(value)}, 9, 'UTC')`

const retentionStartAt = (cutoffAt: string, retentionDays: number): string => {
	const cutoff = Date.parse(cutoffAt)
	if (!Number.isFinite(cutoff)) throw new Error(`invalid migration cutoff: ${cutoffAt}`)
	return new Date(cutoff - retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

const numberString = (value: unknown): string => String(value)

const openDb = (dataDir: string, bootstrapSchema: boolean): Chdb =>
	Chdb.open({ dataDir, schemaSql: LOCAL_SCHEMA_SQL, bootstrapSchema })

const withDb = async <A>(
	dataDir: string,
	bootstrapSchema: boolean,
	fn: (db: Chdb) => A | Promise<A>,
): Promise<A> => {
	const db = openDb(dataDir, bootstrapSchema)
	try {
		return await fn(db)
	} finally {
		db.close()
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
	// The source is retained after cutover, and materialized views/indexes can
	// temporarily make the target larger than the raw parts being copied. The
	// checkpoint tree also remains with the retained source and must fit beside it.
	const requiredBytes = Math.max(MIN_MIGRATION_FREE_BYTES, sourceBytes * 2 + checkpointBytes)
	if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
		throw new Error(
			`insufficient free space for a side-by-side migration (estimated source: ${Math.round(sourceBytes)} bytes; ` +
				`checkpoints: ${Math.round(checkpointBytes)} bytes; ` +
				`free: ${Math.round(freeBytes)} bytes; required: ${Math.round(requiredBytes)} bytes)`,
		)
	}
}

interface ColumnRow {
	table: string
	name: string
	type: string
	position: number
	default_kind: string
	default_expression: string
	compression_codec: string
}

const tableColumns = async (dataDir: string, table: string): Promise<ReadonlyArray<LocalSchemaColumn>> =>
	withDb(dataDir, false, (db) => {
		const rows = parseJsonEachRow<ColumnRow>(
			db.query(
				`SELECT name, type, position, default_kind, default_expression, compression_codec FROM system.columns WHERE database = 'default' AND table = ${sqlString(table)} ORDER BY position`,
			),
		)
		return rows.map((row) => ({
			name: row.name,
			type: row.type,
			...(!row.default_kind ? {} : { defaultKind: row.default_kind }),
			...(!row.default_expression ? {} : { defaultExpression: row.default_expression }),
			...(!row.compression_codec || row.compression_codec === "NONE"
				? {}
				: { codec: row.compression_codec }),
		}))
	})

const tableExists = async (dataDir: string, table: string): Promise<boolean> =>
	withDb(
		dataDir,
		false,
		(db) =>
			parseJsonEachRow<{ name: string }>(
				db.query(
					`SELECT name FROM system.tables WHERE database = 'default' AND name = ${sqlString(table)}`,
				),
			).length > 0,
	)

const sourceObjectNames = async (dataDir: string): Promise<ReadonlyArray<string>> =>
	withDb(dataDir, false, (db) =>
		parseJsonEachRow<{ name: string }>(
			db.query("SELECT name FROM system.tables WHERE database = 'default' ORDER BY name"),
		).map((row) => row.name),
	)

const assertKnownSourceObjects = async (dataDir: string): Promise<void> => {
	const known = new Set(LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name))
	for (const name of await sourceObjectNames(dataDir)) {
		if (!known.has(name)) {
			throw new Error(
				`source contains an unknown local-store object: ${name}; migration is unsupported`,
			)
		}
	}
}

const tableTotalRowCount = async (dataDir: string, table: string): Promise<string> =>
	withDb(dataDir, false, (db) => {
		const rows = parseJsonEachRow<{ rowCount: string | number }>(
			db.query(`SELECT count() AS rowCount FROM ${identifier(table)}`),
		)
		if (!rows[0]) throw new Error(`row-count query returned no row for ${table}`)
		return numberString(rows[0].rowCount)
	})

const inventory = async (
	dataDir: string,
	table: (typeof RAW_TABLES)[number],
	columns: ReadonlyArray<LocalSchemaColumn>,
	cutoffAt: string,
): Promise<TableInventory> =>
	withDb(dataDir, false, (db) => {
		const lowerBound = retentionStartAt(cutoffAt, table.retentionDays)
		const names = columns.map((column) => identifier(column.name)).join(", ")
		const hash = `cityHash64(toString(tuple(${names})))`
		const rows = parseJsonEachRow<{
			rowCount: string | number
			minTime: string | null
			maxTime: string | null
			hashSum: string | number
			hashXor: string | number
		}>(
			db.query(
				`SELECT count() AS rowCount, min(${identifier(table.timeColumn)}) AS minTime, max(${identifier(table.timeColumn)}) AS maxTime, sum(${hash}) AS hashSum, groupBitXor(${hash}) AS hashXor FROM ${identifier(table.name)} WHERE ${identifier(table.timeColumn)} >= ${timestampLiteral(lowerBound)} AND ${identifier(table.timeColumn)} <= ${timestampLiteral(cutoffAt)}`,
			),
		)
		const row = rows[0]
		if (!row) throw new Error(`inventory query returned no row for ${table.name}`)
		return {
			table: table.name,
			rowCount: numberString(row.rowCount),
			retentionStartAt: lowerBound,
			minTime: row.minTime === null ? null : String(row.minTime),
			maxTime: row.maxTime === null ? null : String(row.maxTime),
			hashSum: numberString(row.hashSum),
			hashXor: numberString(row.hashXor),
		}
	})

const inventoriesEqual = (a: TableInventory, b: TableInventory): boolean =>
	a.table === b.table &&
	a.rowCount === b.rowCount &&
	a.retentionStartAt === b.retentionStartAt &&
	a.minTime === b.minTime &&
	a.maxTime === b.maxTime &&
	a.hashSum === b.hashSum &&
	a.hashXor === b.hashXor

const copyProgressFor = (journal: MigrationJournal, table: string): CopyProgress =>
	journal.copied?.[table] ?? {
		rows: 0,
		bytes: 0,
		lastTimestamp: null,
		lastHash: null,
		lastTieBreak: null,
		duplicateCount: 0,
	}

const updateJournal = async (
	dataDir: string,
	journal: MigrationJournal,
	update: Partial<MigrationJournal>,
): Promise<MigrationJournal> => {
	const next = { ...journal, ...update }
	await writeMigrationJournal(dataDir, next)
	return next
}

const batchSignature = (table: string, rows: ReadonlyArray<Record<string, unknown>>): string =>
	`${table}:${rows.length}:${JSON.stringify(rows[0] ?? null)}:${JSON.stringify(rows[rows.length - 1] ?? null)}`

const copyTable = async (
	dataDir: string,
	targetDataDir: string,
	table: (typeof RAW_TABLES)[number],
	columns: ReadonlyArray<LocalSchemaColumn>,
	cutoffAt: string,
	journal: MigrationJournal,
): Promise<MigrationJournal> => {
	let current = journal
	let progress = copyProgressFor(current, table.name)
	const columnList = columns.map((column) => identifier(column.name)).join(", ")
	// The second independent tie-break makes duplicate timestamp groups
	// deterministic enough to resume without OFFSET. It is still not a
	// cryptographic proof; the full source/target inventory is the promotion gate
	// and an ambiguous pending insert fails closed.
	const hashExpression = `cityHash64(toString(tuple(${columnList})))`
	const tieBreakExpression = `sipHash64(toString(tuple(${columnList})))`
	while (true) {
		const cursor =
			progress.lastTimestamp === null || progress.lastHash === null || progress.lastTieBreak === null
				? ""
				: `AND (${identifier(table.timeColumn)} > ${timestampLiteral(progress.lastTimestamp)} OR (${identifier(table.timeColumn)} = ${timestampLiteral(progress.lastTimestamp)} AND (${hashExpression} > ${progress.lastHash} OR (${hashExpression} = ${progress.lastHash} AND ${tieBreakExpression} >= ${progress.lastTieBreak}))))`
		const output = await withDb(dataDir, false, (db) =>
			db.query(
				`SELECT ${columnList}, ${identifier(table.timeColumn)} AS __maple_timestamp, ${hashExpression} AS __maple_hash, ${tieBreakExpression} AS __maple_tie_break FROM ${identifier(table.name)} WHERE ${identifier(table.timeColumn)} >= ${timestampLiteral(retentionStartAt(cutoffAt, table.retentionDays))} AND ${identifier(table.timeColumn)} <= ${timestampLiteral(cutoffAt)} ${cursor} ORDER BY ${identifier(table.timeColumn)}, __maple_hash, __maple_tie_break LIMIT ${table.batchRows}`,
			),
		)
		const rawRows = parseJsonEachRow<
			Record<string, unknown> & {
				__maple_timestamp?: string
				__maple_hash?: string | number
				__maple_tie_break?: string | number
			}
		>(output)
		let rows = rawRows
		if (
			progress.lastTimestamp !== null &&
			progress.lastHash !== null &&
			progress.lastTieBreak !== null &&
			progress.duplicateCount > 0
		) {
			let skip = progress.duplicateCount
			rows = rows.filter((row) => {
				const same =
					String(row.__maple_timestamp) === progress.lastTimestamp &&
					String(row.__maple_hash) === progress.lastHash &&
					String(row.__maple_tie_break) === progress.lastTieBreak
				if (same && skip > 0) {
					skip -= 1
					return false
				}
				return true
			})
		}
		if (rows.length === 0) break
		const candidates = rows.map((row) => {
			const copy = { ...row }
			delete copy.__maple_timestamp
			delete copy.__maple_hash
			delete copy.__maple_tie_break
			return { row, copy, encoded: JSON.stringify(copy) }
		})
		const selected: typeof candidates = []
		let byteLength = 0
		for (const candidate of candidates) {
			const candidateBytes = Buffer.byteLength(candidate.encoded)
			if (selected.length > 0 && byteLength + candidateBytes + 1 > table.batchBytes) break
			selected.push(candidate)
			byteLength += candidateBytes + (selected.length === 1 ? 0 : 1)
		}
		if (selected.length === 0) throw new Error(`could not form a bounded batch for ${table.name}`)
		rows = selected.map((candidate) => candidate.row)
		const payload = selected.map((candidate) => candidate.copy)
		const first = rows[0]!
		const last = rows[rows.length - 1]!
		const lastKeyCount = rows.filter(
			(row) =>
				String(row.__maple_timestamp ?? "") === String(last.__maple_timestamp ?? "") &&
				String(row.__maple_hash ?? "") === String(last.__maple_hash ?? "") &&
				String(row.__maple_tie_break ?? "") === String(last.__maple_tie_break ?? ""),
		).length
		const pending: PendingBatch = {
			table: table.name,
			rowCount: payload.length,
			byteLength,
			firstTimestamp: first.__maple_timestamp === undefined ? null : String(first.__maple_timestamp),
			firstHash: first.__maple_hash === undefined ? null : String(first.__maple_hash),
			firstTieBreak: first.__maple_tie_break === undefined ? null : String(first.__maple_tie_break),
			lastTimestamp: last.__maple_timestamp === undefined ? null : String(last.__maple_timestamp),
			lastHash: last.__maple_hash === undefined ? null : String(last.__maple_hash),
			lastTieBreak: last.__maple_tie_break === undefined ? null : String(last.__maple_tie_break),
			lastKeyCount,
			signature: batchSignature(table.name, payload),
		}
		current = await updateJournal(dataDir, current, { phase: "copying", pendingBatch: pending })
		const insertSql = `INSERT INTO ${identifier(table.name)} (${columnList}) FORMAT JSONEachRow\n${selected.map((candidate) => candidate.encoded).join("\n")}`
		await withDb(targetDataDir, false, (db) => db.exec(insertSql))
		const lastTimestamp = pending.lastTimestamp
		const lastHash = pending.lastHash
		const lastTieBreak = pending.lastTieBreak
		progress = {
			rows: progress.rows + payload.length,
			bytes: progress.bytes + byteLength,
			lastTimestamp,
			lastHash,
			lastTieBreak,
			duplicateCount: pending.lastKeyCount,
		}
		const copied = { ...current.copied, [table.name]: progress }
		current = await updateJournal(dataDir, current, { copied, pendingBatch: undefined })
	}
	return current
}

const ensureSourceTargetColumns = async (
	dataDir: string,
	targetDataDir: string,
	table: (typeof RAW_TABLES)[number],
): Promise<ReadonlyArray<LocalSchemaColumn>> => {
	const sourceColumns = await tableColumns(dataDir, table.name)
	const targetColumns = await tableColumns(targetDataDir, table.name)
	const targetByName = new Map(targetColumns.map((column) => [column.name, column]))
	for (const source of sourceColumns) {
		if (source.name.startsWith("__maple_"))
			throw new Error(`${table.name}.${source.name} uses a reserved migration column name`)
	}
	for (const source of sourceColumns) {
		const target = targetByName.get(source.name)
		if (target === undefined)
			throw new Error(`${table.name}.${source.name} is missing from the target schema`)
		if (normalizeType(target.type) !== normalizeType(source.type)) {
			throw new Error(
				`${table.name}.${source.name} type changed (${source.type} -> ${target.type}) without a transform`,
			)
		}
	}
	const sourceNames = new Set(sourceColumns.map((column) => column.name))
	for (const target of targetColumns) {
		if (!sourceNames.has(target.name) && target.defaultKind === undefined) {
			throw new Error(
				`${table.name}.${target.name} is new in the target and has no declared default or transform`,
			)
		}
	}
	return sourceColumns
}

const normalizeType = (value: string): string =>
	value
		.replace(/\s+/g, " ")
		.replace(/\s*,\s*/g, ", ")
		.trim()

const sourceMarkerId = (marker: StoreMarker): string =>
	marker.formatVersion === 2 ? marker.storeId : `legacy-${marker.schema || "unversioned"}-${randomUUID()}`

const assertRealDirectory = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`${label} must be a real directory: ${path}`)
}

const assertRealFile = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real file: ${path}`)
}

const assertSameFilesystemPromotion = async (dataDir: string): Promise<void> => {
	const source = await stat(resolve(dataDir))
	const parent = await stat(dirname(resolve(dataDir)))
	if (source.dev !== parent.dev) {
		throw new Error(
			"side-by-side promotion would cross filesystems (EXDEV); keep the source and its migration root on the same filesystem and retry",
		)
	}
}

const targetMarker = (dataDir: string): StoreMarkerV2 | null => {
	const marker = readMarker(dataDir)
	return marker?.formatVersion === 2 ? marker : null
}

const promote = async (
	dataDir: string,
	journal: MigrationJournal,
): Promise<{ journal: MigrationJournal; sourceRollbackDir: string }> => {
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
	journal = await updateJournal(dataDir, journal, { phase: "promotion-started" })

	const validateTargetMarker = (
		marker: StoreMarkerV2 | null,
		activation: "active" | "staging",
	): StoreMarkerV2 => {
		if (!marker) throw new Error("migration target marker is missing or invalid")
		if (marker.storeId !== journal.targetStoreId)
			throw new Error("migration target store id does not match the journal")
		if (
			marker.schemaVersion !== journal.targetVersion ||
			marker.schema !== journal.targetFingerprint ||
			marker.schemaDigest !== journal.targetDigest
		) {
			throw new Error("migration target marker identity does not match the journal")
		}
		if (marker.activation !== activation) throw new Error(`migration target marker is not ${activation}`)
		return marker
	}

	const finish = async (
		marker: StoreMarkerV2,
	): Promise<{ journal: MigrationJournal; sourceRollbackDir: string }> => {
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
		return { journal: promoted, sourceRollbackDir: sourceData }
	}

	const activeExists = existsSync(activeData)
	const sourceExists = existsSync(sourceData)
	const targetExists = existsSync(targetData)
	if (existsSync(activeMarker)) await assertRealFile(activeMarker, "active store marker")

	// A crash after target/data was renamed but before its marker was moved leaves
	// the target active, the source retained, and the staged marker still in the
	// target root. Complete only that unambiguous final step.
	if (activeExists && sourceExists && !targetExists) {
		await assertRealDirectory(activeData, "active target data")
		let marker = targetMarker(activeData)
		if (marker === null) {
			if (!existsSync(stagedMarker)) {
				throw new Error("promotion has an active target but no staged marker to recover")
			}
			await assertRealFile(stagedMarker, "staged target marker")
			await durableRename(stagedMarker, activeMarker)
			marker = targetMarker(activeData)
			return finish(validateTargetMarker(marker, "staging"))
		}
		return finish(validateTargetMarker(marker, marker.activation))
	}
	if (activeExists && sourceExists) {
		throw new Error(
			"source and active directories both exist before target cutover; promotion is ambiguous",
		)
	}
	if (!activeExists && !sourceExists) {
		throw new Error("both the source and rollback directories are missing; promotion is ambiguous")
	}

	if (!targetExists) throw new Error("migration target disappeared before promotion")
	await assertRealDirectory(targetData, "migration target")
	const marker = validateTargetMarker(targetMarker(journal.targetDataDir), "staging")
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
	if (!existsSync(stagedMarker)) throw new Error("staged target marker disappeared before promotion")
	await durableRename(stagedMarker, activeMarker)
	return finish(marker)
}

const reconcilePromotion = async (dataDir: string, journal: MigrationJournal): Promise<MigrationJournal> => {
	const active = resolve(dataDir)
	const sourceData = join(migrationRootPath(dataDir, journal.migrationId), "source", "data")
	const targetData = resolve(journal.targetDataDir)
	const activeMarker = readMarker(dataDir)
	if (
		existsSync(active) &&
		activeMarker?.formatVersion === 2 &&
		activeMarker.activation === "active" &&
		activeMarker.storeId === journal.targetStoreId &&
		activeMarker.schemaVersion === journal.targetVersion &&
		activeMarker.schema === journal.targetFingerprint &&
		activeMarker.schemaDigest === journal.targetDigest
	) {
		return updateJournal(dataDir, journal, { phase: "promoted" })
	}
	if (!existsSync(active) && !existsSync(targetData) && !existsSync(sourceData)) {
		throw new Error(
			"migration promotion was interrupted in an ambiguous filesystem state; preserve all directories and inspect the journal",
		)
	}
	return (await promote(dataDir, journal)).journal
}

/** Filesystem-only promotion recovery seam used by fault-injection tests and
 * by the migration coordinator after a process restart. */
export const reconcileLocalStorePromotion = reconcilePromotion

const checkPendingBatch = async (journal: MigrationJournal): Promise<MigrationJournal> => {
	const pending = journal.pendingBatch
	if (!pending) return journal
	const target = journal.targetDataDir
	const table = RAW_TABLES.find((candidate) => candidate.name === pending.table)
	if (!table) throw new Error(`journal contains an unknown pending table: ${pending.table}`)
	const columns = await tableColumns(target, table.name)
	const current = await inventory(target, table, columns, journal.cutoffAt)
	const progress = copyProgressFor(journal, table.name)
	const targetRows = Number(current.rowCount)
	if (targetRows === progress.rows) return { ...journal, pendingBatch: undefined }
	if (targetRows === progress.rows + pending.rowCount) {
		return {
			...journal,
			copied: {
				...journal.copied,
				[table.name]: {
					rows: progress.rows + pending.rowCount,
					bytes: progress.bytes + pending.byteLength,
					lastTimestamp: pending.lastTimestamp,
					lastHash: pending.lastHash,
					lastTieBreak: pending.lastTieBreak,
					duplicateCount: pending.lastKeyCount,
				},
			},
			pendingBatch: undefined,
		}
	}
	throw new Error("pending migration batch has ambiguous target state; refusing to guess or duplicate rows")
}

export interface RunMigrationOptions {
	readonly dataDir: string
	readonly dryRun?: boolean
	readonly onProgress?: (message: string) => void
}

const withMigrationMaintenanceLock = async <A>(
	dataDir: string,
	operationId: string,
	fn: () => Promise<A>,
): Promise<A> => {
	// Keep the pure registry/marker/status seams importable without pulling the
	// checkpoint server module (and its telemetry graph) into unit tests. The
	// actual migration still shares the exact maintenance lock used by restore,
	// reset, and archive operations.
	const { resetTransactionPath, restoreTransactionPath, withMaintenanceLock } =
		await import("./checkpoints")
	return withMaintenanceLock(dataDir, operationId, async () => {
		if (existsSync(restoreTransactionPath(dataDir)) || existsSync(resetTransactionPath(dataDir))) {
			throw new Error(
				"checkpoint recovery is pending; run maple start once to reconcile it before migrating the local store",
			)
		}
		return fn()
	})
}

export const runLocalStoreMigration = async (
	options: RunMigrationOptions,
): Promise<MigrationResult | MigrationPlan> => {
	const dataDir = resolve(options.dataDir)
	const existingJournal = await readMigrationJournal(dataDir)
	const markerState = readMarker(dataDir)
	if (!markerState && existingJournal === null)
		throw new Error(
			"the source store has no readable marker; unknown stores fail closed and cannot be migrated",
		)
	if (existingJournal?.phase === "promoted" && !options.dryRun) {
		if (!markerState) throw new Error("promoted migration has no readable active store marker")
		return {
			migrationId: existingJournal.migrationId,
			phase: existingJournal.phase,
			cutoffAt: existingJournal.cutoffAt,
			sourceRollbackDir: join(
				migrationRootPath(dataDir, existingJournal.migrationId),
				"source",
				"data",
			),
			targetDataDir: dataDir,
			copiedRows: Object.fromEntries(
				Object.entries(existingJournal.copied ?? {}).map(([table, progress]) => [
					table,
					progress.rows,
				]),
			),
		}
	}
	if (!markerState && existingJournal !== null && existingJournal.phase !== "promotion-started") {
		throw new Error("unfinished migration has no readable source marker; refusing to resume")
	}
	const journalSourceIdentity =
		existingJournal === null
			? null
			: {
					version: existingJournal.sourceVersion,
					fingerprint: existingJournal.sourceFingerprint,
					digest: "",
					chdb: existingJournal.sourceChdb,
				}
	const sourceIdentity =
		existingJournal?.phase === "promotion-started"
			? journalSourceIdentity
			: markerState !== null
				? identityFromMarker(markerState)
				: journalSourceIdentity
	const sourceFingerprint =
		sourceIdentity?.fingerprint ?? markerState?.schema ?? existingJournal?.sourceFingerprint ?? "<none>"
	if (!sourceIdentity)
		throw new Error(
			`the source fingerprint ${sourceFingerprint} is not registered; use an explicit reset only if data loss is acceptable`,
		)
	const compatibility =
		markerState === null && existingJournal?.phase === "promotion-started"
			? { compatible: true as const }
			: checkStoreCompatible(dataDir)
	if (!compatibility.compatible)
		throw new Error(`source is not compatible with this chDB build: ${compatibility.found}`)
	const plan = planMigration(sourceIdentity)
	if (options.dryRun) return plan
	assertNoLiveServer(dataDir)
	const promotionRecovery = existingJournal?.phase === "promotion-started"
	if (!promotionRecovery) {
		if (!storeHasData(dataDir))
			throw new Error("the local store is empty; start normally to bootstrap it instead of migrating")
		await assertRealDirectory(dataDir, "source data")
		await assertRealFile(storeMarkerPath(dataDir), "source store marker")
		if (isStoreDirty(dataDir))
			throw new Error(
				"source store was not cleanly closed; restore or cleanly stop it before migrating",
			)
	}
	const operationId = randomUUID()
	return withMigrationMaintenanceLock(dataDir, operationId, async () => {
		assertNoLiveServer(dataDir)
		if (isStoreDirty(dataDir))
			throw new Error(
				"source store became dirty before the migration lock was acquired; refusing to continue",
			)
		let journal = await readMigrationJournal(dataDir)
		try {
			if (journal?.phase === "promoted") {
				return {
					migrationId: journal.migrationId,
					phase: journal.phase,
					cutoffAt: journal.cutoffAt,
					sourceRollbackDir: join(
						migrationRootPath(dataDir, journal.migrationId),
						"source",
						"data",
					),
					targetDataDir: dataDir,
					copiedRows: Object.fromEntries(
						Object.entries(journal.copied ?? {}).map(([table, progress]) => [
							table,
							progress.rows,
						]),
					),
				}
			}
			if (journal) {
				assertJournalPaths(dataDir, journal)
				if (journal.phase !== "promotion-started" && existsSync(journal.targetDataDir))
					await assertRealDirectory(journal.targetDataDir, "migration target data")
				const migration = plan.chain[0]
				if (!migration || journal.moduleDigest !== moduleDigest(migration))
					throw new Error("unfinished local migration was created by a different migration module")
				if (
					journal.phase !== "promotion-started" &&
					markerState?.formatVersion === 2 &&
					(markerState.storeId !== journal.sourceStoreId ||
						(journal.sourceDigest !== "" && markerState.schemaDigest !== journal.sourceDigest))
				)
					throw new Error(
						"unfinished local migration source store id does not match the active marker",
					)
				if (
					journal.sourceChdb !== sourceIdentity.chdb ||
					journal.targetChdb !== CURRENT_LOCAL_SCHEMA.chdb
				)
					throw new Error(
						"unfinished local migration requires a different chDB build; refusing to resume",
					)
				if (!journal.migrationId.startsWith(`${plan.chain[0]?.id ?? ""}-`))
					throw new Error("an unfinished migration for a different module is present")
				if (journal.phase === "promotion-started")
					journal = await reconcilePromotion(dataDir, journal)
				if (journal.phase === "promoted") {
					return {
						migrationId: journal.migrationId,
						phase: journal.phase,
						cutoffAt: journal.cutoffAt,
						sourceRollbackDir: join(
							migrationRootPath(dataDir, journal.migrationId),
							"source",
							"data",
						),
						targetDataDir: dataDir,
						copiedRows: Object.fromEntries(
							Object.entries(journal.copied ?? {}).map(([table, progress]) => [
								table,
								progress.rows,
							]),
						),
					}
				}
			}
			if (!journal) {
				if (plan.chain.length === 0) throw new Error("store already has the current schema")
				if (!markerState)
					throw new Error("cannot create a migration without a readable source marker")
				await ensureMigrationCapacity(dataDir)
				await assertKnownSourceObjects(dataDir)
				const migration = plan.chain[0]!
				const migrationId = `${migration.id}-${randomUUID()}`
				const root = migrationRootPath(dataDir, migrationId)
				if (!migrationIdPattern.test(migrationId)) throw new Error("unsafe generated migration id")
				const targetDataDir = join(root, "target", "data")
				await ensurePrivateDirectory(root)
				await ensurePrivateDirectory(join(root, "target"))
				if (existsSync(targetDataDir))
					throw new Error(
						"migration target directory already exists without a journal; refusing to reuse it",
					)
				const targetStoreId = randomUUID()
				journal = {
					formatVersion: 1,
					migrationId,
					moduleDigest: moduleDigest(migration),
					phase: "planned",
					sourceDataDir: dataDir,
					sourceStoreId: sourceMarkerId(markerState!),
					sourceChdb: sourceIdentity.chdb,
					sourceFingerprint: sourceIdentity.fingerprint,
					sourceDigest: sourceIdentity.digest,
					sourceVersion: sourceIdentity.version,
					targetDataDir,
					targetStoreId,
					targetChdb: CURRENT_LOCAL_SCHEMA.chdb,
					targetFingerprint: CURRENT_LOCAL_SCHEMA.fingerprint,
					targetDigest: CURRENT_LOCAL_SCHEMA.digest,
					targetVersion: CURRENT_LOCAL_SCHEMA.version,
					cutoffAt: new Date().toISOString(),
					createdAt: new Date().toISOString(),
				}
				await writeMigrationJournal(dataDir, journal)
				await updateJournal(dataDir, journal, { phase: "preflight-complete" })
				journal = (await readMigrationJournal(dataDir))!
				await withDb(targetDataDir, true, (db) => assertCurrentPhysicalSchema(db))
				await ensureStoreMarkerDurable(
					targetDataDir,
					CURRENT_LOCAL_SCHEMA,
					MAPLE_VERSION,
					journal.createdAt,
					{
						activation: "staging",
						storeId: targetStoreId,
					},
				)
				journal = await updateJournal(dataDir, journal, { phase: "target-created" })
			}
			if (journal.phase === "planned")
				journal = await updateJournal(dataDir, journal, { phase: "preflight-complete" })
			if (journal.phase === "preflight-complete") {
				await withDb(journal.targetDataDir, true, (db) => assertCurrentPhysicalSchema(db))
				await ensureStoreMarkerDurable(
					journal.targetDataDir,
					CURRENT_LOCAL_SCHEMA,
					MAPLE_VERSION,
					journal.createdAt,
					{
						activation: "staging",
						storeId: journal.targetStoreId,
					},
				)
				journal = await updateJournal(dataDir, journal, { phase: "target-created" })
			}
			journal = await checkPendingBatch(journal)
			const targetMarkerValue = readMarker(journal.targetDataDir)
			if (
				!targetMarkerValue ||
				targetMarkerValue.formatVersion !== 2 ||
				targetMarkerValue.activation !== "staging" ||
				targetMarkerValue.storeId !== journal.targetStoreId ||
				targetMarkerValue.schemaVersion !== journal.targetVersion ||
				targetMarkerValue.schema !== journal.targetFingerprint ||
				targetMarkerValue.schemaDigest !== journal.targetDigest
			) {
				throw new Error("migration target is not the journal's staged v2 store")
			}
			await assertKnownSourceObjects(dataDir)
			const copied: Record<string, CopyProgress> = { ...journal.copied }
			const sourceInventory: Record<string, TableInventory> = { ...journal.sourceInventory }
			for (const table of RAW_TABLES) {
				if (!(await tableExists(dataDir, table.name)))
					throw new Error(`source authoritative table is missing: ${table.name}`)
				const columns = await ensureSourceTargetColumns(dataDir, journal.targetDataDir, table)
				if (!sourceInventory[table.name])
					sourceInventory[table.name] = await inventory(dataDir, table, columns, journal.cutoffAt)
				journal = await updateJournal(dataDir, journal, { phase: "copying", sourceInventory, copied })
				journal = await copyTable(
					dataDir,
					journal.targetDataDir,
					table,
					columns,
					journal.cutoffAt,
					journal,
				)
				copied[table.name] = copyProgressFor(journal, table.name)
				options.onProgress?.(`${table.name}: ${copied[table.name]!.rows} rows copied`)
			}
			for (const table of RAW_TABLES) {
				const columns = await tableColumns(dataDir, table.name)
				const before = sourceInventory[table.name]!
				const after = await inventory(dataDir, table, columns, journal.cutoffAt)
				if (!inventoriesEqual(before, after))
					throw new Error(`source changed during migration: ${table.name}; promotion refused`)
				const targetInventory = await inventory(
					journal.targetDataDir,
					table,
					columns,
					journal.cutoffAt,
				)
				if (!inventoriesEqual(before, targetInventory))
					throw new Error(`target verification failed for ${table.name}`)
				if (
					(await tableTotalRowCount(journal.targetDataDir, table.name)) !== targetInventory.rowCount
				)
					throw new Error(`target contains rows outside the migration interval for ${table.name}`)
			}
			await withDb(journal.targetDataDir, false, (db) => assertCurrentPhysicalSchema(db))
			journal = await updateJournal(dataDir, journal, {
				phase: "copy-verified",
				pendingBatch: undefined,
			})
			await assertSameFilesystemPromotion(dataDir)
			const promoted = await promote(dataDir, journal)
			return {
				migrationId: promoted.journal.migrationId,
				phase: promoted.journal.phase,
				cutoffAt: promoted.journal.cutoffAt,
				sourceRollbackDir: promoted.sourceRollbackDir,
				targetDataDir: dataDir,
				copiedRows: Object.fromEntries(
					Object.entries(promoted.journal.copied ?? {}).map(([table, progress]) => [
						table,
						progress.rows,
					]),
				),
			}
		} catch (error) {
			const persisted = await readMigrationJournal(dataDir).catch(() => null)
			const failedJournal = persisted ?? journal
			if (failedJournal !== null && failedJournal.phase !== "promoted") {
				// Keep promotion-started as a recoverable phase: the filesystem
				// reconciler must see it after a crash or a fault between renames.
				await updateJournal(dataDir, failedJournal, {
					phase:
						failedJournal.phase === "planned" ||
						failedJournal.phase === "preflight-complete" ||
						failedJournal.phase === "promotion-started"
							? failedJournal.phase
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

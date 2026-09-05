// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// Generic local-store migration coordinator.
//
// The coordinator owns process safety, journaling, chain progression, staging,
// and promotion. Transition-specific table names, transforms, verification,
// and recovery live in statically registered, typed migration modules.

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, statfsSync } from "node:fs"
import { lstat, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Schema } from "effect"
import { Chdb } from "./chdb"
import { decodeJsonEachRow } from "./chdb-rows"
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
import { durableJson, durableRename, ensurePrivateDirectory, syncTree } from "./durable-files"
import { MAPLE_VERSION } from "../version"
import { decodeMigrationJournal, type MigrationJournalSchema } from "./local-store-migrations/journal-schema"
import { legacyToCurrentModule } from "./local-store-migrations/legacy-to-current"
import { v1ToV2ErrorRollupModule } from "./local-store-migrations/v1-to-v2-error-rollup"
import { v2ToV3ServiceMapIngestBridgeModule } from "./local-store-migrations/v2-to-v3-service-map-ingest-bridge"
import { v3ToV4WebEventsModule } from "./local-store-migrations/v3-to-v4-web-events"
import { v4ToV5ServiceOverviewMinutelyModule } from "./local-store-migrations/v4-to-v5-service-overview-minutely"
import { v5ToV6ErrorEventsFingerprintHygieneModule } from "./local-store-migrations/v5-to-v6-error-events-fingerprint-hygiene"
import { v6ToV7ErrorServiceVersionModule } from "./local-store-migrations/v6-to-v7-error-service-version"
import { v7ToV8AppleCrashFramesModule } from "./local-store-migrations/v7-to-v8-apple-crash-frames"
import { v8ToV9MvSweepModule } from "./local-store-migrations/v8-to-v9-mv-sweep"
import { v9ToV10SemconvKeyRenamesModule } from "./local-store-migrations/v9-to-v10-semconv-key-renames"
import { v10ToV11ProductEventsModule } from "./local-store-migrations/v10-to-v11-product-events"
import { v11ToV12ServiceMapEdgeQuantilesModule } from "./local-store-migrations/v11-to-v12-service-map-edge-quantiles"
import { v12ToV13ServiceOperationsDiscriminatorsModule } from "./local-store-migrations/v12-to-v13-service-operations-discriminators"
import { v13ToV14AiTraceIndexModule } from "./local-store-migrations/v13-to-v14-ai-trace-index"
import { v14ToV15CommitShaVcsRevisionModule } from "./local-store-migrations/v14-to-v15-commit-sha-vcs-revision"
import { v15ToV16AiTraceIndexFilterColumnsModule } from "./local-store-migrations/v15-to-v16-ai-trace-index-filter-columns"
import { v16ToV17AuditLogModule } from "./local-store-migrations/v16-to-v17-audit-log"
import { v17ToV18ProductEventsFromTracesModule } from "./local-store-migrations/v17-to-v18-product-events-from-traces"
import { v18ToV19ErrorEventsAttributeFallbackModule } from "./local-store-migrations/v18-to-v19-error-events-attribute-fallback"
import type {
	AnyLocalStoreMigrationModule,
	LocalStoreMigration,
	MigrationDbOptions,
	MigrationModuleContext,
	MigrationPhase,
	MigrationStepJournal,
} from "./local-store-migration-module"

export {
	type AnyLocalStoreMigrationModule,
	type LocalStoreMigration,
	type MigrationModuleContext,
	type MigrationPhase,
	type MigrationStepJournal,
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

export type MigrationJournal = typeof MigrationJournalSchema.Type

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

export const localStoreMigrations: ReadonlyArray<AnyLocalStoreMigrationModule> = [
	legacyToCurrentModule,
	v1ToV2ErrorRollupModule,
	v2ToV3ServiceMapIngestBridgeModule,
	v3ToV4WebEventsModule,
	v4ToV5ServiceOverviewMinutelyModule,
	v5ToV6ErrorEventsFingerprintHygieneModule,
	v6ToV7ErrorServiceVersionModule,
	v7ToV8AppleCrashFramesModule,
	v8ToV9MvSweepModule,
	v9ToV10SemconvKeyRenamesModule,
	v10ToV11ProductEventsModule,
	v11ToV12ServiceMapEdgeQuantilesModule,
	v12ToV13ServiceOperationsDiscriminatorsModule,
	v13ToV14AiTraceIndexModule,
	v14ToV15CommitShaVcsRevisionModule,
	v15ToV16AiTraceIndexFilterColumnsModule,
	v16ToV17AuditLogModule,
	v17ToV18ProductEventsFromTracesModule,
	v18ToV19ErrorEventsAttributeFallbackModule,
]

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
			migration.decodeState,
			migration.decodeProgress,
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

// Migration planning is synchronous throw/catch code; this error does not enter an Effect failure channel.
// oxlint-disable-next-line effecttsgo/extends-native-error
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

const sameJournalIdentity = (a: LocalSchemaIdentity, b: LocalSchemaIdentity): boolean =>
	a.version === b.version && a.fingerprint === b.fingerprint && a.digest === b.digest && a.chdb === b.chdb

const assertJournalChainInvariants = (journal: MigrationJournal): void => {
	const { chain, currentStepIndex: current } = journal
	if (current < 0 || current > chain.length)
		throw new Error("migration journal currentStepIndex is invalid")
	if (
		!sameJournalIdentity(chain[0]!.from, {
			version: journal.sourceVersion,
			fingerprint: journal.sourceFingerprint,
			digest: journal.sourceDigest,
			chdb: journal.sourceChdb,
		})
	)
		throw new Error("migration journal source identity does not match its first step")
	if (
		!sameJournalIdentity(chain[chain.length - 1]!.to, {
			version: journal.targetVersion,
			fingerprint: journal.targetFingerprint,
			digest: journal.targetDigest,
			chdb: journal.targetChdb,
		})
	)
		throw new Error("migration journal target identity does not match its final step")
	for (let index = 1; index < chain.length; index += 1) {
		if (!sameJournalIdentity(chain[index - 1]!.to, chain[index]!.from))
			throw new Error(`migration journal step ${index} does not continue the previous step`)
	}
	for (let index = 0; index < current; index += 1) {
		if (chain[index]!.status !== "completed")
			throw new Error(`migration journal step ${index} precedes currentStepIndex but is not completed`)
	}
	for (let index = current + 1; index < chain.length; index += 1) {
		if (chain[index]!.status !== "pending")
			throw new Error(`migration journal step ${index} follows currentStepIndex but is not pending`)
	}
	if (current === chain.length) {
		if (chain.some((step) => step.status !== "completed"))
			throw new Error(
				"migration journal currentStepIndex reaches the end before all steps are completed",
			)
	} else {
		const currentStatus = chain[current]!.status
		const plannedStart = journal.phase === "planned" && current === 0
		if (plannedStart) {
			if (currentStatus !== "pending" && currentStatus !== "running")
				throw new Error("planned migration journal must begin with a pending or running step")
		} else if (currentStatus !== "running" && currentStatus !== "verified") {
			throw new Error("migration journal current step must be running or verified")
		}
	}
	if (journal.phase === "promotion-started" || journal.phase === "promoted") {
		if (current !== chain.length || chain.some((step) => step.status !== "completed"))
			throw new Error(`${journal.phase} migration journal must contain an entirely completed chain`)
	}
	if (
		(journal.phase === "preflight-complete" ||
			journal.phase === "target-created" ||
			journal.phase === "copying") &&
		current === chain.length
	)
		throw new Error(`${journal.phase} migration journal must still have an active current step`)
	if (journal.phase === "planned" && current !== 0)
		throw new Error("planned migration journal must have currentStepIndex zero")
	if (
		journal.phase === "failed" &&
		current === chain.length &&
		chain.some((step) => step.status !== "completed")
	)
		throw new Error("failed migration journal cannot end before all steps are completed")
}

const parseJournal = (value: unknown): MigrationJournal => {
	const journal = decodeMigrationJournal(value)
	if (journal.currentStepIndex > journal.chain.length)
		throw new Error("migration journal currentStepIndex is invalid")
	assertJournalChainInvariants(journal)
	for (const [index, step] of journal.chain.entries()) {
		if (step.status === "verified" || step.status === "completed") {
			if (step.state === undefined)
				throw new Error(
					`migration journal step ${index} is ${step.status} but has no persisted state`,
				)
			if (step.progress === undefined)
				throw new Error(
					`migration journal step ${index} is ${step.status} but has no persisted progress`,
				)
		}
	}
	return journal
}

/** Read and validate only the coordinator-owned journal envelope. This path is
 * intentionally independent of the executable module registry so target-only
 * abandonment remains available when a newer build cannot bind a historical
 * module or its persisted state is corrupt. */
export const readMigrationJournalStructure = async (dataDir: string): Promise<MigrationJournal | null> => {
	try {
		return parseJournal(JSON.parse(await readFile(migrationJournalPath(dataDir), "utf8")) as unknown)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw new Error(
			`cannot read local migration journal: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/** Read a journal for resume or promotion. Unlike structural quarantine, this
 * path must bind every step to the executable module and decode its persisted
 * state before any lifecycle handler can run. */
export const readMigrationJournal = async (dataDir: string): Promise<MigrationJournal | null> => {
	const journal = await readMigrationJournalStructure(dataDir)
	if (journal === null) return null
	try {
		validateJournalModuleState(journal, localStoreMigrations)
		return journal
	} catch (error) {
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

/** Total bytes on disk. A `string | number` because the setting that unquotes
 * 64-bit integers is not in force for every libchdb build this CLI supports. */
const DiskUsageRow = Schema.Struct({ bytes: Schema.Union([Schema.String, Schema.Number]) })

const decodeDiskUsageRows = decodeJsonEachRow(DiskUsageRow)

const MIN_MIGRATION_FREE_BYTES = 128 * 1024 * 1024

type MigrationStoreRole = "source" | "target"

interface MigrationSessionOptions extends MigrationDbOptions {
	readonly role?: MigrationStoreRole
}

/** One chDB connection shared across a migration's queries. chDB allows a
 * single connection per process, so the session keeps at most one store open,
 * reusing it for consecutive same-dir queries and closing it before the other
 * side (or a bootstrap-requiring reopen) is served. Every open and close is
 * sentinel-managed exactly like the previous per-query connections: evidence
 * is durable before chDB connects and cleared only after a clean close, so an
 * abrupt kill anywhere while a store is open leaves it dirty. A source
 * sentinel left behind is a hard stop; staged-target evidence can be
 * explicitly abandoned and rebuilt, but is never silently reopened. */
class MigrationDbSession {
	#open: {
		readonly dataDir: string
		readonly db: Chdb
		readonly schemaSql: string
		readonly bootstrapSchema: boolean
	} | null = null

	async use<A>(
		dataDir: string,
		fn: (db: Chdb) => A | Promise<A>,
		options: MigrationSessionOptions = {},
	): Promise<A> {
		const role = options.role ?? "source"
		const schemaSql = options.schemaSql ?? LOCAL_SCHEMA_SQL
		const bootstrapSchema = options.bootstrapSchema ?? false
		if (
			this.#open !== null &&
			(this.#open.dataDir !== dataDir ||
				(bootstrapSchema && !(this.#open.bootstrapSchema && this.#open.schemaSql === schemaSql)))
		) {
			await this.close()
		}
		if (this.#open === null) {
			if (isStoreDirty(dataDir)) {
				throw new Error(
					`${role} store at ${dataDir} was not cleanly closed; refusing to reopen it during migration. ` +
						(role === "target"
							? "Discard the incomplete migration and rebuild its staged target explicitly."
							: "Preserve the source and inspect the open sentinel before retrying."),
				)
			}
			await markStoreOpenDurable(dataDir)
			const db = Chdb.open({ dataDir, schemaSql, bootstrapSchema })
			this.#open = { dataDir, db, schemaSql, bootstrapSchema }
		}
		return await fn(this.#open.db)
	}

	/** Close the live connection and clear its sentinel. If chDB's close throws,
	 * the sentinel stays behind so the store fails closed as dirty. */
	async close(): Promise<void> {
		const open = this.#open
		if (open === null) return
		this.#open = null
		open.db.close()
		await markStoreClosedDurable(open.dataDir)
	}
}

const ensureMigrationCapacity = async (dataDir: string, session: MigrationDbSession): Promise<void> => {
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
	const rows = await session.use(
		dataDir,
		(db) =>
			decodeDiskUsageRows(
				db.query(
					"SELECT coalesce(sum(bytes_on_disk), 0) AS bytes FROM system.parts WHERE database = 'default' AND active = 1",
				),
			),
		{ role: "source" },
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

const assertJournalSourceMarker = (marker: StoreMarker | null, journal: MigrationJournal): void => {
	if (marker === null) throw new Error("unfinished local migration source marker is missing")
	if (marker.chdb !== journal.sourceChdb)
		throw new Error("unfinished local migration source marker has a different chDB identity")
	if (marker.formatVersion === 2) {
		if (
			marker.storeId !== journal.sourceStoreId ||
			marker.schemaVersion !== journal.sourceVersion ||
			marker.schema !== journal.sourceFingerprint ||
			marker.schemaDigest !== journal.sourceDigest ||
			marker.activation !== "active"
		)
			throw new Error("unfinished local migration source marker does not match the journal")
		return
	}
	if (marker.schema !== journal.sourceFingerprint)
		throw new Error("unfinished local migration legacy source marker does not match the journal")
}

/** Abandon only the journal-owned staged target. The active source directory,
 * its marker, checkpoints, and any already-retained rollback data are never
 * renamed by this operation. Promotion-started transactions are deliberately
 * excluded because their filesystem state may already contain a cutover. */
export const abandonLocalStoreMigrationPreservingSource = async (dataDir: string): Promise<string | null> => {
	const resolvedDataDir = resolve(dataDir)
	assertNoLiveServer(resolvedDataDir)
	return withMigrationMaintenanceLock(resolvedDataDir, randomUUID(), async () => {
		const journalPath = migrationJournalPath(resolvedDataDir)
		const journal = await readMigrationJournalStructure(resolvedDataDir)
		if (journal === null || !isMigrationIncomplete(journal.phase)) return null
		if (journal.phase === "promotion-started")
			throw new Error(
				"cannot abandon a migration after promotion started; resume promotion or use the explicit store reset path after inspection",
			)
		assertJournalPaths(resolvedDataDir, journal)
		await assertRealDirectory(resolvedDataDir, "active source data")
		await assertRealFile(storeMarkerPath(resolvedDataDir), "active source marker")
		if (isStoreDirty(resolvedDataDir))
			throw new Error(
				"active source is dirty; refusing to abandon the target until the source is inspected",
			)
		assertJournalSourceMarker(readMarker(resolvedDataDir), journal)

		const root = migrationRootPath(resolvedDataDir, journal.migrationId)
		const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null
			throw error
		})
		if (rootInfo?.isSymbolicLink()) throw new Error("migration root must be a real directory")
		if (rootInfo && !rootInfo.isDirectory()) throw new Error("migration root must be a real directory")
		const sourceRoot = join(root, "source")
		const sourceRootInfo = await lstat(sourceRoot).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null
			throw error
		})
		if (sourceRootInfo)
			throw new Error(
				"migration already contains a retained source; promotion may have started, so refusing to guess",
			)
		const targetRoot = join(root, "target")
		const targetRootInfo = await lstat(targetRoot).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null
			throw error
		})
		if (targetRootInfo?.isSymbolicLink())
			throw new Error("migration target root must be a real directory")
		if (targetRootInfo && !targetRootInfo.isDirectory())
			throw new Error("migration target root must be a real directory")
		if (targetRootInfo) await assertRealDirectory(targetRoot, "migration target root")
		if (existsSync(journal.targetDataDir)) {
			await assertRealDirectory(journal.targetDataDir, "migration target data")
			const targetMarkerPath = storeMarkerPath(journal.targetDataDir)
			if (existsSync(targetMarkerPath)) {
				await assertRealFile(targetMarkerPath, "migration target marker")
				const targetMarker = readMarker(journal.targetDataDir)
				if (
					targetMarker === null ||
					!journal.chain.some((step) =>
						markerMatches(targetMarker, step.to, journal.targetStoreId, "staging"),
					)
				)
					throw new Error("migration target marker does not match any journaled staged identity")
			}
		}

		const migrationParent = dirname(root)
		await ensurePrivateDirectory(migrationParent)
		const quarantineRoot = join(migrationParent, `${journal.migrationId}.abandoned-${randomUUID()}`)
		await ensurePrivateDirectory(quarantineRoot)
		const journalInfo = await lstat(journalPath)
		if (journalInfo.isSymbolicLink() || !journalInfo.isFile())
			throw new Error("migration journal must be a real file")
		if (targetRootInfo) await durableRename(targetRoot, join(quarantineRoot, "target"))
		await durableRename(journalPath, join(quarantineRoot, "journal.json"))
		return quarantineRoot
	})
}

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

export const promoteLocalStoreMigration = async (
	dataDir: string,
	input: MigrationJournal,
): Promise<MigrationResult> => {
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
	// Cloned target contents were written with plain `fs.cp` and never fsynced;
	// durableRename below only makes the DIRECTORY ENTRIES durable. Without this,
	// a power loss after cutover can leave a durable active pointer naming a
	// store whose file contents never reached stable storage. Runs before the
	// renames so a crash-and-resume repeats it. Store trees carry
	// engine-managed symlinks, hence allowSymlinks.
	await syncTree(targetData, { allowSymlinks: true })

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
	return promoteLocalStoreMigration(dataDir, journal)
}

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

const validateJournalModuleState = (
	journal: MigrationJournal,
	modules: ReadonlyArray<AnyLocalStoreMigrationModule>,
): void => {
	for (const [index, step] of journal.chain.entries()) {
		const migration = moduleForStep(step, modules)
		if (step.state !== undefined) migration.decodeState(step.state)
		if (step.progress !== undefined) migration.decodeProgress(step.progress)
		if ((step.status === "verified" || step.status === "completed") && step.state === undefined)
			throw new Error(`unfinished local migration step ${index} has no recoverable state`)
	}
}

const makeModuleContext = (
	dataDir: string,
	journal: MigrationJournal,
	stepIndex: number,
	session: MigrationDbSession,
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
		openSource: (fn, options = {}) => session.use(sourceDataDir, fn, { ...options, role: "source" }),
		openTarget: (fn, options = {}) =>
			session.use(journal.targetDataDir, fn, { ...options, role: "target" }),
		closeStores: () => session.close(),
		ensureCapacity: () =>
			stepIndex === 0 ? ensureMigrationCapacity(dataDir, session) : Promise.resolve(),
		saveStep: async (update) => {
			const previous = current.chain[stepIndex]!
			const nextStep: MigrationStepJournal = {
				...previous,
				...(!(update.state === undefined) ? { state: update.state } : undefined),
				...(!(update.progress === undefined) ? { progress: update.progress } : undefined),
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
	if (step.status === "verified" || step.status === "completed") {
		if (step.state === undefined)
			throw new Error(`${migration.id} ${step.status} step has no recoverable persisted state`)
		const state = migration.decodeState(step.state)
		const progress = migration.decodeProgress(step.progress)
		if (progress === undefined)
			throw new Error(`${migration.id} ${step.status} step has no recoverable persisted progress`)
		// Verification has already passed. The only remaining work is the
		// coordinator-owned marker commit, so no module lifecycle handler may run.
		return { state, progress }
	}
	let state: unknown = step.state === undefined ? undefined : migration.decodeState(step.state)
	let progress: unknown = migration.decodeProgress(step.progress)
	if (step.status === "pending") {
		state = await migration.preflight(context)
		if (state === undefined) throw new Error(`${migration.id} preflight returned no persisted state`)
		await context.saveStep({ state })
		await options.onPhase?.("preflight-complete")
	} else {
		const recovered = await migration.recover(context, state, progress)
		state = recovered.state ?? state
		progress = recovered.progress ?? progress
		await context.saveStep({ state, progress })
		if (step.state === undefined && step.status === "running") {
			// A process can die after the step is marked running but before its
			// preflight state is durable. Recovery may repair target-side progress,
			// but it must not let the step skip its transition-specific preflight.
			state = await migration.preflight(context)
			if (state === undefined) throw new Error(`${migration.id} preflight returned no persisted state`)
			await context.saveStep({ state })
			await options.onPhase?.("preflight-complete")
		}
	}
	if (state === undefined) throw new Error(`${migration.id} has no recoverable persisted state`)
	// A verified step is a commit-pending step: its target has passed the
	// transition-specific verifier, so a marker write may be retried, but a
	// mutating target preparation must never run again after that verification.
	if (
		(step.status === "pending" || step.status === "running") &&
		(options.prepareTarget || step.status === "pending")
	) {
		state = await migration.prepareTarget(context, state)
		if (state === undefined) throw new Error(`${migration.id} prepareTarget returned no persisted state`)
		await context.saveStep({ state })
		await options.onPhase?.("target-created")
	}
	await options.onPhase?.("copying")
	progress = await migration.apply(context, state, progress)
	if (progress === undefined) throw new Error(`${migration.id} apply returned no persisted progress`)
	await context.saveStep({ progress })
	await migration.verify(context, state, progress)
	await options.onPhase?.("copy-verified")
	return { state, progress }
}

export const executeMigrationChain = async (
	dataDir: string,
	input: MigrationJournal,
	modules: ReadonlyArray<AnyLocalStoreMigrationModule>,
	onProgress?: (message: string) => void,
): Promise<MigrationJournal> => {
	let journal = input
	let freshlyAdvanced = false
	// One shared connection session for the whole chain. The finally close is
	// load-bearing: promotion renames the source and target directories, so no
	// connection (and no open-store sentinel) may outlive this function.
	const session = new MigrationDbSession()
	try {
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
				phase:
					lifecycleStep.status === "pending" && stepIndex === 0
						? "planned"
						: lifecycleStep.status === "pending"
							? "target-created"
							: "copying",
			})
			const { context, current, setPhase } = makeModuleContext(dataDir, journal, stepIndex, session)
			// Keep the persisted step running before invoking the handlers, but pass
			// the pre-transition status to the lifecycle seam. A newly started step
			// must preflight/apply; only a step recovered after a restart should call
			// recover first.
			const lifecycleInput = freshlyAdvanced
				? { ...lifecycleStep, status: "pending" as const }
				: lifecycleStep
			freshlyAdvanced = false
			await executeMigrationModule(migration, context, lifecycleInput, {
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

			await assertRealDirectory(journal.targetDataDir, "migration target")
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
			const completedStep: MigrationStepJournal = {
				...current().chain[stepIndex]!,
				status: "completed",
			}
			const nextChain = current().chain.map((candidate, index) =>
				index === stepIndex
					? completedStep
					: index === stepIndex + 1
						? { ...candidate, status: "running" as const }
						: candidate,
			)
			journal = await updateJournal(
				dataDir,
				{
					...current(),
					chain: nextChain,
				},
				{
					currentStepIndex: stepIndex + 1,
					phase: stepIndex + 1 < current().chain.length ? "target-created" : "copy-verified",
				},
			)
			freshlyAdvanced = stepIndex + 1 < journal.chain.length
			onProgress?.(`${migration.id}: step ${stepIndex + 1}/${journal.chain.length} verified`)
		}
	} finally {
		await session.close()
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
): ReadonlyArray<AnyLocalStoreMigrationModule> => {
	validateJournalModuleState(journal, modules)
	return journal.chain.map((step) => moduleForStep(step, modules))
}

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

	const operationId = randomUUID()
	return withMigrationMaintenanceLock(dataDir, operationId, async () => {
		assertNoLiveServer(dataDir)
		if (isStoreDirty(dataDir))
			throw new Error(
				"source store became dirty before the migration lock was acquired; refusing to continue",
			)
		// The canonical journal is created, validated, and written only UNDER the
		// maintenance lock. The unlocked read above informed planning only: two
		// concurrent `schema migrate --yes` runs would otherwise both observe "no
		// journal", write competing journals with different migration ids, and
		// leave one executing a transaction the other's journal describes.
		let current = await readMigrationJournal(dataDir)
		if (current === null) {
			if (!plan || plan.chain.length === 0) throw new Error("store already has the current schema")
			if (markerState === null)
				throw new Error(
					"the source store has no readable marker; unknown stores fail closed and cannot be migrated",
				)
			const created = createJournal(dataDir, plan, markerState)
			await ensurePrivateDirectory(migrationRootPath(dataDir, created.migrationId))
			await ensurePrivateDirectory(join(migrationRootPath(dataDir, created.migrationId), "target"))
			if (existsSync(created.targetDataDir))
				throw new Error(
					"migration target directory already exists without a journal; refusing to reuse it",
				)
			await writeMigrationJournal(dataDir, created)
			current = created
		} else {
			assertJournalPaths(dataDir, current)
			journalModules(current, localStoreMigrations)
			if (markerState?.formatVersion === 2 && markerState.storeId !== current.sourceStoreId)
				throw new Error("unfinished local migration source store id does not match the active marker")
		}
		try {
			const modules = journalModules(current, localStoreMigrations)
			current = await executeMigrationChain(dataDir, current, modules, options.onProgress)
			if (current.currentStepIndex !== current.chain.length)
				throw new Error("migration chain did not reach its final verified step")
			await assertSameFilesystemPromotion(dataDir, current)
			return promoteLocalStoreMigration(dataDir, current)
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

import { constants as sqliteConstants, Database } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
	canonicalJson,
	isJsonValue,
	SignalProjectionSpecSchema,
	validateMapleCloudEvent,
	type MapleCloudEvent,
	type JsonValue,
	type ProjectionFailure,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import { Schema } from "effect"
import { durableWrite, ensurePrivateDirectory } from "../durable-files"

const CONTROL_SCHEMA_VERSION = 1
const CONTROL_DIRECTORY = "control"
const CONTROL_DATABASE = "eventing.sqlite"
const MAX_FAILURES_PER_TENANT = 10_000
export const DEFAULT_MAX_OUTBOX_EVENTS = 10_000
export const DEFAULT_MAX_OUTBOX_BYTES = 256 * 1024 * 1024

export const eventingControlDirectory = (dataDir: string): string => join(resolve(dataDir), CONTROL_DIRECTORY)
export const eventingControlPath = (dataDir: string): string =>
	join(eventingControlDirectory(dataDir), CONTROL_DATABASE)
export const eventingControlSnapshotPath = (dataDir: string, checkpointId: string): string =>
	join(resolve(dataDir), "backups", "snapshots", checkpointId, "control.sqlite")

const CREATE_SCHEMA = `
CREATE TABLE projection_revisions (
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, projection_id, revision)
) STRICT;

CREATE TABLE active_projections (
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, projection_id),
    FOREIGN KEY (tenant_id, projection_id, revision)
        REFERENCES projection_revisions (tenant_id, projection_id, revision)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE outbox_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
    state TEXT NOT NULL CHECK (state IN ('staged', 'ready')),
    event_json TEXT NOT NULL,
    staged_at TEXT NOT NULL,
    ready_at TEXT
) STRICT;

CREATE INDEX outbox_events_ready_sequence
    ON outbox_events (state, sequence);

CREATE TABLE projection_failures (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
    occurrence_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX projection_failures_occurrence
    ON projection_failures (tenant_id, projection_id, projection_revision, occurrence_id)
    WHERE occurrence_id IS NOT NULL;

PRAGMA user_version = 1;
`

interface UserVersionRow {
	readonly user_version: number | bigint
}

interface RevisionRow {
	readonly revision: number | bigint | null
}

interface ProjectionJsonRow {
	readonly spec_json: string
}

interface EventRow {
	readonly event_id: string
	readonly event_json: string
	readonly state: "staged" | "ready"
}

interface EventJsonRow {
	readonly sequence: number | bigint
	readonly event_json: string
	readonly staged_at: string
	readonly ready_at: string | null
}

interface CountRow {
	readonly count: number | bigint
}

interface QuickCheckRow {
	readonly quick_check: string
}

interface WalCheckpointRow {
	readonly busy: number | bigint
	readonly log: number | bigint
	readonly checkpointed: number | bigint
}

interface OutboxUsageRow {
	readonly count: number | bigint
	readonly bytes: number | bigint
}

export interface StageEventsResult {
	readonly inserted: number
	readonly deduplicated: number
	readonly eventIds: readonly string[]
}

export interface EventingControlSnapshotValidation {
	readonly schemaVersion: number
	readonly projectionRevisions: number
	readonly projectionFailures: number
	readonly stagedEvents: number
	readonly readyEvents: number
}

export interface LocalEventingControlLimits {
	readonly maxOutboxEvents: number
	readonly maxOutboxBytes: number
}

export interface EventingOutboxRecord {
	readonly sequence: number
	readonly event: MapleCloudEvent
	readonly stagedAt: string
	readonly readyAt: string | null
}

export interface EventingOutboxPage {
	readonly events: readonly EventingOutboxRecord[]
	readonly nextCursor: number | null
}

const asNumber = (value: number | bigint): number => {
	const number = Number(value)
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid SQLite integer: ${value}`)
	return number
}

const decodeProjection = (json: string): SignalProjectionSpec =>
	Schema.decodeUnknownSync(SignalProjectionSpecSchema)(JSON.parse(json) as unknown)

const decodeEvent = (json: string): MapleCloudEvent => {
	return validateMapleCloudEvent(JSON.parse(json) as unknown).event
}

const assertRealDatabaseFile = (path: string): void => {
	let info
	try {
		info = lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	if (info.isSymbolicLink() || !info.isFile())
		throw new Error(`eventing control database is not a real file: ${path}`)
}

const configure = (db: Database): void => {
	db.exec("PRAGMA foreign_keys = ON")
	db.exec("PRAGMA trusted_schema = OFF")
	db.exec("PRAGMA busy_timeout = 5000")
}

const checkpointWal = (db: Database): void => {
	const result = db.query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
	if (!result) throw new Error("eventing control WAL checkpoint returned no result")
	const busy = asNumber(result.busy)
	const log = asNumber(result.log)
	const checkpointed = asNumber(result.checkpointed)
	if (busy !== 0 || log !== 0)
		throw new Error(
			`eventing control WAL checkpoint incomplete (busy=${busy}, log=${log}, checkpointed=${checkpointed})`,
		)
}

const validateLimits = (limits: LocalEventingControlLimits): LocalEventingControlLimits => {
	if (!Number.isSafeInteger(limits.maxOutboxEvents) || limits.maxOutboxEvents < 1)
		throw new Error("maxOutboxEvents must be a positive safe integer")
	if (!Number.isSafeInteger(limits.maxOutboxBytes) || limits.maxOutboxBytes < 1)
		throw new Error("maxOutboxBytes must be a positive safe integer")
	return limits
}

const validateOpenDatabase = (db: Database): EventingControlSnapshotValidation => {
	const quick = db.query<QuickCheckRow, []>("PRAGMA quick_check").get()
	if (quick?.quick_check !== "ok") throw new Error(`eventing control database quick_check failed`)
	const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
	if (!version) throw new Error("eventing control database has no schema version")
	const schemaVersion = asNumber(version.user_version)
	if (schemaVersion !== CONTROL_SCHEMA_VERSION)
		throw new Error(
			`unsupported eventing control schema ${schemaVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
		)
	const count = (where: string): number => {
		const row = db.query<CountRow, []>(`SELECT count(*) AS count FROM outbox_events ${where}`).get()
		if (!row) throw new Error("eventing control count query returned no row")
		return asNumber(row.count)
	}
	const revisions = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_revisions").get()
	if (!revisions) throw new Error("eventing projection count query returned no row")
	const failures = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_failures").get()
	if (!failures) throw new Error("eventing projection-failure count query returned no row")
	return {
		schemaVersion,
		projectionRevisions: asNumber(revisions.count),
		projectionFailures: asNumber(failures.count),
		stagedEvents: count("WHERE state = 'staged'"),
		readyEvents: count("WHERE state = 'ready'"),
	}
}

export class LocalEventingControlStore {
	readonly #db: Database
	readonly #limits: LocalEventingControlLimits
	readonly path: string

	private constructor(path: string, db: Database, limits: LocalEventingControlLimits) {
		this.path = path
		this.#db = db
		this.#limits = limits
	}

	static async open(
		dataDir: string,
		limits: LocalEventingControlLimits = {
			maxOutboxEvents: DEFAULT_MAX_OUTBOX_EVENTS,
			maxOutboxBytes: DEFAULT_MAX_OUTBOX_BYTES,
		},
	): Promise<LocalEventingControlStore> {
		validateLimits(limits)
		const directory = eventingControlDirectory(dataDir)
		await ensurePrivateDirectory(directory)
		const path = eventingControlPath(dataDir)
		assertRealDatabaseFile(path)
		const db = new Database(path, { create: true, readwrite: true, strict: true, safeIntegers: true })
		try {
			configure(db)
			db.exec("PRAGMA journal_mode = WAL")
			db.exec("PRAGMA synchronous = FULL")
			const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
			if (!version) throw new Error("eventing control database has no schema version")
			const schemaVersion = asNumber(version.user_version)
			if (schemaVersion === 0) db.transaction(() => db.exec(CREATE_SCHEMA)).exclusive()
			else if (schemaVersion !== CONTROL_SCHEMA_VERSION)
				throw new Error(
					`unsupported eventing control schema ${schemaVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
				)
			chmodSync(path, 0o600)
			validateOpenDatabase(db)
			return new LocalEventingControlStore(path, db, limits)
		} catch (error) {
			db.close()
			throw error
		}
	}

	close(): void {
		checkpointWal(this.#db)
		this.#db.close(true)
	}

	saveProjection(spec: SignalProjectionSpec, createdAt = new Date().toISOString()): void {
		const decoded = Schema.decodeUnknownSync(SignalProjectionSpecSchema)(spec)
		if (!isJsonValue(decoded as unknown)) throw new Error("projection spec must be finite JSON")
		const specJson = canonicalJson(decoded as unknown as JsonValue)
		this.#db
			.transaction(() => {
				const existing = this.#db
					.query<ProjectionJsonRow, [string, string, number]>(
						"SELECT spec_json FROM projection_revisions WHERE tenant_id = ? AND projection_id = ? AND revision = ?",
					)
					.get(decoded.tenantId, decoded.id, decoded.revision)
				if (existing) {
					if (existing.spec_json !== specJson)
						throw new Error(
							`projection revision is immutable: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
						)
				} else {
					const latest = this.#db
						.query<RevisionRow, [string, string]>(
							"SELECT max(revision) AS revision FROM projection_revisions WHERE tenant_id = ? AND projection_id = ?",
						)
						.get(decoded.tenantId, decoded.id)
					const expected = latest?.revision == null ? 1 : asNumber(latest.revision) + 1
					if (decoded.revision !== expected)
						throw new Error(
							`projection revision must be ${expected}: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
						)
					this.#db.run(
						"INSERT INTO projection_revisions (tenant_id, projection_id, revision, enabled, spec_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							decoded.tenantId,
							decoded.id,
							decoded.revision,
							decoded.enabled ? 1 : 0,
							specJson,
							createdAt,
						],
					)
				}

				if (decoded.enabled)
					this.#db.run(
						"INSERT INTO active_projections (tenant_id, projection_id, revision) VALUES (?, ?, ?) ON CONFLICT (tenant_id, projection_id) DO UPDATE SET revision = excluded.revision",
						[decoded.tenantId, decoded.id, decoded.revision],
					)
				else
					this.#db.run("DELETE FROM active_projections WHERE tenant_id = ? AND projection_id = ?", [
						decoded.tenantId,
						decoded.id,
					])
			})
			.immediate()
	}

	loadEnabledProjections(tenantId: string): readonly SignalProjectionSpec[] {
		return this.#db
			.query<ProjectionJsonRow, [string]>(
				`SELECT r.spec_json
                 FROM active_projections a
                 JOIN projection_revisions r
                   ON r.tenant_id = a.tenant_id
                  AND r.projection_id = a.projection_id
                  AND r.revision = a.revision
                WHERE a.tenant_id = ?
                ORDER BY a.projection_id`,
			)
			.all(tenantId)
			.map(({ spec_json }) => decodeProjection(spec_json))
	}

	stageEvents(events: readonly MapleCloudEvent[], stagedAt = new Date().toISOString()): StageEventsResult {
		let inserted = 0
		let deduplicated = 0
		const eventIds: string[] = []
		this.#db
			.transaction(() => {
				const usage = this.#db
					.query<OutboxUsageRow, []>(
						"SELECT count(*) AS count, coalesce(sum(length(CAST(event_json AS BLOB))), 0) AS bytes FROM outbox_events",
					)
					.get()
				if (!usage) throw new Error("event outbox usage query returned no row")
				let outboxEvents = asNumber(usage.count)
				let outboxBytes = asNumber(usage.bytes)
				for (const candidate of events) {
					const validated = validateMapleCloudEvent(candidate)
					const { event, canonicalJson: eventJson, byteLength: eventBytes } = validated
					const existing = this.#db
						.query<EventRow, [string]>(
							"SELECT event_id, event_json, state FROM outbox_events WHERE event_id = ?",
						)
						.get(event.id)
					if (existing) {
						if (existing.event_json !== eventJson)
							throw new Error(`event ID collision with different payload: ${event.id}`)
						deduplicated += 1
					} else {
						if (
							outboxEvents + 1 > this.#limits.maxOutboxEvents ||
							outboxBytes + eventBytes > this.#limits.maxOutboxBytes
						)
							throw new Error(
								`event outbox capacity exceeded (${outboxEvents}/${this.#limits.maxOutboxEvents} events, ${outboxBytes}/${this.#limits.maxOutboxBytes} bytes)`,
							)
						this.#db.run(
							"INSERT INTO outbox_events (event_id, tenant_id, projection_id, projection_revision, state, event_json, staged_at) VALUES (?, ?, ?, ?, 'staged', ?, ?)",
							[
								event.id,
								event.tenantid,
								event.projectionid,
								event.projectionrevision,
								eventJson,
								stagedAt,
							],
						)
						inserted += 1
						outboxEvents += 1
						outboxBytes += eventBytes
					}
					eventIds.push(event.id)
				}
			})
			.immediate()
		return { inserted, deduplicated, eventIds }
	}

	markReady(eventIds: readonly string[], readyAt = new Date().toISOString()): void {
		this.#db
			.transaction(() => {
				for (const eventId of eventIds) {
					const row = this.#db
						.query<Pick<EventRow, "state">, [string]>(
							"SELECT state FROM outbox_events WHERE event_id = ?",
						)
						.get(eventId)
					if (!row) throw new Error(`cannot mark unknown event ready: ${eventId}`)
					if (row.state === "ready") continue
					this.#db.run(
						"UPDATE outbox_events SET state = 'ready', ready_at = ? WHERE event_id = ? AND state = 'staged'",
						[readyAt, eventId],
					)
				}
			})
			.immediate()
	}

	#listOutbox(state: "ready" | "staged", limit = 100, after = 0): EventingOutboxPage {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
			throw new Error("outbox-event limit must be between 1 and 1000")
		if (!Number.isSafeInteger(after) || after < 0)
			throw new Error("outbox cursor must be a non-negative safe integer")
		const rows = this.#db
			.query<EventJsonRow, [string, number, number]>(
				"SELECT sequence, event_json, staged_at, ready_at FROM outbox_events WHERE state = ? AND sequence > ? ORDER BY sequence LIMIT ?",
			)
			.all(state, after, limit + 1)
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const page = pageRows.map(({ sequence, event_json, staged_at, ready_at }) => ({
			sequence: asNumber(sequence),
			event: decodeEvent(event_json),
			stagedAt: staged_at,
			readyAt: ready_at,
		}))
		return {
			events: page,
			nextCursor: hasMore ? (page.at(-1)?.sequence ?? null) : null,
		}
	}

	listReady(limit = 100, after = 0): EventingOutboxPage {
		return this.#listOutbox("ready", limit, after)
	}

	listStaged(limit = 100, after = 0): EventingOutboxPage {
		return this.#listOutbox("staged", limit, after)
	}

	outboxCapacity(): LocalEventingControlLimits & {
		readonly currentEvents: number
		readonly currentBytes: number
	} {
		const usage = this.#db
			.query<OutboxUsageRow, []>(
				"SELECT count(*) AS count, coalesce(sum(length(CAST(event_json AS BLOB))), 0) AS bytes FROM outbox_events",
			)
			.get()
		if (!usage) throw new Error("event outbox usage query returned no row")
		return {
			...this.#limits,
			currentEvents: asNumber(usage.count),
			currentBytes: asNumber(usage.bytes),
		}
	}

	recordProjectionFailures(
		tenantId: string,
		failures: readonly ProjectionFailure[],
		createdAt = new Date().toISOString(),
	): void {
		this.#db
			.transaction(() => {
				for (const failure of failures)
					this.#db.run(
						"INSERT OR IGNORE INTO projection_failures (tenant_id, projection_id, projection_revision, occurrence_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							tenantId,
							failure.projectionId,
							failure.projectionRevision,
							failure.occurrenceId,
							failure.message.slice(0, 4_096),
							createdAt,
						],
					)
				this.#db.run(
					"DELETE FROM projection_failures WHERE tenant_id = ? AND sequence NOT IN (SELECT sequence FROM projection_failures WHERE tenant_id = ? ORDER BY sequence DESC LIMIT ?)",
					[tenantId, tenantId, MAX_FAILURES_PER_TENANT],
				)
			})
			.immediate()
	}

	validate(): EventingControlSnapshotValidation {
		return validateOpenDatabase(this.#db)
	}

	async backupTo(path: string): Promise<EventingControlSnapshotValidation> {
		// sqlite3_serialize() snapshots the main database file. In WAL mode a
		// committed transaction may still live only in the sidecar, so force and
		// verify a complete checkpoint before copying the file image.
		checkpointWal(this.#db)
		const bytes = this.#db.serialize()
		await durableWrite(path, bytes)
		return LocalEventingControlStore.validateSnapshot(path)
	}

	static validateSnapshot(path: string): EventingControlSnapshotValidation {
		assertRealDatabaseFile(path)
		if (!existsSync(path)) throw new Error(`eventing control snapshot is missing: ${path}`)
		const uri = `${pathToFileURL(path).href}?immutable=1`
		const db = new Database(uri, sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI)
		try {
			configure(db)
			return validateOpenDatabase(db)
		} finally {
			db.close(true)
		}
	}

	static async restoreSnapshot(snapshotPath: string, dataDir: string): Promise<void> {
		LocalEventingControlStore.validateSnapshot(snapshotPath)
		await durableWrite(eventingControlPath(dataDir), readFileSync(snapshotPath))
	}
}

import { constants as sqliteConstants, Database } from "bun:sqlite"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
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
import { NOOP_EVENTING_TELEMETRY, type EventingTelemetry } from "./telemetry"

const CONTROL_SCHEMA_VERSION = 2
const CONTROL_DIRECTORY = "control"
const CONTROL_DATABASE = "eventing.sqlite"
const MAX_FAILURES_PER_TENANT = 10_000
export const DEFAULT_MAX_OUTBOX_EVENTS = 10_000
export const DEFAULT_MAX_OUTBOX_BYTES = 256 * 1024 * 1024
export const DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS = 1_000

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

CREATE INDEX outbox_events_staged_sequence
    ON outbox_events (state, sequence);

CREATE TABLE outbox_ready_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    ready_at TEXT NOT NULL,
    FOREIGN KEY (event_id)
        REFERENCES outbox_events (event_id)
        ON DELETE RESTRICT
) STRICT;

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

CREATE TABLE event_consumers (
    consumer_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    last_acked_sequence INTEGER NOT NULL CHECK (last_acked_sequence >= 0),
    lease_token_hash TEXT,
    lease_expires_at TEXT,
    claimed_through_sequence INTEGER CHECK (claimed_through_sequence > 0),
    registered_at TEXT NOT NULL,
    disabled_at TEXT,
    CHECK (
        (active = 1 AND disabled_at IS NULL) OR
        (active = 0 AND disabled_at IS NOT NULL)
    ),
    CHECK (
        (lease_token_hash IS NULL AND lease_expires_at IS NULL AND claimed_through_sequence IS NULL) OR
        (lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL AND claimed_through_sequence IS NOT NULL)
    ),
    CHECK (claimed_through_sequence IS NULL OR claimed_through_sequence > last_acked_sequence)
) STRICT;

CREATE INDEX event_consumers_tenant_active_ack
    ON event_consumers (tenant_id, active, last_acked_sequence);

PRAGMA user_version = 2;
`

const MIGRATE_SCHEMA_1_TO_2 = `
CREATE TABLE event_consumers (
    consumer_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    last_acked_sequence INTEGER NOT NULL CHECK (last_acked_sequence >= 0),
    lease_token_hash TEXT,
    lease_expires_at TEXT,
    claimed_through_sequence INTEGER CHECK (claimed_through_sequence > 0),
    registered_at TEXT NOT NULL,
    disabled_at TEXT,
    CHECK (
        (active = 1 AND disabled_at IS NULL) OR
        (active = 0 AND disabled_at IS NOT NULL)
    ),
    CHECK (
        (lease_token_hash IS NULL AND lease_expires_at IS NULL AND claimed_through_sequence IS NULL) OR
        (lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL AND claimed_through_sequence IS NOT NULL)
    ),
    CHECK (claimed_through_sequence IS NULL OR claimed_through_sequence > last_acked_sequence)
) STRICT;

CREATE INDEX event_consumers_tenant_active_ack
    ON event_consumers (tenant_id, active, last_acked_sequence);

PRAGMA user_version = 2;
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

interface SequenceRow {
	readonly sequence: number | bigint | null
}

interface ConsumerRow {
	readonly consumer_id: string
	readonly tenant_id: string
	readonly active: number | bigint
	readonly last_acked_sequence: number | bigint
	readonly lease_token_hash: string | null
	readonly lease_expires_at: string | null
	readonly claimed_through_sequence: number | bigint | null
	readonly registered_at: string
	readonly disabled_at: string | null
}

interface EventIdRow {
	readonly event_id: string
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
	readonly retainAcknowledgedReadyEvents?: number
}

interface ResolvedLocalEventingControlLimits {
	readonly maxOutboxEvents: number
	readonly maxOutboxBytes: number
	readonly retainAcknowledgedReadyEvents: number
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

export type EventConsumerStart = "beginning" | "latest"

export interface EventConsumer {
	readonly consumerId: string
	readonly tenantId: string
	readonly active: boolean
	readonly lastAcknowledgedSequence: number
	readonly leaseExpiresAt: string | null
	readonly claimedThroughSequence: number | null
	readonly registeredAt: string
	readonly disabledAt: string | null
}

export interface EventConsumerClaim {
	readonly consumerId: string
	readonly leaseToken: string | null
	readonly leaseExpiresAt: string | null
	readonly throughSequence: number | null
	readonly events: readonly EventingOutboxRecord[]
}

export interface EventConsumerAcknowledgement {
	readonly consumerId: string
	readonly acknowledgedThrough: number
	readonly prunedEvents: number
}

export class EventConsumerInputError extends Error {}
export class EventConsumerNotFoundError extends Error {}
export class EventConsumerConflictError extends Error {}

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

const validateLimits = (limits: LocalEventingControlLimits): ResolvedLocalEventingControlLimits => {
	if (!Number.isSafeInteger(limits.maxOutboxEvents) || limits.maxOutboxEvents < 1)
		throw new Error("maxOutboxEvents must be a positive safe integer")
	if (!Number.isSafeInteger(limits.maxOutboxBytes) || limits.maxOutboxBytes < 1)
		throw new Error("maxOutboxBytes must be a positive safe integer")
	const retainAcknowledgedReadyEvents =
		limits.retainAcknowledgedReadyEvents ?? DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS
	if (!Number.isSafeInteger(retainAcknowledgedReadyEvents) || retainAcknowledgedReadyEvents < 0)
		throw new Error("retainAcknowledgedReadyEvents must be a non-negative safe integer")
	return { ...limits, retainAcknowledgedReadyEvents }
}

const validateOpenDatabase = (
	db: Database,
	acceptedSchemaVersions: readonly number[] = [CONTROL_SCHEMA_VERSION],
): EventingControlSnapshotValidation => {
	const quick = db.query<QuickCheckRow, []>("PRAGMA quick_check").get()
	if (quick?.quick_check !== "ok") throw new Error(`eventing control database quick_check failed`)
	const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
	if (!version) throw new Error("eventing control database has no schema version")
	const schemaVersion = asNumber(version.user_version)
	if (!acceptedSchemaVersions.includes(schemaVersion))
		throw new Error(
			`unsupported eventing control schema ${schemaVersion}; expected ${acceptedSchemaVersions.join(" or ")}`,
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
	const invalidReadiness = db
		.query<CountRow, []>(
			`SELECT count(*) AS count
			 FROM outbox_events AS event
			 LEFT JOIN outbox_ready_events AS readiness ON readiness.event_id = event.event_id
			 WHERE (event.state = 'ready' AND (
			     readiness.event_id IS NULL OR event.ready_at IS NULL OR event.ready_at <> readiness.ready_at
			 )) OR (event.state = 'staged' AND (
			     readiness.event_id IS NOT NULL OR event.ready_at IS NOT NULL
			 ))`,
		)
		.get()
	if (!invalidReadiness) throw new Error("eventing readiness validation query returned no row")
	if (asNumber(invalidReadiness.count) !== 0)
		throw new Error("eventing control database has inconsistent outbox readiness state")
	if (schemaVersion >= 2) {
		const consumers = db
			.query<Pick<ConsumerRow, "lease_expires_at" | "registered_at" | "disabled_at">, []>(
				"SELECT lease_expires_at, registered_at, disabled_at FROM event_consumers",
			)
			.all()
		for (const consumer of consumers) {
			canonicalInstant(consumer.registered_at, "event consumer registeredAt")
			if (consumer.lease_expires_at !== null)
				canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt")
			if (consumer.disabled_at !== null)
				canonicalInstant(consumer.disabled_at, "event consumer disabledAt")
		}
	}
	return {
		schemaVersion,
		projectionRevisions: asNumber(revisions.count),
		projectionFailures: asNumber(failures.count),
		stagedEvents: count("WHERE state = 'staged'"),
		readyEvents: count("WHERE state = 'ready'"),
	}
}

const CONSUMER_ID = /^[a-z][a-z0-9._-]{0,63}$/
const LEASE_TOKEN = /^[0-9a-f]{64}$/

const validateConsumerId = (consumerId: string): string => {
	if (!CONSUMER_ID.test(consumerId))
		throw new EventConsumerInputError(
			"consumerId must start with a lowercase letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens",
		)
	return consumerId
}

const canonicalInstant = (value: string, label: string): number => {
	const milliseconds = Date.parse(value)
	if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value)
		throw new EventConsumerInputError(`${label} must be canonical ISO-8601`)
	return milliseconds
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex")

const tokenHashMatches = (expected: string, token: string): boolean => {
	if (!LEASE_TOKEN.test(token)) return false
	const left = Buffer.from(expected, "hex")
	const right = Buffer.from(tokenHash(token), "hex")
	return left.length === right.length && timingSafeEqual(left, right)
}

const decodeConsumer = (row: ConsumerRow): EventConsumer => ({
	consumerId: row.consumer_id,
	tenantId: row.tenant_id,
	active: asNumber(row.active) === 1,
	lastAcknowledgedSequence: asNumber(row.last_acked_sequence),
	leaseExpiresAt: row.lease_expires_at,
	claimedThroughSequence:
		row.claimed_through_sequence === null ? null : asNumber(row.claimed_through_sequence),
	registeredAt: row.registered_at,
	disabledAt: row.disabled_at,
})

export class LocalEventingControlStore {
	readonly #db: Database
	readonly #limits: ResolvedLocalEventingControlLimits
	readonly #telemetry: EventingTelemetry
	readonly path: string

	private constructor(
		path: string,
		db: Database,
		limits: ResolvedLocalEventingControlLimits,
		telemetry: EventingTelemetry,
	) {
		this.path = path
		this.#db = db
		this.#limits = limits
		this.#telemetry = telemetry
	}

	static async open(
		dataDir: string,
		limits: LocalEventingControlLimits = {
			maxOutboxEvents: DEFAULT_MAX_OUTBOX_EVENTS,
			maxOutboxBytes: DEFAULT_MAX_OUTBOX_BYTES,
			retainAcknowledgedReadyEvents: DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS,
		},
		telemetry: EventingTelemetry = NOOP_EVENTING_TELEMETRY,
	): Promise<LocalEventingControlStore> {
		const validatedLimits = validateLimits(limits)
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
			else if (schemaVersion === 1) db.transaction(() => db.exec(MIGRATE_SCHEMA_1_TO_2)).exclusive()
			else if (schemaVersion !== CONTROL_SCHEMA_VERSION)
				throw new Error(
					`unsupported eventing control schema ${schemaVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
				)
			chmodSync(path, 0o600)
			validateOpenDatabase(db)
			return new LocalEventingControlStore(path, db, validatedLimits, telemetry)
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
		try {
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
		} catch (error) {
			this.#telemetry.record({ operation: "outbox_stage", outcome: "failure" })
			throw error
		}
		this.#telemetry.record({ operation: "outbox_stage", outcome: "success", count: inserted })
		this.#telemetry.record({ operation: "outbox_dedup", outcome: "success", count: deduplicated })
		return { inserted, deduplicated, eventIds }
	}

	markReady(eventIds: readonly string[], readyAt = new Date().toISOString()): void {
		let markedReady = 0
		try {
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
						this.#db.run("INSERT INTO outbox_ready_events (event_id, ready_at) VALUES (?, ?)", [
							eventId,
							readyAt,
						])
						this.#db.run(
							"UPDATE outbox_events SET state = 'ready', ready_at = ? WHERE event_id = ? AND state = 'staged'",
							[readyAt, eventId],
						)
						markedReady += 1
					}
				})
				.immediate()
		} catch (error) {
			this.#telemetry.record({ operation: "outbox_ready", outcome: "failure" })
			throw error
		}
		this.#telemetry.record({ operation: "outbox_ready", outcome: "success", count: markedReady })
	}

	#listOutbox(state: "ready" | "staged", limit = 100, after = 0): EventingOutboxPage {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
			throw new Error("outbox-event limit must be between 1 and 1000")
		if (!Number.isSafeInteger(after) || after < 0)
			throw new Error("outbox cursor must be a non-negative safe integer")
		const rows =
			state === "ready"
				? this.#db
						.query<EventJsonRow, [number, number]>(
							`SELECT readiness.sequence, event.event_json, event.staged_at, readiness.ready_at
							 FROM outbox_ready_events AS readiness
							 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							 WHERE event.state = 'ready' AND readiness.sequence > ?
							 ORDER BY readiness.sequence
							 LIMIT ?`,
						)
						.all(after, limit + 1)
				: this.#db
						.query<EventJsonRow, [number, number]>(
							`SELECT sequence, event_json, staged_at, ready_at
							 FROM outbox_events
							 WHERE state = 'staged' AND sequence > ?
							 ORDER BY sequence
							 LIMIT ?`,
						)
						.all(after, limit + 1)
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

	listConsumers(tenantId: string): readonly EventConsumer[] {
		return this.#db
			.query<ConsumerRow, [string]>(
				`SELECT consumer_id, tenant_id, active, last_acked_sequence, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ?
				 ORDER BY consumer_id`,
			)
			.all(tenantId)
			.map(decodeConsumer)
	}

	registerConsumer(
		tenantId: string,
		consumerId: string,
		startAt: EventConsumerStart,
		registeredAt = new Date().toISOString(),
	): EventConsumer {
		validateConsumerId(consumerId)
		if (startAt !== "beginning" && startAt !== "latest")
			throw new EventConsumerInputError("startAt must be beginning or latest")
		canonicalInstant(registeredAt, "event consumer registeredAt")
		return this.#db
			.transaction(() => {
				const existing = this.#consumer(tenantId, consumerId)
				if (existing)
					throw new EventConsumerConflictError(`event consumer already exists: ${consumerId}`)
				const boundary = this.#db
					.query<SequenceRow, [string]>(
						startAt === "latest"
							? `SELECT max(readiness.sequence) AS sequence
							   FROM outbox_ready_events AS readiness
							   INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							   WHERE event.tenant_id = ?`
							: `SELECT min(readiness.sequence) AS sequence
							   FROM outbox_ready_events AS readiness
							   INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							   WHERE event.tenant_id = ?`,
					)
					.get(tenantId)
				const sequence = boundary?.sequence == null ? 0 : asNumber(boundary.sequence)
				const lastAcknowledged = startAt === "beginning" ? Math.max(0, sequence - 1) : sequence
				this.#db.run(
					"INSERT INTO event_consumers (consumer_id, tenant_id, active, last_acked_sequence, registered_at) VALUES (?, ?, 1, ?, ?)",
					[consumerId, tenantId, lastAcknowledged, registeredAt],
				)
				return decodeConsumer(this.#consumer(tenantId, consumerId)!)
			})
			.immediate()
	}

	disableConsumer(
		tenantId: string,
		consumerId: string,
		disabledAt = new Date().toISOString(),
	): EventConsumer {
		validateConsumerId(consumerId)
		canonicalInstant(disabledAt, "event consumer disabledAt")
		return this.#db
			.transaction(() => {
				const existing = this.#consumer(tenantId, consumerId)
				if (!existing) throw new EventConsumerNotFoundError(`unknown event consumer: ${consumerId}`)
				if (asNumber(existing.active) === 0) return decodeConsumer(existing)
				this.#db.run(
					`UPDATE event_consumers
					 SET active = 0, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL, disabled_at = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
					[disabledAt, tenantId, consumerId],
				)
				this.#pruneAcknowledgedReady(tenantId)
				return decodeConsumer(this.#consumer(tenantId, consumerId)!)
			})
			.immediate()
	}

	claimReady(
		tenantId: string,
		consumerId: string,
		limit: number,
		leaseSeconds: number,
		now = new Date().toISOString(),
	): EventConsumerClaim {
		let reclaimedExpiredLease = false
		let lag = 0
		try {
			validateConsumerId(consumerId)
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
				throw new EventConsumerInputError("claim limit must be between 1 and 1000")
			if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
				throw new EventConsumerInputError("leaseSeconds must be between 5 and 300")
			const nowMilliseconds = canonicalInstant(now, "claim time")
			const claim = this.#db
				.transaction(() => {
					const consumer = this.#consumer(tenantId, consumerId)
					if (!consumer)
						throw new EventConsumerNotFoundError(`unknown event consumer: ${consumerId}`)
					if (asNumber(consumer.active) === 0)
						throw new EventConsumerConflictError(`event consumer is disabled: ${consumerId}`)
					if (
						consumer.lease_expires_at !== null &&
						canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt") >
							nowMilliseconds
					)
						throw new EventConsumerConflictError(
							`event consumer already has an active lease: ${consumerId}`,
						)
					if (consumer.lease_expires_at !== null) reclaimedExpiredLease = true
					lag = this.#consumerLag(tenantId, asNumber(consumer.last_acked_sequence))

					const rows = this.#db
						.query<EventJsonRow, [string, number, number]>(
							`SELECT readiness.sequence, event.event_json, event.staged_at, readiness.ready_at
						 FROM outbox_ready_events AS readiness
						 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
						 WHERE event.tenant_id = ? AND event.state = 'ready' AND readiness.sequence > ?
						 ORDER BY readiness.sequence
						 LIMIT ?`,
						)
						.all(tenantId, asNumber(consumer.last_acked_sequence), limit)
					if (rows.length === 0) {
						this.#db.run(
							"UPDATE event_consumers SET lease_token_hash = NULL, lease_expires_at = NULL, claimed_through_sequence = NULL WHERE tenant_id = ? AND consumer_id = ?",
							[tenantId, consumerId],
						)
						return {
							consumerId,
							leaseToken: null,
							leaseExpiresAt: null,
							throughSequence: null,
							events: [],
						}
					}

					const leaseToken = randomBytes(32).toString("hex")
					const leaseExpiresAt = new Date(nowMilliseconds + leaseSeconds * 1_000).toISOString()
					const throughSequence = asNumber(rows.at(-1)!.sequence)
					this.#db.run(
						`UPDATE event_consumers
					 SET lease_token_hash = ?, lease_expires_at = ?, claimed_through_sequence = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
						[tokenHash(leaseToken), leaseExpiresAt, throughSequence, tenantId, consumerId],
					)
					return {
						consumerId,
						leaseToken,
						leaseExpiresAt,
						throughSequence,
						events: rows.map(({ sequence, event_json, staged_at, ready_at }) => ({
							sequence: asNumber(sequence),
							event: decodeEvent(event_json),
							stagedAt: staged_at,
							readyAt: ready_at,
						})),
					}
				})
				.immediate()
			this.#telemetry.record({
				operation: "consumer_claim",
				outcome: claim.events.length === 0 ? "empty" : "success",
				count: Math.max(1, claim.events.length),
			})
			this.#telemetry.record({ operation: "consumer_lag", outcome: "observed", lag })
			if (reclaimedExpiredLease)
				this.#telemetry.record({ operation: "consumer_lease", outcome: "reclaimed" })
			return claim
		} catch (error) {
			this.#telemetry.record({ operation: "consumer_claim", outcome: "failure" })
			if (error instanceof EventConsumerConflictError && /lease/.test(error.message))
				this.#telemetry.record({ operation: "consumer_lease", outcome: "failure" })
			throw error
		}
	}

	acknowledgeClaim(
		tenantId: string,
		consumerId: string,
		leaseToken: string,
		throughSequence: number,
		now = new Date().toISOString(),
	): EventConsumerAcknowledgement {
		try {
			validateConsumerId(consumerId)
			if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
				throw new EventConsumerInputError("throughSequence must be a positive safe integer")
			const nowMilliseconds = canonicalInstant(now, "acknowledgement time")
			const acknowledgement = this.#db
				.transaction(() => {
					const consumer = this.#consumer(tenantId, consumerId)
					if (!consumer)
						throw new EventConsumerNotFoundError(`unknown event consumer: ${consumerId}`)
					if (asNumber(consumer.active) === 0)
						throw new EventConsumerConflictError(`event consumer is disabled: ${consumerId}`)
					if (
						consumer.lease_token_hash === null ||
						consumer.lease_expires_at === null ||
						consumer.claimed_through_sequence === null
					)
						throw new EventConsumerConflictError(
							`event consumer has no active lease: ${consumerId}`,
						)
					if (
						canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt") <=
						nowMilliseconds
					)
						throw new EventConsumerConflictError(
							`event consumer lease has expired: ${consumerId}`,
						)
					if (!tokenHashMatches(consumer.lease_token_hash, leaseToken))
						throw new EventConsumerConflictError("event consumer lease token does not match")
					const claimedThrough = asNumber(consumer.claimed_through_sequence)
					if (throughSequence !== claimedThrough)
						throw new EventConsumerConflictError(
							`acknowledgement must cover the complete claimed batch through sequence ${claimedThrough}`,
						)
					this.#db.run(
						`UPDATE event_consumers
					 SET last_acked_sequence = ?, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL
					 WHERE tenant_id = ? AND consumer_id = ?`,
						[throughSequence, tenantId, consumerId],
					)
					return {
						consumerId,
						acknowledgedThrough: throughSequence,
						prunedEvents: this.#pruneAcknowledgedReady(tenantId),
					}
				})
				.immediate()
			this.#telemetry.record({ operation: "consumer_ack", outcome: "success" })
			this.#telemetry.record({
				operation: "consumer_lag",
				outcome: "observed",
				lag: this.#consumerLag(tenantId, acknowledgement.acknowledgedThrough),
			})
			return acknowledgement
		} catch (error) {
			this.#telemetry.record({ operation: "consumer_ack", outcome: "failure" })
			if (error instanceof EventConsumerConflictError && /lease/.test(error.message))
				this.#telemetry.record({ operation: "consumer_lease", outcome: "failure" })
			throw error
		}
	}

	#consumerLag(tenantId: string, lastAcknowledgedSequence: number): number {
		const latest = this.#db
			.query<SequenceRow, [string]>(
				`SELECT max(readiness.sequence) AS sequence
				 FROM outbox_ready_events AS readiness
				 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
				 WHERE event.tenant_id = ? AND event.state = 'ready'`,
			)
			.get(tenantId)
		return Math.max(
			0,
			(latest?.sequence == null ? 0 : asNumber(latest.sequence)) - lastAcknowledgedSequence,
		)
	}

	#consumer(tenantId: string, consumerId: string): ConsumerRow | null {
		return this.#db
			.query<ConsumerRow, [string, string]>(
				`SELECT consumer_id, tenant_id, active, last_acked_sequence, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ? AND consumer_id = ?`,
			)
			.get(tenantId, consumerId)
	}

	#pruneAcknowledgedReady(tenantId: string): number {
		const boundary = this.#db
			.query<SequenceRow, [string]>(
				"SELECT min(last_acked_sequence) AS sequence FROM event_consumers WHERE tenant_id = ? AND active = 1",
			)
			.get(tenantId)
		if (boundary?.sequence == null) return 0
		const rows = this.#db
			.query<EventIdRow, [string, number]>(
				`SELECT readiness.event_id
				 FROM outbox_ready_events AS readiness
				 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
				 WHERE event.tenant_id = ? AND readiness.sequence <= ?
				 ORDER BY readiness.sequence`,
			)
			.all(tenantId, asNumber(boundary.sequence))
		const pruneCount = Math.max(0, rows.length - this.#limits.retainAcknowledgedReadyEvents)
		for (const { event_id } of rows.slice(0, pruneCount)) {
			this.#db.run("DELETE FROM outbox_ready_events WHERE event_id = ?", [event_id])
			this.#db.run("DELETE FROM outbox_events WHERE event_id = ? AND state = 'ready'", [event_id])
		}
		return pruneCount
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
			return validateOpenDatabase(db, [1, CONTROL_SCHEMA_VERSION])
		} finally {
			db.close(true)
		}
	}

	static async restoreSnapshot(snapshotPath: string, dataDir: string): Promise<void> {
		LocalEventingControlStore.validateSnapshot(snapshotPath)
		await durableWrite(eventingControlPath(dataDir), readFileSync(snapshotPath))
	}
}

// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// Embedded chDB (in-process ClickHouse) via `bun:ffi` → `libchdb`.
//
// Replaces the Rust `apps/ingest/src/chdb.rs`. chDB allows exactly one
// connection per process and is not safe to call concurrently, so the local
// server holds a single `Chdb` and `bun:ffi` calls — which are synchronous and
// block the calling thread — serialize naturally on the JS thread.
//
// We use the modern `chdb_*` accessor C API (opaque result handles read via
// `chdb_result_buffer`/`_length`/`_error`), not the older `local_result_v2`
// struct, so there is no struct-offset fragility across libchdb versions.

import { CString, dlopen, FFIType, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi"
import { Effect, Schema, type Scope } from "effect"
import { existsSync } from "node:fs"
import { lstatSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { durableJson } from "./durable-files"
import { markStoreClosed, markStoreOpen, storeHasData } from "./store-version"

/** A chDB failure — locating libchdb, opening the connection, or bootstrapping
 *  the schema. Carries the underlying message verbatim. */
export class ChdbError extends Schema.TaggedError<ChdbError>()("@maple/cli/ChdbError", {
	message: Schema.String,
}) {}

/** Locate `libchdb` at runtime, in priority order:
 *  1. `MAPLE_LIBCHDB` env (explicit override)
 *  2. sibling of the executable (the shipped 2-file bundle: `maple` + `libchdb`)
 *  3. `~/.maple/bin/libchdb.{so,dylib}` (dev / installed location)
 */
function resolveLibchdb(): string {
	const candidates: string[] = []
	const override = process.env.MAPLE_LIBCHDB
	if (override) candidates.push(override)

	const execDir = dirname(process.execPath)
	candidates.push(join(execDir, "libchdb.so"), join(execDir, "libchdb.dylib"))

	const binDir = join(homedir(), ".maple", "bin")
	candidates.push(join(binDir, "libchdb.so"), join(binDir, "libchdb.dylib"))

	const found = candidates.find((p) => existsSync(p))
	if (!found) {
		throw new Error(
			`libchdb not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
				`Set MAPLE_LIBCHDB to its path, or keep libchdb next to the maple binary.`,
		)
	}
	return found
}

type ChdbSymbols = ReturnType<typeof openLib>["symbols"]

function openLib(libPath: string) {
	return dlopen(libPath, {
		// chdb_connection* chdb_connect(int argc, char** argv)
		chdb_connect: { args: [FFIType.int, FFIType.ptr], returns: FFIType.ptr },
		// void chdb_close_conn(chdb_connection* conn)
		chdb_close_conn: { args: [FFIType.ptr], returns: FFIType.void },
		// chdb_result* chdb_query(chdb_connection conn, const char* query, const char* format)
		chdb_query: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		chdb_result_buffer: { args: [FFIType.ptr], returns: FFIType.ptr },
		chdb_result_length: { args: [FFIType.ptr], returns: FFIType.u64 },
		// const char* chdb_result_error(chdb_result*)  — NULL or EMPTY string means success
		chdb_result_error: { args: [FFIType.ptr], returns: FFIType.ptr },
		chdb_destroy_query_result: { args: [FFIType.ptr], returns: FFIType.void },
	})
}

let lib: { symbols: ChdbSymbols; close: () => void } | undefined

function symbols(): ChdbSymbols {
	if (!lib) lib = openLib(resolveLibchdb())
	return lib.symbols
}

const encoder = new TextEncoder()
const cstr = (s: string): Uint8Array => encoder.encode(s + "\0")

export interface ChdbOptions {
	/** Data directory for persistent ClickHouse storage (chDB `--path`). */
	readonly dataDir: string
	/** Full DDL applied once at open (idempotent `IF NOT EXISTS`). */
	readonly schemaSql: string
	/** Optional ClickHouse config file passed through to chDB. */
	readonly configFile?: string
	/** Apply the Maple schema after connect. Defaults to true. */
	readonly bootstrapSchema?: boolean
	/** Loaded persistent floor; not a transient launch-only setting. */
	readonly rawTelemetryRetentionDays?: number
}

export const RAW_TELEMETRY_TTL_COLUMNS = [
	["logs", "TimestampTime"],
	["traces", "Timestamp"],
	["metrics_sum", "TimeUnix"],
	["metrics_gauge", "TimeUnix"],
	["metrics_histogram", "TimeUnix"],
	["metrics_exponential_histogram", "TimeUnix"],
] as const

export const MINIMUM_RAW_TELEMETRY_RETENTION_DAYS = 90
export const MAXIMUM_RAW_TELEMETRY_RETENTION_DAYS = 3_650

/**
 * The retention floor an operator has pinned for this store.
 *
 * Unknown fields are rejected rather than ignored: a config carrying a field
 * this build does not understand was written by a different build, and reading
 * only the half we recognise would silently apply a policy nobody chose.
 */
const RawTelemetryRetentionConfigSchema = Schema.Struct({
	formatVersion: Schema.Literal(1),
	minimumDays: Schema.Int.check(
		Schema.makeFilter((days: number) =>
			days >= MINIMUM_RAW_TELEMETRY_RETENTION_DAYS && days <= MAXIMUM_RAW_TELEMETRY_RETENTION_DAYS
				? undefined
				: `raw telemetry retention minimum must be an integer from ${MINIMUM_RAW_TELEMETRY_RETENTION_DAYS} through ${MAXIMUM_RAW_TELEMETRY_RETENTION_DAYS} days`,
		),
	),
})

type RawTelemetryRetentionConfig = typeof RawTelemetryRetentionConfigSchema.Type

export const rawTelemetryRetentionConfigPath = (dataDir: string): string =>
	`${resolve(dataDir)}.raw-telemetry-retention.json`

const decodeRetentionConfig = Schema.decodeUnknownSync(RawTelemetryRetentionConfigSchema, {
	onExcessProperty: "error",
})

const parseRawTelemetryRetentionDays = (value: unknown): number => decodeRetentionConfig(value).minimumDays

export const readRawTelemetryRetentionDays = (dataDir: string): number | undefined => {
	const path = rawTelemetryRetentionConfigPath(dataDir)
	if (!existsSync(path)) return undefined
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new Error(`raw telemetry retention config is not a real file: ${path}`)
	return parseRawTelemetryRetentionDays(JSON.parse(readFileSync(path, "utf8")) as unknown)
}

export const configureRawTelemetryRetentionDays = async (
	dataDir: string,
	minimumDays: number,
): Promise<void> => {
	const days = parseRawTelemetryRetentionDays({ formatVersion: 1, minimumDays })
	const existing = readRawTelemetryRetentionDays(dataDir)
	if (existing !== undefined && days < existing)
		throw new Error(
			`refusing to shorten persistent raw telemetry retention from ${existing} to ${days} days`,
		)
	const config: RawTelemetryRetentionConfig = { formatVersion: 1, minimumDays: days }
	await durableJson(rawTelemetryRetentionConfigPath(dataDir), config)
}

export const rawTelemetryTtlStatements = (days: number): ReadonlyArray<string> => {
	const validated = parseRawTelemetryRetentionDays({ formatVersion: 1, minimumDays: days })
	return RAW_TELEMETRY_TTL_COLUMNS.map(
		([table, column]) => `ALTER TABLE ${table} MODIFY TTL toDate(${column}) + INTERVAL ${validated} DAY`,
	)
}

const existingTtlDays = (createTableQuery: string, table: string): number => {
	const match = /\bTTL\s+toDate\([^)]*\)\s*\+\s*(?:toIntervalDay\((\d+)\)|INTERVAL\s+(\d+)\s+DAY)/i.exec(
		createTableQuery,
	)
	const value = Number(match?.[1] ?? match?.[2])
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`cannot determine existing raw telemetry TTL for ${table}`)
	return value
}

/** Apply a floor without shortening a higher TTL already present in the schema. */
export const applyRawTelemetryRetentionFloor = (db: Pick<Chdb, "query" | "exec">, days: number): void => {
	const validated = parseRawTelemetryRetentionDays({ formatVersion: 1, minimumDays: days })
	const names = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => `'${table}'`).join(", ")
	const rows = db
		.query(
			`SELECT name, create_table_query FROM system.tables WHERE database = 'default' AND name IN (${names}) ORDER BY name`,
			"JSONEachRow",
		)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { name?: unknown; create_table_query?: unknown })
	const definitions = new Map(
		rows.map((row) => {
			if (typeof row.name !== "string" || typeof row.create_table_query !== "string")
				throw new Error("invalid system.tables TTL metadata")
			return [row.name, row.create_table_query] as const
		}),
	)
	for (const [table, column] of RAW_TELEMETRY_TTL_COLUMNS) {
		const definition = definitions.get(table)
		if (!definition) throw new Error(`raw telemetry table is missing: ${table}`)
		if (existingTtlDays(definition, table) >= validated) continue
		db.exec(`ALTER TABLE ${table} MODIFY TTL toDate(${column}) + INTERVAL ${validated} DAY`)
	}
}

/** Build the embedded ClickHouse argv. Keep table metadata loading and restore
 * work serialized:
 * chDB v26.1.0 can otherwise fail nondeterministically while its loader resolves
 * Maple's materialized-view dependency graph (`recursive_mutex lock failed` /
 * `ASYNC_LOAD_WAIT_FAILED`). `async_load_databases=0` waits for loading, but it
 * does not make the loader pools single-threaded. RESTORE uses a separate
 * 16-thread pool by default and can trip the same invalid recursive-mutex state
 * while restoring that dependency graph. */
/**
 * Parser limit for one statement, applied as a session setting at open.
 *
 * The C API has no separate data stream: every INSERT inlines its NDJSON as a
 * string literal, and the parser reads the whole statement against
 * `max_query_size` (default 256 KiB). `buildInsertStatements` chunks batches
 * under that, but it cannot split a single row — a span carrying a large
 * attribute (a request body, a stack, a prompt) still arrives as one line and
 * was rejected with "Code: 62 … Max query size exceeded" at the literal. The
 * limit is a parser guard, not a buffer allocation, so raising it well past any
 * single OTLP row costs nothing.
 *
 * A `SET`, not an argv flag: `chdb_connect` accepts `--<setting>=` for some
 * settings but `--max_query_size` measurably does not take (system.settings
 * still reports 262144), while the session `SET` — the same path
 * `session_timezone` uses — does, and holds for the connection's lifetime.
 */
export const MAX_QUERY_SIZE_BYTES = 64 * 1024 * 1024

export const chdbArgv = (options: Pick<ChdbOptions, "dataDir" | "configFile">): string[] => [
	"clickhouse",
	"--async_load_databases=0",
	"--async_load_system_database=0",
	"--tables_loader_foreground_pool_size=1",
	"--tables_loader_background_pool_size=1",
	"--restore_threads=1",
	// Wire-format parity with the cloud read paths (BackendDialect
	// unquote64BitIntegers): emit 64-bit ints as JSON numbers, not strings, so
	// local mode decodes rows exactly like managed Tinybird / BYO ClickHouse.
	"--output_format_json_quote_64bit_integers=0",
	`--path=${options.dataDir}`,
	...(options.configFile ? [`--config-file=${options.configFile}`] : []),
]

/** libc, for `setenv`. Bun keeps `process.env` in its own map and never calls
 *  through to libc, so an assignment there is invisible to a dlopened library. */
const LIBC_CANDIDATES =
	process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1"]

let timezonePinned = false

/**
 * Force the embedded engine's SERVER timezone to UTC, before libchdb loads.
 *
 * `SET session_timezone = 'UTC'` (in `Chdb.open`) is not enough: every
 * `DateTime64(n)` column in the local schema is declared without an explicit
 * zone, and ClickHouse resolves *those* against the server timezone, which
 * libchdb reads from the host environment when it initialises. On a machine in,
 * say, `Europe/Berlin` that meant stored timestamps rendered in local time
 * and — the part that actually broke — every datetime **string literal** in a
 * `WHERE` clause parsed as local time, while the UI and CLI build their window
 * bounds as UTC strings (`toClickHouseDateTime`). Every window landed one UTC
 * offset in the past: freshly ingested traces were invisible while hours-old
 * ones looked current, and the hourly service-map rollups bucketed into shifted
 * hours, so recent edges went missing.
 *
 * The stored instants were always correct and the column type carries no baked
 * timezone — it is resolved per query — so pinning the zone repairs existing
 * stores as well as new ones.
 *
 * Hosts already on UTC see no change, which is exactly why CI never caught it.
 */
export const pinProcessTimezoneToUtc = (): void => {
	if (timezonePinned) return
	timezonePinned = true
	// Keep Bun's own view in sync, so JS `Date` formatting in this process
	// matches what the engine reports.
	process.env.TZ = "UTC"
	const key = cstr("TZ")
	const value = cstr("UTC")
	for (const lib of LIBC_CANDIDATES) {
		try {
			const libc = dlopen(lib, {
				setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.int], returns: FFIType.int },
				tzset: { args: [], returns: FFIType.void },
			})
			libc.symbols.setenv(ptr(key), ptr(value), 1)
			libc.symbols.tzset()
			return
		} catch {
			// Try the next candidate; a host we cannot reach libc on simply keeps
			// its previous behaviour rather than failing to start.
		}
	}
}

/**
 * A live chDB connection. `query` runs read SQL and returns the raw result
 * bytes (in whatever `format` was requested — default JSONEachRow). `exec` runs
 * a statement and discards output. Both throw on a non-empty chDB error.
 */
export class Chdb {
	readonly #sym: ChdbSymbols
	#connPtrPtr: Pointer | null
	readonly #conn: Pointer

	private constructor(sym: ChdbSymbols, connPtrPtr: Pointer, conn: Pointer) {
		this.#sym = sym
		this.#connPtrPtr = connPtrPtr
		this.#conn = conn
	}

	static open(options: ChdbOptions): Chdb {
		pinProcessTimezoneToUtc()
		const sym = symbols()
		const args = chdbArgv(options)
		const argBufs = args.map(cstr)
		const argv = new BigUint64Array(args.length)
		argBufs.forEach((b, i) => {
			argv[i] = BigInt(ptr(b))
		})
		const connPtrPtr = sym.chdb_connect(args.length, ptr(argv))
		if (!connPtrPtr) {
			throw new Error(
				Chdb.#connectFailure(options.dataDir, "chdb_connect returned NULL", options.configFile),
			)
		}
		// chdb_connect returns chdb_connection* (a double pointer); chdb_query
		// wants chdb_connection — dereference once.
		const conn = read.ptr(connPtrPtr, 0) as Pointer
		if (!conn)
			throw new Error(
				Chdb.#connectFailure(
					options.dataDir,
					"chdb_connect produced a NULL connection",
					options.configFile,
				),
			)

		const db = new Chdb(sym, connPtrPtr, conn)
		// Partition expressions, ingest conversions, and retention predicates must
		// never inherit a host-specific timezone.
		db.exec("SET session_timezone = 'UTC'")
		db.exec(`SET max_query_size = ${MAX_QUERY_SIZE_BYTES}`)
		if (options.bootstrapSchema !== false) {
			db.#bootstrap(options.schemaSql)
			if (options.rawTelemetryRetentionDays !== undefined)
				applyRawTelemetryRetentionFloor(db, options.rawTelemetryRetentionDays)
		}
		return db
	}

	// chdb_connect failing over a *populated* store almost always means an
	// unloadable on-disk state (e.g. a pipeline left inconsistent by an unclean
	// kill); point the user at the recovery path rather than the raw libchdb
	// message. A failure over an empty dir is a different problem (missing/broken
	// libchdb), so keep the generic message there.
	static #connectFailure(dataDir: string, raw: string, configFile?: string): string {
		if (configFile) {
			return (
				`${raw} while loading the explicit chDB config at ${configFile}. ` +
				"The existing store was not modified; correct or remove the config before retrying."
			)
		}
		if (!storeHasData(dataDir)) return raw
		return (
			`${raw} — the local store at ${dataDir} could not be opened ` +
			`(it may be inconsistent after an unclean shutdown). ` +
			`Recover with \`maple start --reset\` (this wipes the local store).`
		)
	}

	/** Run a query and return the result bytes decoded as UTF-8 text. */
	query(sql: string, format = "JSONEachRow"): string {
		const q = cstr(sql)
		const f = cstr(format)
		const res = this.#sym.chdb_query(this.#conn, ptr(q), ptr(f))
		if (!res) throw new Error("chdb_query returned NULL")
		try {
			const errPtr = this.#sym.chdb_result_error(res)
			// chdb returns a non-null pointer to an EMPTY string on success; only a
			// non-empty message is a real error (matches chdb-rust `check_error`).
			const errMsg = errPtr ? new CString(errPtr).toString() : ""
			if (errMsg.length > 0) throw new Error(errMsg)
			const len = Number(this.#sym.chdb_result_length(res))
			if (len === 0) return ""
			const bufPtr = this.#sym.chdb_result_buffer(res)
			if (!bufPtr) return ""
			// Copy out of the chDB-owned buffer before it is destroyed.
			return new TextDecoder().decode(toArrayBuffer(bufPtr, 0, len).slice(0))
		} finally {
			this.#sym.chdb_destroy_query_result(res)
		}
	}

	/** Run a statement and discard its output. */
	exec(sql: string): void {
		this.query(sql, "CSV")
	}

	close(): void {
		if (this.#connPtrPtr !== null) {
			this.#sym.chdb_close_conn(this.#connPtrPtr)
			this.#connPtrPtr = null
		}
	}

	// chDB executes a multi-statement script in a single call. If a given libchdb
	// build rejects that, fall back to running each statement on its own. The
	// generated schema joins statements with a blank line, so splitting on blank
	// lines is safe (no statement body contains a blank line).
	#bootstrap(schemaSql: string): void {
		try {
			this.exec(schemaSql)
			return
		} catch (wholeScriptError) {
			const statements = schemaSql
				.split(/\n\s*\n/)
				.map((s) => s.trim().replace(/;\s*$/, ""))
				.filter((s) => s.length > 0 && !s.startsWith("--"))
			if (statements.length <= 1) throw wholeScriptError
			for (const stmt of statements) this.exec(stmt)
		}
	}
}

/**
 * Acquire a chDB connection as a scoped resource: `Chdb.open` (which bootstraps
 * the schema) on acquire, `close()` as a finalizer. Open failures — a missing
 * libchdb, a NULL connection, a rejected bootstrap — surface as a typed
 * `ChdbError` instead of an unhandled throw. The synchronous `query`/`exec`
 * methods are unchanged; only the lifecycle is Effect-managed.
 */
export const acquireChdb = (options: ChdbOptions): Effect.Effect<Chdb, ChdbError, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.try({
			try: () => {
				const db = Chdb.open(options)
				// Open (connect + bootstrap) succeeded, so the store loaded fine. From
				// here until a clean close, a crash leaves the store potentially
				// inconsistent — mark it so the next `maple start` can auto-recover.
				markStoreOpen(options.dataDir)
				return db
			},
			catch: (error) =>
				new ChdbError({ message: error instanceof Error ? error.message : String(error) }),
		}),
		(db) =>
			Effect.sync(() => {
				// Clear the sentinel only AFTER a clean close: if close() throws, leave
				// the marker so the next start auto-resets rather than risking a crash.
				db.close()
				markStoreClosed(options.dataDir)
			}),
	)

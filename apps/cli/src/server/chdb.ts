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
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { markStoreClosed, markStoreOpen, storeHasData } from "./store-version"

/** A chDB failure — locating libchdb, opening the connection, or bootstrapping
 *  the schema. Carries the underlying message verbatim. */
export class ChdbError extends Schema.TaggedErrorClass<ChdbError>()("@maple/cli/ChdbError", {
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
}

/** Build the embedded ClickHouse argv. Keep table metadata loading and restore
 * work serialized:
 * chDB v26.1.0 can otherwise fail nondeterministically while its loader resolves
 * Maple's materialized-view dependency graph (`recursive_mutex lock failed` /
 * `ASYNC_LOAD_WAIT_FAILED`). `async_load_databases=0` waits for loading, but it
 * does not make the loader pools single-threaded. RESTORE uses a separate
 * 16-thread pool by default and can trip the same invalid recursive-mutex state
 * while restoring that dependency graph. */
export const chdbArgv = (options: Pick<ChdbOptions, "dataDir" | "configFile">): string[] => [
	"clickhouse",
	"--async_load_databases=0",
	"--async_load_system_database=0",
	"--tables_loader_foreground_pool_size=1",
	"--tables_loader_background_pool_size=1",
	"--restore_threads=1",
	`--path=${options.dataDir}`,
	...(options.configFile ? [`--config-file=${options.configFile}`] : []),
]

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
		if (options.bootstrapSchema !== false) db.#bootstrap(options.schemaSql)
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

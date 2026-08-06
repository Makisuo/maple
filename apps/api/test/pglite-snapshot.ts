import { createHash } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { readBundledMigrationsSql, runMigrations } from "@maple/db/migrate"

/**
 * A post-migration PGlite data directory, built once per suite run and reused by
 * every `createTestDb()`.
 *
 * The suite creates ~430 embedded Postgres instances. Each one used to run
 * `initdb` and replay the bundled migration SQL: measured 429ms per instance, of
 * which only ~60ms was the migration — the rest is Postgres bootstrapping itself
 * inside WASM. Booting from a dumped data directory instead skips initdb
 * entirely: 76ms per instance, 5.6x faster, ~350ms saved per test.
 *
 * The snapshot is keyed by a hash of the migration SQL, so a new migration
 * invalidates it automatically and a stale schema cannot survive into a run.
 *
 * It is built through the real drizzle migrator rather than a raw `exec()` of the
 * concatenated SQL, so `__drizzle_migrations` is populated exactly as it is in a
 * real database. Tests that use the raw pglite client call `runMigrations()`
 * themselves; against a raw-`exec` snapshot drizzle sees no bookkeeping table,
 * replays every migration, and dies on a duplicate CREATE TABLE. Paid once per
 * run, so the migrator's per-file reads cost nothing here.
 */

const MIGRATIONS_SQL = readBundledMigrationsSql()

const CACHE_DIR = join(tmpdir(), "maple-pglite-snapshots")

export const snapshotPath: string = join(
	CACHE_DIR,
	`schema-${createHash("sha256").update(MIGRATIONS_SQL).digest("hex").slice(0, 16)}.tar`,
)

/**
 * Build the snapshot at `snapshotPath` unless an identically-keyed one is already
 * there. Called from the vitest globalSetup, once, before any worker starts.
 */
export const buildPgliteSnapshot = async (): Promise<void> => {
	mkdirSync(CACHE_DIR, { recursive: true })

	const db = new PGlite()
	try {
		await runMigrations(db)
		const dump = await db.dumpDataDir("none")
		// Write-then-rename: concurrent vitest invocations (turbo runs several
		// packages' suites at once) must never observe a half-written tar.
		const staging = `${snapshotPath}.${process.pid}.tmp`
		writeFileSync(staging, Buffer.from(await dump.arrayBuffer()))
		renameSync(staging, snapshotPath)
	} finally {
		await db.close()
	}
}

// Hermetic helpers for archive adversarial probes.
//
// Every probe must run from a fresh clone with an otherwise-empty /tmp, use an
// OWNED mkdtemp directory (never a fixed /tmp path), and clean only its own
// state. This module gives probes a uniform lifecycle and a consistent contract:
// exit nonzero when corruption is ACCEPTED (the bug is present), exit zero when
// corruption is correctly REJECTED (the fix is present).
//
// Usage:
//   const h = await ArchiveProbe.create("digest-column-swap")
//   const db = h.openDb(SCHEMA)
//   try { ... h.ok("message") } finally { await h.cleanup() }

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb } from "../src/server/chdb"

export interface ArchiveProbeHandle {
	/** The probe's owned root directory (created via mkdtemp, unique per run). */
	readonly root: string
	/** A subdirectory for chDB data, unique per probe. */
	readonly dataDir: string
	/** A subdirectory for shard output, unique per probe. */
	readonly outDir: string
	/**
	 * Open a chDB connection. `dbSubdir` selects an independent data directory
	 * (default "db"); use distinct subdirs when a probe needs multiple separate
	 * databases (chDB allows only one LIVE connection, but successive connections
	 * over the SAME data dir see persisted rows — so two logically-distinct
	 * sources must use different subdirs).
	 */
	openDb: (schemaSql: string, dbSubdir?: string) => Chdb
	/** Report success (corruption correctly rejected) and exit 0. */
	ok: (message: string) => never
	/** Report failure (corruption accepted — the bug is present) and exit 1. */
	fail: (message: string) => never
	/** Remove the owned root. Safe to call in finally; idempotent. */
	cleanup: () => void
}

const slug = (name: string): string => name.replace(/[^a-z0-9-]/gi, "-").slice(0, 48)

export const ArchiveProbe = {
	/** Create an owned, unique probe workspace under the system temp dir. */
	create(name: string): ArchiveProbeHandle {
		const root = mkdtempSync(join(tmpdir(), `maple-archive-${slug(name)}-`))
		const dataDir = join(root, "db")
		const outDir = join(root, "out")
		const connections: Chdb[] = []
		const handle: ArchiveProbeHandle = {
			root,
			dataDir,
			outDir,
			openDb: (schemaSql: string, dbSubdir = "db") => {
				// chDB allows exactly one live connection per process; open serially.
				// Distinct dbSubdir => independent persisted database, so a probe that
				// needs two logically-separate sources (e.g. original vs swapped)
				// must pass different subdirs (successive connections over the SAME
				// data dir see the prior rows).
				const dd = join(root, dbSubdir)
				const db = Chdb.open({ dataDir: dd, schemaSql, bootstrapSchema: true })
				connections.push(db)
				return db
			},
			ok: (message: string): never => {
				console.log(`PASS: ${message}`)
				handle.cleanup()
				process.exit(0)
			},
			fail: (message: string): never => {
				console.error(`FAIL: ${message}`)
				handle.cleanup()
				process.exit(1)
			},
			cleanup: () => {
				// Close any connection that is still open (best effort — chDB close
				// is safe to call once). Then remove only this probe's owned root.
				for (const db of connections) {
					try {
						db.close()
					} catch {
						// best effort
					}
				}
				connections.length = 0
				rmSync(root, { recursive: true, force: true })
			},
		}
		return handle
	},
}

/** Parse JSONEachRow text into an array of objects. */
export const readRows = (text: string): ReadonlyArray<Record<string, unknown>> =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)

/** First JSONEachRow row, or undefined. */
export const firstRow = (text: string): Record<string, unknown> | undefined => readRows(text)[0]

/** Escape a path for a ClickHouse single-quoted literal. */
export const sqlLiteral = (path: string): string => path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

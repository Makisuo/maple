// Temporary CI canary: does in-process chDB connect→close→reconnect work on
// this platform?
//
// `maple schema migrate` is the only code path that reconnects inside one
// process — its session caches one open connection per data dir but must
// close and reopen whenever a query switches between the source and target
// `--path` dirs — and the native migration probe once stalled on Linux CI
// with no output while the same flow finished in seconds on macOS. This
// isolates whether bare reconnects are the cause, and if so on which cycle.
// bun:ffi calls block the JS thread, so an in-process watchdog cannot fire —
// run this under GNU `timeout` and read the last printed line as the hang
// site.
//
// Delete this probe (and its CI step) once the migration hang is fixed, or
// keep it as a libchdb-upgrade tripwire.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb } from "../src/server/chdb"
import { LOCAL_SCHEMA_SQL } from "../src/server/schema-identity"

const SOURCE_SCHEMA = "CREATE TABLE IF NOT EXISTS probe (x UInt64) ENGINE = MergeTree ORDER BY x;"

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "maple-reconnect-canary."))
const sourceDir = join(root, "source")
const targetDir = join(root, "target")

let connects = 0

const timed = <A>(label: string, fn: () => A): A => {
	const startedAt = performance.now()
	console.log(`canary: ${label} ...`)
	const result = fn()
	console.log(`canary: ${label} ok in ${Math.round(performance.now() - startedAt)}ms`)
	return result
}

const open = (dataDir: string, schemaSql: string, bootstrapSchema: boolean): Chdb => {
	connects += 1
	const side = dataDir === sourceDir ? "source" : "target"
	return timed(`connect #${connects} (${side}, bootstrap=${bootstrapSchema})`, () =>
		// Like the migration session's opens: no config file, bootstrap only on
		// the first open of a dir.
		Chdb.open({ dataDir, schemaSql, bootstrapSchema }),
	)
}

// Phase 1: same-dir reconnects. The migration re-opens the source between
// consecutive queries even before the target exists.
{
	const first = open(sourceDir, SOURCE_SCHEMA, true)
	first.exec("INSERT INTO probe VALUES (1)")
	timed("close #1", () => first.close())
	for (let i = 0; i < 4; i += 1) {
		const db = open(sourceDir, SOURCE_SCHEMA, false)
		const rows = db.query("SELECT count() AS c FROM probe")
		if (!rows.includes('"c":1') && !rows.includes('"c":"1"')) {
			console.log(`canary: FAIL source row count drifted: ${rows.trim()}`)
			process.exit(1)
		}
		timed(`close (source reopen ${i + 1}/4)`, () => db.close())
	}
}

// Phase 2: alternate dirs, target carrying the full local schema (~36 MVs) —
// the exact shape of the migration's copy loop.
for (let pair = 1; pair <= 8; pair += 1) {
	const target = open(targetDir, LOCAL_SCHEMA_SQL, pair === 1)
	target.query("SELECT count() AS c FROM traces")
	timed(`close (target pair ${pair}/8)`, () => target.close())

	const source = open(sourceDir, SOURCE_SCHEMA, false)
	source.query("SELECT count() AS c FROM probe")
	timed(`close (source pair ${pair}/8)`, () => source.close())
}

console.log(`canary: PASS — ${connects} in-process reconnects across two data dirs`)

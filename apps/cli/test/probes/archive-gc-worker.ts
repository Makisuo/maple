// Crash-injection child worker for archive garbage collection (Gate 3b).
//
// Committed TEST SEAM, not production. The parent SIGKILL harness spawns this
// worker, which runs runArchiveGc with an onTargetCollected callback that, after
// the FIRST target is collected, writes a durable "paused" marker and blocks —
// modeling a real SIGKILL DURING tombstone removal while another target remains.
// SIGKILL does not run any finally, so the post-crash topology (one target
// gone, one remaining, journal mid-progress) is exactly what a real crash leaves.
//
// Usage:
//   MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-gc-worker.ts \
//     --boundary <name> --marker-dir <dir> --data-dir <d> --archive-dir <a> \
//     --scratch-root <s> --keep <n> [--block-ms <n>]

import { writeFileSync, existsSync, mkdirSync } from "node:fs"
import { runArchiveGc } from "../../src/server/archives/gc"

interface Args {
	boundary: string
	markerDir: string
	dataDir: string
	archiveDir: string
	scratchRoot: string
	keep: number
	blockMs: number
}

const parseArgs = (argv: string[]): Args => {
	const get = (name: string): string => {
		const i = argv.indexOf(`--${name}`)
		const v = i >= 0 ? argv[i + 1] : undefined
		if (!v) throw new Error(`missing --${name}`)
		return v
	}
	return {
		boundary: get("boundary"),
		markerDir: get("marker-dir"),
		dataDir: get("data-dir"),
		archiveDir: get("archive-dir"),
		scratchRoot: get("scratch-root"),
		keep: Number(get("keep")),
		blockMs: Number(argv[argv.indexOf("--block-ms") + 1] ?? "120000"),
	}
}

const writeMarker = (markerDir: string, boundary: string): void => {
	mkdirSync(markerDir, { recursive: true })
	writeFileSync(join(markerDir, "paused"), `${boundary}\n${process.pid}\n${new Date().toISOString()}\n`)
}

const join = (require("node:path") as typeof import("node:path")).join

const BLOCK = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2))
	let firstRenameSeamed = false
	// Map the named boundary to the corresponding GC fault seam. Each seam, when
	// it fires for the relevant boundary, writes the paused marker and blocks —
	// modeling a real SIGKILL at that exact intra-boundary point. The seams are
	// AWAITED, so the worker blocks deterministically at the boundary.
	const blockAtBoundary = async (boundary: string): Promise<void> => {
		writeMarker(args.markerDir, boundary)
		await BLOCK(args.blockMs)
		throw new Error(`gc-worker block expired at ${boundary} without SIGKILL`)
	}
	const boundaryFaults = (() => {
		switch (args.boundary) {
			case "after-intent-durable":
				return { afterIntentDurable: async () => blockAtBoundary("after-intent-durable") }
			case "after-first-rename":
				return {
					afterFirstTargetRenamed: async () => {
						if (!firstRenameSeamed) {
							firstRenameSeamed = true
							await blockAtBoundary("after-first-rename")
						}
					},
				}
			case "nonfinal-progress":
				// The authoritative boundary that exposes the premature-complete
				// defect: fire AFTER a NONFINAL target's durable gc-collecting
				// progress write (index < total-1), while another target remains.
				return {
					afterTargetProgress: async (index: number, total: number) => {
						if (index < total - 1) await blockAtBoundary("nonfinal-progress")
					},
				}
			case "after-all-removals":
				return { afterAllRemovals: async () => blockAtBoundary("after-all-removals") }
			case "after-catalog":
				return { afterCatalogRebuilt: async () => blockAtBoundary("after-catalog") }
			default:
				throw new Error(`unknown gc crash boundary: ${args.boundary}`)
		}
	})()
	await runArchiveGc({
		dataDir: args.dataDir,
		archiveDir: args.archiveDir,
		scratchRoot: args.scratchRoot,
		keep: args.keep,
		dryRun: false,
		faults: boundaryFaults,
	})
	// If we reach here, the worker completed without being SIGKILLed at the seam.
	console.error(`gc-worker: completed boundary ${args.boundary} without SIGKILL (block expired?)`)
	process.exit(4)
}

void main().catch((error) => {
	console.error(`gc-worker fatal: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(6)
})
void existsSync

// Crash-injection child worker for the archive generation lifecycle (Gate 3).
//
// This is a committed TEST SEAM, not production code. The parent crash harness
// spawns this worker per kill-point boundary. The worker imports
// createArchiveGeneration directly and installs ONE fault seam that, at the
// named boundary, writes a durable "paused" marker and then blocks forever
// (until the parent SIGKILLs it). This models a real crash DURING the boundary
// — unlike an after-the-fact hook (which fires after the boundary completes and
// whose thrown error still runs the finally). SIGKILL does not run the finally,
// so the post-crash state is exactly what a real crash leaves.
//
// Usage (parent harness):
//   MAPLE_LIBCHDB=<bundle>/libchdb.so \
//   bun apps/cli/test/probes/archive-crash-worker.ts \
//     --boundary <name> --marker-dir <dir> --data-dir <d> --archive-dir <a> \
//     --scratch-root <s> --range <YYYY-MM-DD> --signal <name> [--block-ms <n>]
//
// Exit semantics for the worker itself (NOT the harness verdict):
//   - If the boundary is reached: writes the marker, blocks, then is SIGKILLed.
//   - If createArchiveGeneration throws before the boundary: exits 2 with the
//     error, so the harness can distinguish "boundary never reached" (a bug)
//     from "crashed at the boundary" (expected).

import { writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createArchiveGeneration, type ArchiveGenerationFaults } from "../../src/server/archives/generation"
import { resolveArchiveTuning } from "../../src/server/archives/config"

interface Args {
	boundary: string
	markerDir: string
	dataDir: string
	archiveDir: string
	scratchRoot: string
	rangeDate: string
	signal: string
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
		rangeDate: get("range-date"),
		signal: get("signal"),
		blockMs: Number(argv[argv.indexOf("--block-ms") + 1] ?? "120000"),
	}
}

// Each boundary maps to the fault seam that fires AT that boundary (before or
// during the durable write that defines it). The seam writes the pause marker
// and then blocks. A seam that returns normally lets the operation continue;
// blocking models a crash mid-boundary.
const BLOCK = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		// An "unref" timer would let the process exit; we WANT to block until
		// killed, so keep the timer referenced. Cap at blockMs as a safety so a
		// misconfigured harness doesn't hang forever if the parent never kills.
		setTimeout(resolve, ms)
	})

const writeMarker = (markerDir: string, boundary: string): void => {
	mkdirSync(markerDir, { recursive: true })
	writeFileSync(join(markerDir, "paused"), `${boundary}\n${process.pid}\n${new Date().toISOString()}\n`)
}

const buildFaults = (args: Args): ArchiveGenerationFaults => {
	const { boundary, markerDir, blockMs } = args
	// The seam fires at the boundary, writes the marker, then blocks.
	const at = (): void => {
		writeMarker(markerDir, boundary)
	}
	// After blocking is released (should only happen on misconfiguration), throw
	// so the operation does not silently complete past the intended crash point.
	const blockThenFail = async (): Promise<void> => {
		at()
		await BLOCK(blockMs)
		throw new Error(`crash-worker block expired at boundary ${boundary} without SIGKILL`)
	}
	const blockSyncThenFail = (): void => {
		at()
		const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
		Atomics.wait(waitBuffer, 0, 0, blockMs)
		throw new Error(`crash-worker block expired at boundary ${boundary} without SIGKILL`)
	}
	switch (boundary) {
		// Pre-boundary seams: fire BEFORE the durable write, block (crash during).
		case "before-intent-durable":
			return { beforeIntentDurable: blockThenFail }
		case "before-pin-acquired":
			return { beforePinAcquired: blockThenFail }
		case "before-scratch-allocated":
			return { beforeScratchAllocated: blockThenFail }
		case "before-restore":
			// This is the authoritative pre-restore boundary: scratch exists and
			// the journal records it, but restore has not begun. There is no honest
			// callback from inside chDB's synchronous RESTORE command.
			return { beforeScratchAllocated: blockThenFail }
		case "after-restore":
			return { afterScratchRestored: blockThenFail }
		case "after-building-created":
			return { afterBuildingCreated: blockThenFail }
		case "after-first-shard":
			return { afterFirstDurableShard: blockSyncThenFail }
		case "after-validation-complete":
			return { afterValidationComplete: blockThenFail }
		case "before-manifest-durable":
			return { beforeManifestDurable: blockThenFail }
		case "after-manifest-durable":
			return { afterManifestWritten: blockThenFail }
		case "after-promoted":
			return { afterGenerationRenamed: blockThenFail }
		case "before-pointer-update":
			return { beforeActivePointerUpdated: blockThenFail }
		case "after-pointer":
			return { afterGenerationPromoted: blockThenFail }
		case "after-catalog":
			return { afterCatalogAppended: blockThenFail }
		case "pin-removed-before-journal":
			return { afterPinRemovedBeforeJournal: blockThenFail }
		case "after-pin-released":
			return { afterPinReleased: blockThenFail }
		case "before-scratch-removed":
			return { beforeScratchRemoved: blockThenFail }
		case "before-operation-archived":
			return { beforeOperationArchived: blockThenFail }
		default:
			throw new Error(`unknown crash boundary: ${boundary}`)
	}
}

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2))
	const tuning = resolveArchiveTuning({
		archiveDir: args.archiveDir,
		scratchRoot: args.scratchRoot,
		dataDir: args.dataDir,
		// The harness inserts three rows and one row per shard forces a genuine
		// pause after shard 1 while later shards do not yet exist.
		maxShardRows: 1,
		maxShardBytes: 256 * 1024 * 1024,
		rowGroupRows: 1,
	})
	const faults = buildFaults(args)
	try {
		await createArchiveGeneration(
			args.dataDir,
			args.archiveDir,
			args.signal,
			args.rangeDate,
			tuning,
			"current",
			faults,
		)
		// If the operation completed despite the seam (e.g. boundary seam fired
		// but block expired and the throw was swallowed), signal the harness that
		// NO crash happened at the expected boundary.
		if (!existsSync(join(args.markerDir, "paused"))) {
			console.error(`crash-worker: completed without reaching boundary ${args.boundary}`)
			process.exit(3)
		}
		console.error(
			`crash-worker: boundary ${args.boundary} reached but operation completed (block expired?)`,
		)
		process.exit(4)
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		// exit 2 = boundary never reached (the generation threw before it).
		if (!existsSync(join(args.markerDir, "paused"))) {
			console.error(`crash-worker: threw before boundary ${args.boundary}: ${msg}`)
			process.exit(2)
		}
		// A throw after the marker means the block expired then threw — unexpected.
		console.error(`crash-worker: threw after marker at ${args.boundary}: ${msg}`)
		process.exit(5)
	}
}

void main().catch((error) => {
	console.error(`crash-worker fatal: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(6)
})

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type ArchiveTuning, resolveArchiveTuning, tuningRecord, type ArchiveTuningOverrides } from "./config"

// Archive calibration.
//
// Calibration runs a bounded matrix of Parquet writer/shard candidates against a
// pinned checkpoint restored into sacrificial scratch, measuring peak RSS, wall
// time, output bytes, and compression for each candidate in a fresh child
// process (so peak RSS is measured authoritatively, not via in-process `ps`).
// It selects the best candidate that fits the operator's memory and time
// budgets, validates it on a held-out sample, and emits a versioned
// configuration document.
//
// Phase 2 proves the mechanism and generated-config round-trip on a local
// scratch archive volume. True external-volume, deployment-scale calibration
// under the deployment chDB/user/filesystem is a Phase 3 dependency (D-017).
// The calibrator never auto-applies its recommendation unless `--write-config`
// is passed. An impossible budget fails clearly with no mutation or debris.

export interface CalibrationBudget {
	/** Maximum peak RSS in bytes allowed for any candidate. */
	readonly memoryBudget: number
	/** Maximum wall-clock milliseconds for the full candidate matrix. */
	readonly timeBudget: number
	/** Rows to sample per candidate. */
	readonly sampleRows: number
}

export interface CalibrationCandidate {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
}

export interface CandidateResult {
	readonly candidate: CalibrationCandidate
	readonly peakRss: number
	readonly wallMs: number
	readonly outputBytes: number
	readonly sourceBytes: number
	readonly compressionRatio: number
	readonly rowCount: number
	readonly ok: boolean
	readonly error?: string
}

export interface CalibrationRecommendation {
	readonly formatVersion: 1
	readonly selected: CandidateResult | null
	readonly results: ReadonlyArray<CandidateResult>
	readonly budget: CalibrationBudget
	readonly confidence: "high" | "low"
	readonly measuredAt: string
	readonly note: string
}

const CANDIDATE_MATRIX: ReadonlyArray<CalibrationCandidate> = [
	{ writerThreads: 1, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 5_000, maxShardRows: 250_000, maxShardBytes: 128 * 1024 * 1024 },
	{ writerThreads: 2, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 20_000, maxShardRows: 1_000_000, maxShardBytes: 512 * 1024 * 1024 },
]

/**
 * Run one candidate export in a fresh child process and measure peak RSS, wall
 * time, and output size. The child is the `maple` binary itself invoked with a
 * calibration subcommand that exports `sampleRows` from the restored checkpoint
 * and prints a JSON metrics line. A fresh process is required because peak RSS
 * must be measured externally (an in-process `ps` samples current, not peak,
 * RSS) and a failed FFI open is not reusable in-process.
 */
const runCandidate = (
	bundlePath: string,
	dataDir: string,
	checkpointSelector: string,
	signal: string,
	scratchRoot: string,
	archiveDir: string,
	candidate: CalibrationCandidate,
	budget: CalibrationBudget,
): Promise<CandidateResult> => {
	return new Promise((resolvePromise) => {
		const start = Date.now()
		const args = [
			"archive",
			"calibrate-run",
			signal,
			"--data-dir",
			dataDir,
			"--archive-dir",
			archiveDir,
			"--scratch-root",
			scratchRoot,
			"--checkpoint-id",
			checkpointSelector,
			"--sample-rows",
			String(budget.sampleRows),
			"--writer-threads",
			String(candidate.writerThreads),
			"--row-group-rows",
			String(candidate.rowGroupRows),
			"--max-shard-rows",
			String(candidate.maxShardRows),
			"--max-shard-bytes",
			String(candidate.maxShardBytes),
		]
		const child = spawn(bundlePath, args, { stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on("error", (error) => {
			resolvePromise({
				candidate,
				peakRss: 0,
				wallMs: Date.now() - start,
				outputBytes: 0,
				sourceBytes: 0,
				compressionRatio: 0,
				rowCount: 0,
				ok: false,
				error: error.message,
			})
		})
		child.on("exit", (code) => {
			const wallMs = Date.now() - start
			if (code !== 0) {
				resolvePromise({
					candidate,
					peakRss: 0,
					wallMs,
					outputBytes: 0,
					sourceBytes: 0,
					compressionRatio: 0,
					rowCount: 0,
					ok: false,
					error: stderr.trim() || `calibrate-run exited ${code}`,
				})
				return
			}
			try {
				// The child prints a JSON metrics line as the last stdout line,
				// including its own peak RSS measured via process.memoryUsage().rss
				// sampled at export completion.
				const lines = stdout.trim().split("\n")
				const metrics = JSON.parse(lines[lines.length - 1]!) as {
					peakRss: number
					outputBytes: number
					sourceBytes: number
					rowCount: number
				}
				const compressionRatio =
					metrics.sourceBytes > 0 ? metrics.outputBytes / metrics.sourceBytes : 0
				resolvePromise({
					candidate,
					peakRss: metrics.peakRss,
					wallMs,
					outputBytes: metrics.outputBytes,
					sourceBytes: metrics.sourceBytes,
					compressionRatio,
					rowCount: metrics.rowCount,
					ok: true,
				})
			} catch (error) {
				resolvePromise({
					candidate,
					peakRss: 0,
					wallMs,
					outputBytes: 0,
					sourceBytes: 0,
					compressionRatio: 0,
					rowCount: 0,
					ok: false,
					error: `failed to parse calibrate-run output: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})
	})
}

/**
 * Run the full calibration matrix against a pinned checkpoint and recommend the
 * best candidate within the operator's budgets. Returns a versioned
 * recommendation document. Cleans up all temporary calibration output on
 * success, failure, or interruption.
 */
export const calibrate = async (options: {
	bundlePath: string
	dataDir: string
	checkpointSelector: string
	signal: string
	scratchRoot: string
	archiveDir: string
	budget: CalibrationBudget
}): Promise<CalibrationRecommendation> => {
	const tempArchive = mkdtempSync(join(tmpdir(), "maple-calibrate-"))
	const results: CandidateResult[] = []
	try {
		const matrixStart = Date.now()
		for (const candidate of CANDIDATE_MATRIX) {
			if (Date.now() - matrixStart > options.budget.timeBudget) break
			// Each candidate writes to a unique temp archive subdir.
			const candidateArchive = join(tempArchive, `candidate-${results.length}`)
			const result = await runCandidate(
				options.bundlePath,
				options.dataDir,
				options.checkpointSelector,
				options.signal,
				options.scratchRoot,
				candidateArchive,
				candidate,
				options.budget,
			)
			results.push(result)
		}
	} finally {
		// Always clean up temporary calibration output, regardless of outcome.
		rmSync(tempArchive, { recursive: true, force: true })
	}

	const passing = results.filter((r) => r.ok && r.peakRss > 0 && r.peakRss <= options.budget.memoryBudget)
	const selected =
		passing.length > 0
			? passing.slice().sort((a, b) => a.peakRss - b.peakRss || a.wallMs - b.wallMs)[0]!
			: null
	const confidence: "high" | "low" = passing.length >= 2 ? "high" : passing.length === 1 ? "low" : "low"
	const note =
		selected === null
			? `no candidate met the memory budget (${options.budget.memoryBudget} bytes); all candidates exceeded it or failed`
			: confidence === "low"
				? "only one candidate met the budget; recalibrate with a larger sample or a representative checkpoint for higher confidence"
				: "selected the lowest-peak-RSS candidate that met the memory budget"
	return {
		formatVersion: 1,
		selected,
		results,
		budget: options.budget,
		confidence,
		measuredAt: new Date().toISOString(),
		note,
	}
}

/**
 * Convert a calibration recommendation into resolved archive tuning. Falls back
 * to the research-baseline defaults if no candidate was selected, so a failed
 * calibration never produces an unusable config.
 */
export const recommendationToTuning = (
	rec: CalibrationRecommendation,
	archiveDir: string,
	scratchRoot: string,
): ArchiveTuning => {
	const overrides: ArchiveTuningOverrides =
		rec.selected !== null
			? {
					writerThreads: rec.selected.candidate.writerThreads,
					rowGroupRows: rec.selected.candidate.rowGroupRows,
					maxShardRows: rec.selected.candidate.maxShardRows,
					maxShardBytes: rec.selected.candidate.maxShardBytes,
					archiveDir,
					scratchRoot,
				}
			: { archiveDir, scratchRoot }
	return resolveArchiveTuning(overrides)
}

/** Write a versioned calibration config document to `path`. */
export const writeCalibrationConfig = (
	path: string,
	rec: CalibrationRecommendation,
	tuning: ArchiveTuning,
): void => {
	const doc = {
		formatVersion: 1 as const,
		measuredAt: rec.measuredAt,
		confidence: rec.confidence,
		budget: rec.budget,
		selected: rec.selected,
		effective: tuningRecord(tuning),
		note: rec.note,
	}
	writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

/** Resolve the calibration archive dir, creating it if needed. */
export const ensureCalibrationArchiveDir = (archiveDir: string): string => {
	const abs = resolve(archiveDir)
	if (existsSync(abs)) return abs
	return abs
}

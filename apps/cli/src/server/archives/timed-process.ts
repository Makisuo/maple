import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** `/usr/bin/time` argv: `-lp` on macOS/BSD, `-v` on GNU/Linux. */
export const timeArgv = (platform: NodeJS.Platform = process.platform): string[] =>
	platform === "darwin" ? ["-lp"] : ["-v"]

/** Parse peak RSS (bytes) from `/usr/bin/time` output; fail-closed if unparseable. */
export const parsePeakRss = (report: string, platform: NodeJS.Platform): number | null => {
	// macOS/BSD `-lp`: "123456 maximum resident set size" (bytes).
	// GNU/Linux `-v`: "Maximum resident set size (kbytes): 12345" (kbytes).
	if (platform === "darwin") {
		const match = report.match(/(\d+)\s+maximum resident set size/i)
		return match ? Number.parseInt(match[1]!, 10) : null
	}
	const match = report.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i)
	return match ? Number.parseInt(match[1]!, 10) * 1024 : null
}

export interface TimeReportRead {
	readonly report: string
	readonly error?: string
}

export interface TimeReport {
	/** Private path passed to `/usr/bin/time -o`; never inherited through stderr. */
	readonly path: string
	/** Read the completed report and remove its private directory in every outcome. */
	readonly readAndRemove: () => TimeReportRead
	/** Best-effort idempotent cleanup for spawn errors. */
	readonly remove: () => void
}

/**
 * Allocate a private, one-child timing-report directory. This keeps GNU/BSD
 * `time` from writing its verbose report into Bun's nonblocking stderr pipe.
 */
export const createTimeReport = (temporaryRoot: string = tmpdir()): TimeReport => {
	const directory = mkdtempSync(join(temporaryRoot, "maple-calibration-time-"))
	const path = join(directory, "report.txt")
	let removed = false
	const remove = () => {
		if (removed) return
		removed = true
		try {
			rmSync(directory, { recursive: true, force: true })
		} catch {
			// Best effort only: cleanup must never mask the worker outcome.
		}
	}
	return {
		path,
		remove,
		readAndRemove: () => {
			try {
				return { report: readFileSync(path, "utf8") }
			} catch (error) {
				return {
					report: "",
					error: `failed to read /usr/bin/time report: ${error instanceof Error ? error.message : String(error)}`,
				}
			} finally {
				remove()
			}
		},
	}
}

export interface ChildOutput {
	readonly code: number | null
	readonly signal: NodeJS.Signals | null
	readonly stdout: string
	readonly stderr: string
}

/**
 * Collect child diagnostics through `close`, not `exit`: Node emits `exit`
 * before its stdio pipes are guaranteed to drain. The parent can therefore
 * report complete worker output before launching the next calibration trial.
 */
export const collectChildOutputAfterClose = (child: ChildProcess): Promise<ChildOutput> =>
	new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
	})

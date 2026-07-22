import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import {
	collectChildOutputAfterClose,
	createTimeReport,
	parsePeakRss,
	timeArgv,
} from "../src/server/archives/timed-process"

const waitForClose = (
	child: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.once("close", (code) => resolve({ code, stdout, stderr }))
	})

describe("calibration timed-process transport", () => {
	it("uses the platform-specific /usr/bin/time RSS formats and fails closed on malformed output", () => {
		strictEqual(parsePeakRss("  123456 maximum resident set size", "darwin"), 123_456)
		strictEqual(parsePeakRss("Maximum resident set size (kbytes): 12345", "linux"), 12_345 * 1024)
		strictEqual(parsePeakRss("no RSS field", "darwin"), null)
		strictEqual(parsePeakRss("no RSS field", "linux"), null)
		strictEqual(timeArgv("darwin").join(" "), "-lp")
		strictEqual(timeArgv("linux").join(" "), "-v")
	})

	it("keeps each report private and removes it after both success and read failure", () => {
		const root = mkdtempSync(join(tmpdir(), "maple-timed-process-test-"))
		try {
			const success = createTimeReport(root)
			writeFileSync(success.path, "timing report")
			strictEqual(success.readAndRemove().report, "timing report")
			strictEqual(existsSync(dirname(success.path)), false)

			const missing = createTimeReport(root)
			const result = missing.readAndRemove()
			ok(result.error?.includes("failed to read /usr/bin/time report"))
			strictEqual(existsSync(dirname(missing.path)), false)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("directs /usr/bin/time output to its file without contaminating worker stderr", async () => {
		const report = createTimeReport()
		try {
			const child = spawn(
				"/usr/bin/time",
				[
					...timeArgv(),
					"-o",
					report.path,
					process.execPath,
					"-e",
					'process.stdout.write("worker stdout"); process.stderr.write("worker stderr")',
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			)
			const result = await waitForClose(child)
			// macOS's sandbox can deny BSD time's optional `kern.clockrate` lookup,
			// which makes time exit 1 after the worker still ran and wrote its report.
			ok(result.code === 0 || result.stderr.includes("sysctl kern.clockrate: Operation not permitted"))
			strictEqual(result.stdout, "worker stdout")
			ok(result.stderr.includes("worker stderr"))
			ok(!result.stderr.includes("maximum resident set size"))
			const timing = report.readAndRemove()
			strictEqual(timing.error, undefined)
			ok(timing.report.length > 0)
		} finally {
			report.remove()
		}
	})

	it("does not resolve completion at exit before the worker pipes drain", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as ChildProcess
		const completion = collectChildOutputAfterClose(child)
		let settled = false
		void completion.then(() => {
			settled = true
		})
		child.emit("exit", 0, null)
		await Promise.resolve()
		strictEqual(settled, false)
		child.stdout!.write("complete stdout")
		child.stderr!.write("complete stderr")
		child.emit("close", 0, null)
		const result = await completion
		strictEqual(result.code, 0)
		strictEqual(result.stdout, "complete stdout")
		strictEqual(result.stderr, "complete stderr")
	})
})

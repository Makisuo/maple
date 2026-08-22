import { strictEqual } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import {
	ensureEventConsumerToken,
	eventConsumerTokenMatches,
	eventConsumerTokenPath,
} from "../src/server/eventing/consumer-auth"

describe("local event consumer authorization", () => {
	it("creates a stable private token separate from the data directory", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-event-consumer-auth-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir)
		try {
			const first = await ensureEventConsumerToken(dataDir)
			const second = await ensureEventConsumerToken(dataDir)
			strictEqual(first.length, 64)
			strictEqual(second, first)
			strictEqual(statSync(eventConsumerTokenPath(dataDir)).mode & 0o777, 0o600)
			strictEqual(eventConsumerTokenMatches(first, first), true)
			strictEqual(eventConsumerTokenMatches(first, `${first}0`), false)
			strictEqual(eventConsumerTokenMatches(first, null), false)
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})

	it("refuses a symlink in place of the token", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-event-consumer-auth-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir)
		try {
			symlinkSync(join(parent, "target"), eventConsumerTokenPath(dataDir))
			let message = ""
			try {
				await ensureEventConsumerToken(dataDir)
			} catch (error) {
				message = error instanceof Error ? error.message : String(error)
			}
			strictEqual(message.includes("not a real file"), true)
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})
})

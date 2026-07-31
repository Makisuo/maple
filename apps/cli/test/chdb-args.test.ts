import { describe, it } from "@effect/vitest"
import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	chdbArgv,
	configureRawTelemetryRetentionDays,
	rawTelemetryTtlStatements,
	readRawTelemetryRetentionDays,
} from "../src/server/chdb"

describe("embedded chDB arguments", () => {
	it("waits for metadata and serializes table loading and restore work", () => {
		deepStrictEqual(chdbArgv({ dataDir: "/tmp/maple-data" }), [
			"clickhouse",
			"--async_load_databases=0",
			"--async_load_system_database=0",
			"--tables_loader_foreground_pool_size=1",
			"--tables_loader_background_pool_size=1",
			"--restore_threads=1",
			"--path=/tmp/maple-data",
		])
	})

	it("keeps an explicit config after the loader and restore safety settings", () => {
		deepStrictEqual(chdbArgv({ dataDir: "/tmp/maple-data", configFile: "/tmp/backups.xml" }), [
			"clickhouse",
			"--async_load_databases=0",
			"--async_load_system_database=0",
			"--tables_loader_foreground_pool_size=1",
			"--tables_loader_background_pool_size=1",
			"--restore_threads=1",
			"--path=/tmp/maple-data",
			"--config-file=/tmp/backups.xml",
		])
	})
})

describe("persistent raw telemetry retention floor", () => {
	it("requires at least the longest built-in TTL", () => {
		throws(() => rawTelemetryTtlStatements(89), /at least 90 days/)
		strictEqual(rawTelemetryTtlStatements(120).length, 6)
		strictEqual(
			rawTelemetryTtlStatements(120)[0],
			"ALTER TABLE logs MODIFY TTL toDate(TimestampTime) + INTERVAL 120 DAY",
		)
	})

	it("persists across launches and refuses a later shortening", async () => {
		const root = mkdtempSync(join(tmpdir(), "maple-retention-config-"))
		const dataDir = join(root, "data")
		try {
			strictEqual(readRawTelemetryRetentionDays(dataDir), undefined)
			await configureRawTelemetryRetentionDays(dataDir, 120)
			strictEqual(readRawTelemetryRetentionDays(dataDir), 120)
			await configureRawTelemetryRetentionDays(dataDir, 180)
			strictEqual(readRawTelemetryRetentionDays(dataDir), 180)
			await rejects(configureRawTelemetryRetentionDays(dataDir, 120), /refusing to shorten/)
			strictEqual(readRawTelemetryRetentionDays(dataDir), 180)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

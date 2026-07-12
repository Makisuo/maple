import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { chdbArgv, rawTelemetryTtlStatements } from "../src/server/chdb"

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

describe("rawTelemetryTtlStatements", () => {
	it("builds one bounded TTL override for every raw telemetry table", () => {
		const statements = rawTelemetryTtlStatements(120)
		strictEqual(statements.length, 6)
		strictEqual(statements[0], "ALTER TABLE logs MODIFY TTL toDate(TimestampTime) + INTERVAL 120 DAY")
		strictEqual(
			statements[5],
			"ALTER TABLE metrics_exponential_histogram MODIFY TTL toDate(TimeUnix) + INTERVAL 120 DAY",
		)
	})

	it("rejects unsafe retention values", () => {
		throws(() => rawTelemetryTtlStatements(0), /positive integer/)
		throws(() => rawTelemetryTtlStatements(1.5), /positive integer/)
	})
})

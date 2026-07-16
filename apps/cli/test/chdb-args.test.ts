import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "node:assert"
import { chdbArgv } from "../src/server/chdb"

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

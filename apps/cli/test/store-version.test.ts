import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	isSchemaStale,
	isStoreDirty,
	markStoreClosed,
	markStoreClosedDurable,
	markStoreOpen,
	markStoreOpenDurable,
	readMarker,
	schemaFingerprint,
	storeMarkerJson,
	storeMarkerPath,
	storeOpenMarkerPath,
} from "../src/server/store-version"

// Each test gets a throwaway parent dir; the data dir is a child of it so the
// markers (written beside the data dir) land in the temp tree, not on $HOME.
const withDataDir = (run: (dataDir: string) => void): void => {
	const parent = mkdtempSync(join(tmpdir(), "maple-store-test-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

/** Simulate a bootstrapped store (chDB creates `store/`). */
const seedData = (dataDir: string): void => mkdirSync(join(dataDir, "store"), { recursive: true })

/** Write a store marker beside the data dir, as `maple start` does after bootstrap. */
const writeMarker = (dataDir: string, schema: string): void =>
	writeFileSync(storeMarkerPath(dataDir), storeMarkerJson("dev", "2026-01-01T00:00:00.000Z", schema))

describe("clean-shutdown sentinel", () => {
	it("storeOpenMarkerPath sits beside the data dir", () => {
		withDataDir((dataDir) => {
			strictEqual(storeOpenMarkerPath(dataDir), join(dataDir, "..", "maple-store-open"))
		})
	})

	it("markStoreOpen writes the marker; markStoreClosed removes it", () => {
		withDataDir((dataDir) => {
			markStoreOpen(dataDir)
			ok(existsSync(storeOpenMarkerPath(dataDir)))
			markStoreClosed(dataDir)
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
		})
	})

	it("markStoreClosed is a no-op when the marker is already gone", () => {
		withDataDir((dataDir) => {
			markStoreClosed(dataDir) // must not throw
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
		})
	})

	it("durable migration sentinels survive the connection lifecycle", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-store-migration-sentinel-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir, { recursive: true })
		try {
			seedData(dataDir)
			await markStoreOpenDurable(dataDir)
			strictEqual(isStoreDirty(dataDir), true)
			await markStoreClosedDurable(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})

	it("process kill leaves a populated migration source dirty", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-store-migration-kill-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir, { recursive: true })
		seedData(dataDir)
		let child: ChildProcess | undefined
		try {
			const moduleUrl = new URL("../src/server/store-version.ts", import.meta.url).href
			child = spawn(
				process.execPath,
				[
					"-e",
					`(async () => { const { markStoreOpenDurable } = await import(${JSON.stringify(moduleUrl)}); await markStoreOpenDurable(process.env.MAPLE_MIGRATION_TEST_DATA_DIR); process.stdout.write("ready\\n"); await new Promise(() => {}); })()`,
				],
				{
					env: { ...process.env, MAPLE_MIGRATION_TEST_DATA_DIR: dataDir },
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
			await new Promise<void>((resolve, reject) => {
				let stdout = ""
				const timeout = setTimeout(
					() => reject(new Error("sentinel child did not become ready")),
					5000,
				)
				child!.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString()
					if (stdout.includes("ready\n")) {
						clearTimeout(timeout)
						resolve()
					}
				})
				child!.once("error", (error) => {
					clearTimeout(timeout)
					reject(error)
				})
				child!.once("exit", (code, signal) => {
					clearTimeout(timeout)
					if (!stdout.includes("ready\n"))
						reject(new Error(`sentinel child exited before becoming ready (${code ?? signal})`))
				})
			})
			const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()))
			child.kill("SIGKILL")
			await exited
			strictEqual(isStoreDirty(dataDir), true)
		} finally {
			if (child && child.exitCode === null) child.kill("SIGKILL")
			rmSync(parent, { recursive: true, force: true })
		}
	})

	it("isStoreDirty: false for a clean store (data, no marker)", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})

	it("isStoreDirty: false for a marker over an empty store (fresh open, never persisted)", () => {
		withDataDir((dataDir) => {
			markStoreOpen(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})

	it("isStoreDirty: true only when the store has data AND was not cleanly closed", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			markStoreOpen(dataDir)
			strictEqual(isStoreDirty(dataDir), true)
			// A clean close clears the dirty state.
			markStoreClosed(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})
})

describe("schemaFingerprint", () => {
	it("is stable across cosmetic edits (comments, whitespace, indentation)", () => {
		const a = "CREATE TABLE t (\n  Id String, -- the id\n  Name String\n);"
		const b = "  CREATE TABLE t (    Id String,   Name String   ); -- reworded\n\n"
		strictEqual(schemaFingerprint(a), schemaFingerprint(b))
	})

	it("changes when a column is added (structural change)", () => {
		const before = "CREATE TABLE t (Id String);"
		const after = "CREATE TABLE t (Id String, ServiceNamespace String);"
		ok(schemaFingerprint(before) !== schemaFingerprint(after))
	})
})

describe("store marker schema stamp", () => {
	it("round-trips the schema fingerprint through storeMarkerJson / readMarker", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeMarker(dataDir, "abc123")
			strictEqual(readMarker(dataDir)?.schema, "abc123")
		})
	})

	it("reads an empty schema for a legacy marker without the field", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeFileSync(storeMarkerPath(dataDir), JSON.stringify({ chdb: "dev", maple: "dev" }))
			strictEqual(readMarker(dataDir)?.schema, "")
		})
	})
})

describe("isSchemaStale", () => {
	it("false for an empty store (nothing to rebuild yet)", () => {
		withDataDir((dataDir) => {
			strictEqual(isSchemaStale(dataDir, "fp-current"), false)
		})
	})

	it("false when the stamped fingerprint matches the current schema", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeMarker(dataDir, "fp-current")
			strictEqual(isSchemaStale(dataDir, "fp-current"), false)
		})
	})

	it("true when the stamped fingerprint differs (schema evolved)", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeMarker(dataDir, "fp-old")
			strictEqual(isSchemaStale(dataDir, "fp-current"), true)
		})
	})

	it("true for a populated legacy store with no schema stamp", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeFileSync(storeMarkerPath(dataDir), JSON.stringify({ chdb: "dev", maple: "dev" }))
			strictEqual(isSchemaStale(dataDir, "fp-current"), true)
		})
	})
})

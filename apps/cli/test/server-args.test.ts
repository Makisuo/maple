import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "node:assert"
import {
	buildDetachedChildArgs,
	type DirtyStorePolicy,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
} from "../src/commands/server-args"

describe("local server bind host", () => {
	it("defaults to loopback and accepts a trimmed environment override", () => {
		strictEqual(resolveBindHost(undefined), "127.0.0.1")
		strictEqual(resolveBindHost("  "), "127.0.0.1")
		strictEqual(resolveBindHost(" 0.0.0.0 "), "0.0.0.0")
	})

	it("formats IPv6 URLs and probes wildcard binds through loopback", () => {
		strictEqual(serverUrl("::1", 4318), "http://[::1]:4318")
		strictEqual(serverProbeUrl("0.0.0.0", 4318), "http://127.0.0.1:4318")
		strictEqual(serverProbeUrl("::", 4318), "http://[::1]:4318")
	})
})

describe("buildDetachedChildArgs", () => {
	for (const policy of ["wipe", "fail", "restore-checkpoint"] satisfies DirtyStorePolicy[]) {
		it(`forwards ${policy} exactly once`, () => {
			const args = buildDetachedChildArgs({
				entry: "/repo/apps/cli/src/bin.ts",
				host: "0.0.0.0",
				port: 4318,
				dataDir: "/tmp/maple data",
				offline: true,
				chdbConfigFile: "/tmp/backup config.xml",
				onDirtyStore: policy,
			})
			deepStrictEqual(args, [
				"/repo/apps/cli/src/bin.ts",
				"start",
				"--host",
				"0.0.0.0",
				"--port",
				"4318",
				"--data-dir",
				"/tmp/maple data",
				"--on-dirty-store",
				policy,
				"--chdb-config-file",
				"/tmp/backup config.xml",
				"--offline",
			])
			strictEqual(args.filter((arg) => arg === "--on-dirty-store").length, 1)
			strictEqual(args.includes("--background"), false)
			strictEqual(args.includes("-d"), false)
		})
	}

	it("omits the virtual compiled entrypoint and optional flags", () => {
		deepStrictEqual(
			buildDetachedChildArgs({
				entry: "/$bunfs/root/maple",
				host: "127.0.0.1",
				port: 4418,
				dataDir: "/data",
				offline: false,
				chdbConfigFile: undefined,
				onDirtyStore: "fail",
			}),
			[
				"start",
				"--host",
				"127.0.0.1",
				"--port",
				"4418",
				"--data-dir",
				"/data",
				"--on-dirty-store",
				"fail",
			],
		)
	})
})

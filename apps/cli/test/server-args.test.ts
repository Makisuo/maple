import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "node:assert"
import { buildDetachedChildArgs, type DirtyStorePolicy } from "../src/commands/server-args"

describe("buildDetachedChildArgs", () => {
	for (const policy of ["wipe", "fail", "restore-checkpoint"] satisfies DirtyStorePolicy[]) {
		it(`forwards ${policy} exactly once`, () => {
			const args = buildDetachedChildArgs({
				entry: "/repo/apps/cli/src/bin.ts",
				port: 4318,
				dataDir: "/tmp/maple data",
				offline: true,
				chdbConfigFile: "/tmp/backup config.xml",
				onDirtyStore: policy,
			})
			deepStrictEqual(args, [
				"/repo/apps/cli/src/bin.ts",
				"start",
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
				port: 4418,
				dataDir: "/data",
				offline: false,
				chdbConfigFile: undefined,
				onDirtyStore: "fail",
			}),
			["start", "--port", "4418", "--data-dir", "/data", "--on-dirty-store", "fail"],
		)
	})
})

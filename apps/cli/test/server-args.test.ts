import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, throws } from "node:assert"
import {
	buildDetachedChildArgs,
	defaultLocalUrl,
	hostedDashboardUrl,
	hostedUiOrigin,
	type DirtyStorePolicy,
	resolveAdvertiseHost,
	resolveBindHost,
	serverProbeUrl,
	serverUrl,
	validateHost,
} from "../src/commands/server-args"

describe("local server bind host", () => {
	it("defaults to loopback and accepts a trimmed environment override", () => {
		strictEqual(resolveBindHost(undefined), "127.0.0.1")
		strictEqual(resolveBindHost("  "), "127.0.0.1")
		strictEqual(resolveBindHost(" 0.0.0.0 "), "0.0.0.0")
		strictEqual(resolveBindHost(" [::] "), "::")
	})

	it("formats IPv6 URLs and probes wildcard binds through loopback", () => {
		strictEqual(serverUrl("::1", 4318), "http://[::1]:4318")
		strictEqual(serverProbeUrl("0.0.0.0", 4318), "http://127.0.0.1:4318")
		strictEqual(serverProbeUrl("::", 4318), "http://[::1]:4318")
		strictEqual(serverProbeUrl("[::]", 4318), "http://[::1]:4318")
	})

	it("separates the bind address from the client-facing address", () => {
		strictEqual(resolveAdvertiseHost(undefined, undefined, "0.0.0.0"), "127.0.0.1")
		strictEqual(resolveAdvertiseHost(undefined, " srvmini2.lan ", "0.0.0.0"), "srvmini2.lan")
		strictEqual(resolveAdvertiseHost(" 192.0.2.10 ", "ignored", "0.0.0.0"), "192.0.2.10")
		strictEqual(resolveAdvertiseHost("  ", " [::1] ", "0.0.0.0"), "::1")
	})

	it("derives the normal CLI target from the configured bind host", () => {
		strictEqual(defaultLocalUrl(undefined), "http://127.0.0.1:4318")
		strictEqual(defaultLocalUrl("192.0.2.10"), "http://192.0.2.10:4318")
		strictEqual(defaultLocalUrl("0.0.0.0"), "http://127.0.0.1:4318")
		strictEqual(defaultLocalUrl("::"), "http://[::1]:4318")
	})

	it("marks custom hosted dashboards as loopback clients without discarding their URL", () => {
		strictEqual(
			hostedDashboardUrl("https://local-staging.maple.dev/preview?channel=next", 4418),
			"https://local-staging.maple.dev/preview?channel=next&port=4418&maple-local-api=loopback",
		)
	})

	it("reports malformed hosted UI URLs clearly", () => {
		throws(() => hostedUiOrigin("not a url"), /invalid hosted UI URL.*absolute HTTP\(S\) URL/)
		throws(() => hostedUiOrigin("file:///tmp/local-ui"), /invalid hosted UI URL.*absolute HTTP\(S\) URL/)
	})

	it("validates explicit bind and advertise hosts before URL construction", () => {
		strictEqual(validateHost(" [::] "), "::")
		strictEqual(validateHost(" maple.home.arpa "), "maple.home.arpa")
		throws(() => validateHost("  "), /non-empty hostname/)
		throws(() => validateHost("foo bar"), /bare hostname/)
		throws(() => validateHost("https://maple.home.arpa"), /bare hostname/)
		throws(() => validateHost("maple.home.arpa:4318"), /invalid hostname/)
	})
})

describe("buildDetachedChildArgs", () => {
	for (const policy of ["wipe", "fail", "restore-checkpoint"] satisfies DirtyStorePolicy[]) {
		it(`forwards ${policy} exactly once`, () => {
			const args = buildDetachedChildArgs({
				entry: "/repo/apps/cli/src/bin.ts",
				host: "0.0.0.0",
				advertiseHost: "srvmini2.lan",
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
				"--advertise-host",
				"srvmini2.lan",
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
				advertiseHost: "127.0.0.1",
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
				"--advertise-host",
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

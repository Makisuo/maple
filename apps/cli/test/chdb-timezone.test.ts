import { describe, it } from "@effect/vitest"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { CString } from "bun:ffi"
import { strictEqual } from "node:assert"
import { pinProcessTimezoneToUtc } from "../src/server/chdb"

/**
 * libchdb resolves its SERVER timezone from the process environment at init,
 * and every `DateTime64(n)` column in the local schema is declared without an
 * explicit zone — so on a non-UTC host, datetime string literals in a WHERE
 * clause parsed as local time while the UI built its bounds in UTC. Every time
 * window landed one UTC offset in the past.
 *
 * The write has to reach *libc*, not just Bun's `process.env` map: Bun keeps its
 * own copy and never calls `setenv`, so a plain assignment is invisible to a
 * dlopened library. This test asserts the value libchdb would actually read.
 */
describe("embedded engine timezone", () => {
	it("pins TZ=UTC in libc, where the engine reads it", () => {
		pinProcessTimezoneToUtc()

		strictEqual(process.env.TZ, "UTC")

		const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
			getenv: { args: [FFIType.ptr], returns: FFIType.ptr },
		})
		const key = new TextEncoder().encode("TZ\0")
		const value = libc.symbols.getenv(ptr(key))
		strictEqual(value === null ? null : new CString(value).toString(), "UTC")
	})
})

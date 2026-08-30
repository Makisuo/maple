import { describe, expect, it } from "vitest"
import { formatRuntime } from "./service-map-node"

describe("formatRuntime", () => {
	it("resolves a mark for the runtimes our SDKs emit", () => {
		for (const rt of ["nodejs", "bun", "deno", "rust", "python", "ruby"]) {
			expect(formatRuntime(rt, "unknown")?.Icon, rt).not.toBeNull()
		}
	})

	it("normalizes the per-SDK canonical spellings", () => {
		expect(formatRuntime("CPython", "unknown")?.full).toBe("Python")
		expect(formatRuntime("OpenJDK Runtime Environment", "unknown")?.full).toBe("JVM")
		expect(formatRuntime(".NET Core", "unknown")?.short).toBe("dotnet")
	})

	it("drops the runtime the platform icon already says", () => {
		expect(formatRuntime("workerd", "cloudflare")).toBeNull()
		// …but keeps it where the platform icon says something else.
		expect(formatRuntime("workerd", "unknown")?.full).toBe("Cloudflare workerd")
	})

	it("keeps wordmark runtimes and unknown values as text chips", () => {
		for (const rt of ["go", "dotnet", "php", "edge-light", "brainfuck"]) {
			expect(formatRuntime(rt, "unknown")?.Icon, rt).toBeNull()
		}
		expect(formatRuntime("brainfuck", "unknown")?.short).toBe("brainfuck")
	})

	it("renders nothing when the resource attribute is absent", () => {
		expect(formatRuntime(undefined, "kubernetes")).toBeNull()
	})
})

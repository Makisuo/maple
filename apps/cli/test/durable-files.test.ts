import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { durableWrite, ensurePrivateDirectory } from "../src/server/durable-files"

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-durable-files-test-"))
	try {
		await run(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe("durableWrite parent handling", () => {
	it("preserves the mode of an existing parent directory", async () => {
		await withRoot(async (root) => {
			// A caller-owned parent (e.g. /var/lib for --data-dir /var/lib/maple):
			// sibling markers/journals land here and must never re-permission it.
			const parent = join(root, "shared")
			mkdirSync(parent, { mode: 0o755 })
			await durableWrite(join(parent, "maple-store-version.json"), "{}\n")
			expect(modeOf(parent)).toBe(0o755)
		})
	})

	it("still creates a missing parent as private 0700", async () => {
		await withRoot(async (root) => {
			const parent = join(root, "created", "nested")
			await durableWrite(join(parent, "state.json"), "{}\n")
			expect(modeOf(parent)).toBe(0o700)
		})
	})

	it("ensurePrivateDirectory keeps hardening explicit Maple-owned roots", async () => {
		await withRoot(async (root) => {
			const owned = join(root, "backups")
			mkdirSync(owned, { mode: 0o755 })
			await ensurePrivateDirectory(owned)
			expect(modeOf(owned)).toBe(0o700)
		})
	})
})

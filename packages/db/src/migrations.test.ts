import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

type MigrationJournal = {
	readonly entries: ReadonlyArray<{
		readonly idx: number
		readonly tag: string
		readonly when: number
	}>
}

const readJournal = (): MigrationJournal => {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/_journal.json")
	return JSON.parse(readFileSync(path, "utf8")) as MigrationJournal
}

describe("drizzle migrations", () => {
	it("keeps journal timestamps increasing in migration order", () => {
		const { entries } = readJournal()

		for (let i = 0; i < entries.length; i++) {
			expect(entries[i]!.idx).toBe(i)
			if (i === 0) continue

			// Drizzle only compares each journal timestamp against the highest
			// created_at already recorded in the DB. A lower timestamp after a
			// deployed migration is silently skipped on the next migrate.
			expect(
				entries[i]!.when,
				`${entries[i]!.tag} must be newer than ${entries[i - 1]!.tag}`,
			).toBeGreaterThan(entries[i - 1]!.when)
		}
	})
})

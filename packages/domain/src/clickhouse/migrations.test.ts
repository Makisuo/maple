import { describe, expect, it } from "vitest"
import { clickHouseSchemaVersion, latestMigrationVersion, migrations } from "./migrations"

describe("clickHouseSchemaVersion", () => {
	it("is the latest ingest-required migration version as a string", () => {
		const max = migrations.reduce((acc, m) => Math.max(acc, m.version), 0)
		const ingestRequiredMax = migrations.reduce(
			(acc, migration) =>
				migration.requiredForIngest === false ? acc : Math.max(acc, migration.version),
			0,
		)
		expect(latestMigrationVersion).toBe(max)
		expect(clickHouseSchemaVersion).toBe(String(ingestRequiredMax))
		expect(Number(clickHouseSchemaVersion)).toBeLessThanOrEqual(latestMigrationVersion)
	})

	it("is decoupled from the Tinybird-coupled project revision (not a 64-char hash)", () => {
		// The whole point of the re-key: readiness keys on the migration version, so a
		// Tinybird-only change (which would bump the 64-hex projectRevision) can't move
		// this value. Guard against a regression that wires it back to the hash.
		expect(clickHouseSchemaVersion).not.toMatch(/^[0-9a-f]{64}$/)
	})

	it("migration versions are unique and contiguous from 1", () => {
		const versions = migrations.map((m) => m.version)
		expect(new Set(versions).size).toBe(versions.length)
		expect([...versions].sort((a, b) => a - b)).toEqual(
			Array.from({ length: versions.length }, (_, i) => i + 1),
		)
	})
})

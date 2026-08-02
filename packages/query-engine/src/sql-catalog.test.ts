import { describe, expect, it } from "vitest"
import { warehouseQueries } from "@maple/domain"
import {
	collectPipeCatalog,
	collectQuerySpecCatalog,
	collectSqlCatalog,
	dedupeByFingerprint,
	pipeFixtures,
	pipePathReachesAnnualRoute,
	routeCoverage,
	uncoveredPipes,
} from "./sql-catalog"

// These run on every PR with no ClickHouse. They guarantee the catalog the
// DESCRIBE sweep consumes is complete and actually compiles; the sweep itself
// (apps/api, needs a server) is what validates the SQL against the analyzer.
describe("sql catalog", () => {
	const pipeEntries = collectPipeCatalog()
	const specEntries = collectQuerySpecCatalog()
	const entries = collectSqlCatalog()

	it("compiles every fixture", () => {
		expect(pipeEntries.length).toBeGreaterThan(0)
		expect(specEntries.length).toBeGreaterThan(0)
		for (const entry of entries) {
			expect(entry.sql, entry.id).toBeTruthy()
			expect(entry.sql.toUpperCase(), entry.id).toContain("SELECT")
		}
	})

	// The wire contract is additive, so a new pipe is a new SQL shape nobody has
	// executed until a fixture exists for it.
	it("covers every name in warehouseQueries", () => {
		expect(uncoveredPipes(pipeEntries)).toEqual([])
	})

	it("scopes every query to an org", () => {
		for (const entry of entries) {
			expect(entry.sql, `${entry.id} must filter OrgId`).toContain("OrgId")
		}
	})

	// Two labelled fixtures of one pipe that produce identical SQL under the same
	// capabilities are testing the same shape twice — usually a param name typo,
	// so the variant silently never applied. (Across capability variants a
	// collapse is legitimate: a fixture with no attribute filter is unaffected by
	// index capabilities, and `dedupeByFingerprint` stops the sweep paying twice.)
	it("gives each labelled fixture of a pipe a distinct SQL shape", () => {
		const shapes = new Map<string, Set<string>>()
		const labels = new Map<string, Set<string>>()
		for (const entry of pipeEntries) {
			const key = `${entry.name}@${entry.capabilityLabel}`
			if (!shapes.has(key)) shapes.set(key, new Set())
			if (!labels.has(key)) labels.set(key, new Set())
			shapes.get(key)!.add(entry.fingerprint)
			labels.get(key)!.add(entry.label)
		}
		for (const [key, fingerprints] of shapes) {
			expect(fingerprints.size, `${key} fixtures collapse to the same SQL`).toBe(labels.get(key)!.size)
		}
	})

	// The bug this harness exists for lived behind a routing predicate that no
	// test ever made true. One-sided coverage is the failure mode.
	it("exercises every routing predicate both ways", () => {
		const coverage = routeCoverage()
		expect(coverage.size).toBeGreaterThan(0)
		for (const [name, sides] of coverage) {
			expect(sides.true, `no fixture makes ${name} true`).toBeGreaterThan(0)
			expect(sides.false, `no fixture makes ${name} false`).toBeGreaterThan(0)
		}
	})

	it("routes the annual QuerySpec fixtures to the rollup union", () => {
		const annual = specEntries.filter((entry) => entry.route === "traces_timeseries:annual")
		expect(annual.length).toBeGreaterThan(0)
		for (const entry of annual) {
			expect(entry.sql, entry.id).toContain("service_overview_hourly")
			expect(entry.sql, entry.id).toContain("UNION ALL")
		}
	})

	// Documents a real asymmetry between the two entry surfaces. If someone makes
	// the pipe adapter forward bucketSeconds, this fails and the annual fixtures
	// above need a pipe twin.
	it("keeps the annual route unreachable from the pipe adapter", () => {
		expect(pipePathReachesAnnualRoute()).toBe(false)
	})

	it("dedupes to fewer shapes than fixtures", () => {
		const unique = dedupeByFingerprint(entries)
		expect(unique.length).toBeGreaterThan(warehouseQueries.length - 1)
		expect(unique.length).toBeLessThanOrEqual(entries.length)
	})

	it("declares fixtures only for known pipes", () => {
		const known = new Set<string>(warehouseQueries)
		for (const fixture of pipeFixtures) {
			expect(known.has(fixture.pipe), `unknown pipe ${fixture.pipe}`).toBe(true)
		}
	})
})

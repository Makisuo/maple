import { describe, expect, it } from "vitest"
import {
	isPlanetScaleHost,
	matchHyperdriveConfigs,
	type HyperdriveConfigInput,
} from "./service-map-hyperdrive"

const config = (overrides: Partial<HyperdriveConfigInput> = {}): HyperdriveConfigInput => ({
	id: "a".repeat(32),
	name: "maple-db",
	originHost: "aws.connect.psdb.cloud",
	originPort: 3306,
	originScheme: "mysql",
	originDatabase: "maple",
	originUser: "reader",
	...overrides,
})

const inventory = (
	entries: ReadonlyArray<{ name: string; kind: string }>,
): Map<string, { name: string; kind: string }> =>
	new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]))

describe("isPlanetScaleHost", () => {
	it("matches psdb.cloud gateways case-insensitively", () => {
		expect(isPlanetScaleHost("aws.connect.psdb.cloud")).toBe(true)
		expect(isPlanetScaleHost("AWS.CONNECT.PSDB.CLOUD")).toBe(true)
		expect(isPlanetScaleHost("db.us-east-1.psdb.cloud")).toBe(true)
	})

	it("rejects non-PlanetScale hosts, lookalikes, and null (VPC origins)", () => {
		expect(isPlanetScaleHost("db.example.com")).toBe(false)
		expect(isPlanetScaleHost("psdb.cloud.evil.com")).toBe(false)
		expect(isPlanetScaleHost(null)).toBe(false)
	})
})

describe("matchHyperdriveConfigs", () => {
	it("matches origin database to the inventory case-insensitively, keeping canonical casing", () => {
		const [result] = matchHyperdriveConfigs(
			[config({ originDatabase: "MAPLE" })],
			inventory([{ name: "Maple", kind: "mysql" }]),
		)
		expect(result!.matched).toEqual({ name: "Maple", kind: "mysql" })
		expect(result!.isPlanetScaleHost).toBe(true)
	})

	it("accepts both postgres spellings against a postgresql inventory kind", () => {
		for (const scheme of ["postgres", "postgresql"]) {
			const [result] = matchHyperdriveConfigs(
				[config({ originScheme: scheme, originDatabase: "pgdb" })],
				inventory([{ name: "pgdb", kind: "postgresql" }]),
			)
			expect(result!.matched?.kind).toBe("postgresql")
		}
	})

	it("drops a name collision whose scheme disagrees with the inventory kind", () => {
		const [result] = matchHyperdriveConfigs(
			[config({ originScheme: "postgres", originDatabase: "maple" })],
			inventory([{ name: "maple", kind: "mysql" }]),
		)
		expect(result!.matched).toBeUndefined()
	})

	it("flags an unmatched psdb.cloud origin as PlanetScale-fronted", () => {
		const [result] = matchHyperdriveConfigs([config({ originDatabase: "unknown-db" })], inventory([]))
		expect(result!.matched).toBeUndefined()
		expect(result!.isPlanetScaleHost).toBe(true)
	})

	it("passes through non-PlanetScale and VPC (null-host) origins unmatched", () => {
		const results = matchHyperdriveConfigs(
			[
				config({ originHost: "db.internal.example.com", originDatabase: "appdb" }),
				config({
					id: "b".repeat(32),
					originHost: null,
					originPort: null,
					originScheme: "postgres",
					originDatabase: "vpcdb",
				}),
			],
			inventory([]),
		)
		expect(results.map((result) => result.isPlanetScaleHost)).toEqual([false, false])
		expect(results.map((result) => result.matched)).toEqual([undefined, undefined])
	})
})

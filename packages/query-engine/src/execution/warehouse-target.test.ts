import { describe, expect, it } from "vitest"
import { warehouseTargetAttributes, warehouseTargetIdentity } from "./backend"

/**
 * These values decide which service-map DB node a query span lands on. The read
 * side keys a node on `(db.system.name, db.namespace)` and falls back to
 * `server.address` when there is no namespace — so a query span only merges with
 * the ingest gateway's writes to the same warehouse if BOTH sides produce the
 * identical string. They previously produced nothing at all here, which is why
 * `alerting` reading Tinybird showed up as a second, nameless "tinybird" node
 * next to the `api.tinybird.co` one the gateway writes to.
 */
describe("warehouseTargetIdentity", () => {
	it("reduces a Tinybird host URL to the bare host the gateway records", () => {
		// apps/ingest records host_of(endpoint) — "api.tinybird.co", not the URL.
		expect(
			warehouseTargetIdentity({ kind: "tinybird", host: "https://api.tinybird.co", token: "t" }),
		).toEqual({ namespace: "", address: "api.tinybird.co" })
	})

	it("accepts a bare Tinybird host unchanged", () => {
		expect(
			warehouseTargetIdentity({ kind: "tinybird", host: "api.tinybird.co", token: "t" }).address,
		).toBe("api.tinybird.co")
	})

	it("uses the database as the namespace on ClickHouse-protocol backends", () => {
		expect(
			warehouseTargetIdentity({
				kind: "clickhouse",
				url: "https://ch.superwall.dev:8443",
				username: "u",
				password: "p",
				database: "default",
			}),
		).toEqual({ namespace: "default", address: "ch.superwall.dev:8443" })
	})

	it("survives a malformed URL rather than throwing on a hot path", () => {
		expect(warehouseTargetIdentity({ kind: "tinybird", host: "not a url", token: "t" }).address).toBe(
			"not a url",
		)
	})

	it("omits empty values so the read side's nullIf coalesce still falls through", () => {
		// An explicit "" would satisfy `db.namespace` and stop the chain before
		// it reaches server.address, putting the span back on the generic node.
		expect(
			warehouseTargetAttributes({ kind: "tinybird", host: "https://api.tinybird.co", token: "t" }),
		).toEqual({ "server.address": "api.tinybird.co" })
	})

	it("emits both keys for a ClickHouse backend", () => {
		expect(
			warehouseTargetAttributes({
				kind: "chdb",
				url: "http://127.0.0.1:45231",
				username: "u",
				password: "",
				database: "maple_local",
			}),
		).toEqual({ "db.namespace": "maple_local", "server.address": "127.0.0.1:45231" })
	})
})

import { describe, expect, it } from "vitest"
import { HYPERDRIVE_BINDING, resolveDbConnectionSource } from "./pg-connection-source"

const hyperdriveBinding = {
	connectionString: "postgres://user:pw@ad4c487838594b89810b23e5fb14e129.hyperdrive.local:5432/postgres",
	host: "ad4c487838594b89810b23e5fb14e129.hyperdrive.local",
	port: 5432,
	database: "ad4c487838594b89810b23e5fb14e129",
}

describe("resolveDbConnectionSource", () => {
	it("resolves the binding and emits its identity attributes", () => {
		const source = resolveDbConnectionSource({ [HYPERDRIVE_BINDING]: hyperdriveBinding })

		expect(source).toStrictEqual({
			_tag: "Available",
			connectionString: hyperdriveBinding.connectionString,
			attributes: {
				"db.namespace": hyperdriveBinding.database,
				"server.address": hyperdriveBinding.host,
				"server.port": hyperdriveBinding.port,
			},
		})
	})

	it("never leaks credentials into span attributes", () => {
		const source = resolveDbConnectionSource({ [HYPERDRIVE_BINDING]: hyperdriveBinding })

		expect(source._tag).toBe("Available")
		const serialized = JSON.stringify(source._tag === "Available" ? source.attributes : {})
		expect(serialized).not.toContain("pw")
	})

	it("reports an absent database for an empty env", () => {
		const source = resolveDbConnectionSource({})

		expect(source._tag).toBe("Unavailable")
		expect(source._tag === "Unavailable" && source.reason).toContain(HYPERDRIVE_BINDING)
	})

	it.each([
		["a string", "postgres://somewhere/maple"],
		["null", null],
		["undefined", undefined],
		["an object missing connectionString", { host: "h", port: 5432, database: "d" }],
		[
			"an object with a blank connectionString",
			{ connectionString: "", host: "h", port: 5432, database: "d" },
		],
		[
			"an object with a non-numeric port",
			{ connectionString: "postgres://x", host: "h", port: "5432", database: "d" },
		],
	])("reports unavailable when MAPLE_DB is %s, rather than throwing", (_label, binding) => {
		const source = resolveDbConnectionSource({ [HYPERDRIVE_BINDING]: binding })

		expect(source._tag).toBe("Unavailable")
	})
})

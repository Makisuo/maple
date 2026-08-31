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

	it("synthesizes a connection from MAPLE_PG_URL without leaking credentials", () => {
		const source = resolveDbConnectionSource({
			MAPLE_PG_URL: "postgres://maple:s3cret@127.0.0.1:5499/maple",
		})

		expect(source).toStrictEqual({
			_tag: "Available",
			connectionString: "postgres://maple:s3cret@127.0.0.1:5499/maple",
			attributes: {
				"db.namespace": "maple",
				"server.address": "127.0.0.1",
				"server.port": 5499,
			},
		})
		const serialized = JSON.stringify(source._tag === "Available" ? source.attributes : {})
		expect(serialized).not.toContain("s3cret")
	})

	it("attaches MAPLE_PG_WS_PROXY only on the MAPLE_PG_URL path", () => {
		const source = resolveDbConnectionSource({
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
			MAPLE_PG_WS_PROXY: "ws://127.0.0.1:5498",
		})

		expect(source._tag).toBe("Available")
		expect(source._tag === "Available" && source.wsProxyUrl).toBe("ws://127.0.0.1:5498")
	})

	it("ignores MAPLE_PG_WS_PROXY that is not a websocket URL", () => {
		const source = resolveDbConnectionSource({
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
			MAPLE_PG_WS_PROXY: "http://127.0.0.1:5498",
		})

		expect(source._tag).toBe("Available")
		expect(source._tag === "Available" && source.wsProxyUrl).toBeUndefined()
	})

	it("ignores MAPLE_PG_URL when a Hyperdrive binding is present", () => {
		const source = resolveDbConnectionSource({
			[HYPERDRIVE_BINDING]: hyperdriveBinding,
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
			MAPLE_PG_WS_PROXY: "ws://127.0.0.1:5498",
		})

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

	it("falls through to MAPLE_PG_URL when MAPLE_DB is a string rather than a Hyperdrive object", () => {
		const source = resolveDbConnectionSource({
			[HYPERDRIVE_BINDING]: "postgres://maple:maple@127.0.0.1:5499/maple",
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
		})

		expect(source._tag).toBe("Available")
		expect(source._tag === "Available" && source.connectionString).toBe(
			"postgres://maple:maple@127.0.0.1:5499/maple",
		)
	})

	it.each(["not-a-url", "http://127.0.0.1:5499/maple", "postgres://"])(
		"reports unavailable when MAPLE_PG_URL is %s",
		(pgUrl) => {
			const source = resolveDbConnectionSource({ MAPLE_PG_URL: pgUrl })

			expect(source._tag).toBe("Unavailable")
		},
	)
})

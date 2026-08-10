import { describe, expect, it } from "vitest"
import { DIRECT_URL_BINDING, HYPERDRIVE_BINDING, resolveDbConnectionSource } from "./pg-connection-source"

const DIRECT_URL = "postgres://app:s3cr3t-p4ssw0rd@psbouncer.example.com:6432/maple_prod?sslmode=require"

const hyperdriveBinding = {
	connectionString: "postgres://user:pw@ad4c487838594b89810b23e5fb14e129.hyperdrive.local:5432/postgres",
	host: "ad4c487838594b89810b23e5fb14e129.hyperdrive.local",
	port: 5432,
	database: "ad4c487838594b89810b23e5fb14e129",
}

describe("resolveDbConnectionSource", () => {
	describe("direct transport", () => {
		it("resolves a well-formed direct URL", () => {
			const source = resolveDbConnectionSource({ [DIRECT_URL_BINDING]: DIRECT_URL })

			expect(source).toStrictEqual({
				_tag: "Available",
				connectionString: DIRECT_URL,
				attributes: {
					"db.connect.mode": "direct",
					"db.namespace": "maple_prod",
					"server.address": "psbouncer.example.com",
					"server.port": 6432,
				},
			})
		})

		it("wins over a present Hyperdrive binding", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: DIRECT_URL,
				[HYPERDRIVE_BINDING]: hyperdriveBinding,
			})

			expect(source._tag).toBe("Available")
			expect(source._tag === "Available" && source.attributes["db.connect.mode"]).toBe("direct")
		})

		it("never leaks credentials into span attributes", () => {
			const source = resolveDbConnectionSource({ [DIRECT_URL_BINDING]: DIRECT_URL })

			// The connection string necessarily carries the password (the driver
			// needs it); the ATTRIBUTES are what reach a span, and must not.
			expect(source._tag).toBe("Available")
			const serialized = JSON.stringify(source._tag === "Available" ? source.attributes : {})
			expect(serialized).not.toContain("s3cr3t-p4ssw0rd")
			expect(serialized).not.toContain("app")
		})

		it("defaults the port when the URL omits it", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: "postgres://u:p@db.example.com/maple?sslmode=require",
			})

			expect(source._tag === "Available" && source.attributes["server.port"]).toBe(5432)
		})

		it("defaults the database when the URL has no path", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: "postgres://u:p@db.example.com:6432?sslmode=require",
			})

			expect(source._tag === "Available" && source.attributes["db.namespace"]).toBe("postgres")
		})
	})

	describe("direct transport rejection — must not silently fall back", () => {
		it("rejects a URL without sslmode=require", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: "postgres://u:p@psbouncer.example.com:6432/maple_prod",
				[HYPERDRIVE_BINDING]: hyperdriveBinding,
			})

			// Falling back to Hyperdrive here would make the A/B undecidable.
			expect(source._tag).toBe("Unavailable")
			expect(source._tag === "Unavailable" && source.reason).toContain("sslmode=require")
		})

		it("rejects sslmode=disable", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: "postgres://u:p@host:6432/db?sslmode=disable",
			})

			expect(source._tag).toBe("Unavailable")
		})

		it("rejects a malformed URL rather than throwing", () => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: "not-a-url",
				[HYPERDRIVE_BINDING]: hyperdriveBinding,
			})

			expect(source._tag).toBe("Unavailable")
			expect(source._tag === "Unavailable" && source.reason).toContain("valid URL")
		})
	})

	describe("blank is absent — the rollback path", () => {
		it.each(["", "   ", "\n\t"])("falls back to Hyperdrive for %j", (blank) => {
			const source = resolveDbConnectionSource({
				[DIRECT_URL_BINDING]: blank,
				[HYPERDRIVE_BINDING]: hyperdriveBinding,
			})

			expect(source._tag === "Available" && source.attributes["db.connect.mode"]).toBe("hyperdrive")
		})

		it("trims surrounding whitespace off a real URL", () => {
			const source = resolveDbConnectionSource({ [DIRECT_URL_BINDING]: `  ${DIRECT_URL}  ` })

			expect(source._tag === "Available" && source.connectionString).toBe(DIRECT_URL)
		})
	})

	describe("hyperdrive transport", () => {
		it("resolves the binding and emits its identity attributes", () => {
			const source = resolveDbConnectionSource({ [HYPERDRIVE_BINDING]: hyperdriveBinding })

			expect(source).toStrictEqual({
				_tag: "Available",
				connectionString: hyperdriveBinding.connectionString,
				attributes: {
					"db.connect.mode": "hyperdrive",
					"db.namespace": hyperdriveBinding.database,
					"server.address": hyperdriveBinding.host,
					"server.port": hyperdriveBinding.port,
				},
			})
		})
	})

	describe("unavailable", () => {
		it("reports an absent database for an empty env", () => {
			const source = resolveDbConnectionSource({})

			expect(source._tag).toBe("Unavailable")
			expect(source._tag === "Unavailable" && source.reason).toContain(HYPERDRIVE_BINDING)
		})

		it.each([
			["a string", "postgres://somewhere/maple"],
			["null", null],
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
})

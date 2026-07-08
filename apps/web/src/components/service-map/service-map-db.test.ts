import { describe, expect, it } from "vitest"
import { HYPERDRIVE_DB_NAMESPACE } from "@maple/domain/tinybird/db-query-shape-sql"

import { CloudflareIcon, PostgresIcon } from "@/components/icons"
import { getDbNodeColor, resolveDbNodePresentation } from "./service-map-db"

describe("resolveDbNodePresentation", () => {
	it("brands the Hyperdrive sentinel node with the underlying system in the badge", () => {
		const p = resolveDbNodePresentation("postgresql", HYPERDRIVE_DB_NAMESPACE)
		expect(p.title).toBe("Hyperdrive")
		expect(p.badge).toBe("PostgreSQL")
		expect(p.Icon).toBe(CloudflareIcon)
		expect(p.branded).toBe(true)
		expect(p.systemLabel).toBe("PostgreSQL via Hyperdrive")
	})

	it("shows a named database's identity as the title with the friendly system as badge", () => {
		const p = resolveDbNodePresentation("postgresql", "orders")
		expect(p.title).toBe("orders")
		expect(p.badge).toBe("PostgreSQL")
		expect(p.Icon).toBe(PostgresIcon)
	})

	it("keeps the coarse category badge for a generic (namespaceless) node", () => {
		const p = resolveDbNodePresentation("postgresql", "")
		// Generic node keeps the raw system identity as the title (pre-split behavior).
		expect(p.title).toBe("postgresql")
		expect(p.badge).toBe("database")
		expect(p.Icon).toBe(PostgresIcon)
	})

	it("colors the Hyperdrive node with the Cloudflare orange, distinct from vanilla Postgres", () => {
		const hyperdrive = getDbNodeColor("postgresql", HYPERDRIVE_DB_NAMESPACE)
		const postgres = getDbNodeColor("postgresql", "orders")
		expect(hyperdrive).not.toBe(postgres)
	})
})

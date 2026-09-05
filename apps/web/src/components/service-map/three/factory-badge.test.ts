import { describe, expect, it } from "vitest"
import { POSTGRES_MARK_PATH } from "@/components/icons/postgres"
import { resolveMachineBadge } from "./factory-badge"

describe("factory machine badges", () => {
	it("uses the database system, never the querying client's runtime", () => {
		expect(resolveMachineBadge({ kind: "database", system: " PostgreSQL ", runtime: "nodejs" })).toEqual({
			label: "PostgreSQL",
			path: POSTGRES_MARK_PATH,
		})
		expect(
			resolveMachineBadge({ kind: "database", system: "unrecognized", runtime: "nodejs" }),
		).toBeNull()
		expect(resolveMachineBadge({ kind: "database", runtime: "nodejs" })).toBeNull()
	})

	it("leaves missing and unrecognized technologies completely unbadged", () => {
		for (const runtime of [undefined, "", "  ", "unknown", "custom-runtime"]) {
			expect(resolveMachineBadge({ kind: "service", runtime })).toBeNull()
		}
		for (const kind of ["database", "queue", "external", "edge"] as const) {
			expect(resolveMachineBadge({ kind })).toBeNull()
		}
	})

	it("normalizes runtime aliases and keeps known wordmarks", () => {
		expect(resolveMachineBadge({ kind: "service", runtime: " CPython " })?.label).toBe("Python")
		expect(resolveMachineBadge({ kind: "service", runtime: ".NET Core" })).toEqual({
			label: ".NET",
			wordmark: ".NET",
		})
	})

	it("uses database and broker artwork where it is available", () => {
		for (const system of ["mysql", "redis", "clickhouse", "mongodb", "kafka", "rabbitmq", "nats"]) {
			expect(resolveMachineBadge({ kind: "database", system })?.path, system).toBeTruthy()
		}
		expect(resolveMachineBadge({ kind: "queue", system: "kafka" })?.label).toBe("Kafka")
	})
})

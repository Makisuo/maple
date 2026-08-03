// Pure-helper tests for the get_instrumentation_recommendations MCP tool.
// Detection/reconcile logic is covered by packages/domain/src/recommendations.test.ts;
// here we only guard the tool's severity mapping and coverage-gap derivation.

import { describe, expect, it } from "vitest"
import { deriveCoverageGaps, kindToSeverity } from "@/mcp/tools/get-instrumentation-recommendations"

describe("kindToSeverity", () => {
	it("maps rename and double-emission to warn", () => {
		expect(kindToSeverity("rename")).toBe("warn")
		expect(kindToSeverity("double-emission")).toBe("warn")
	})

	it("maps naming advisories to info", () => {
		expect(kindToSeverity("naming")).toBe("info")
	})
})

describe("deriveCoverageGaps", () => {
	const keys = (...names: string[]) => names.map((key) => ({ key }))

	it("reports every gap when nothing recommended arrives", () => {
		const gaps = deriveCoverageGaps(keys("service.name", "host.name"))
		expect(gaps.map((gap) => gap.checkId).sort()).toEqual(["RES-02", "RES-03", "RES-04", "RES-05"])
		expect(gaps.every((gap) => gap.severity === "warn")).toBe(true)
	})

	it("reports no gaps when all recommended attributes arrive", () => {
		const gaps = deriveCoverageGaps(
			keys(
				"service.version",
				"deployment.environment",
				"vcs.repository.url.full",
				"vcs.ref.head.revision",
			),
		)
		expect(gaps).toEqual([])
	})

	it("accepts either spelling of the deployment environment key", () => {
		const legacy = deriveCoverageGaps(keys("deployment.environment"))
		const current = deriveCoverageGaps(keys("deployment.environment.name"))
		expect(legacy.some((gap) => gap.checkId === "RES-03")).toBe(false)
		expect(current.some((gap) => gap.checkId === "RES-03")).toBe(false)
	})

	it("flags a missing VCS revision independently of the repo URL", () => {
		const gaps = deriveCoverageGaps(
			keys("service.version", "deployment.environment.name", "vcs.repository.url.full"),
		)
		expect(gaps.map((gap) => gap.checkId)).toEqual(["RES-05"])
		expect(gaps[0].attribute).toBe("vcs.ref.head.revision")
	})
})

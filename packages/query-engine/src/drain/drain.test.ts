import { describe, expect, it } from "vitest"
import { TemplateMiner, TemplateMinerConfig } from "./index"

describe("Drain TemplateMiner", () => {
	it("clusters identical messages into one template", () => {
		const tm = new TemplateMiner()
		tm.addLogMessage("user 12 logged in")
		tm.addLogMessage("user 99 logged in")
		tm.addLogMessage("user 4321 logged in")
		expect(tm.drain.clusterCount).toBe(1)
		const [cluster] = Array.from((tm.drain as unknown as { unlimitedStore: Map<number, { size: number; getTemplate(): string }> }).unlimitedStore?.values() ?? [])
		expect(cluster?.size).toBe(3)
		expect(cluster?.getTemplate()).toContain("logged")
	})

	it("creates separate templates for structurally different messages", () => {
		const tm = new TemplateMiner()
		tm.addLogMessage("GET /api/users/abc 200 14ms")
		tm.addLogMessage("GET /api/users/xyz 200 22ms")
		tm.addLogMessage("connection refused for db:5432")
		expect(tm.drain.clusterCount).toBeGreaterThanOrEqual(2)
	})

	it("respects custom masking instructions", () => {
		const cfg = new TemplateMinerConfig()
		cfg.maskingInstructions = [{ pattern: "\\d+\\.\\d+\\.\\d+\\.\\d+", maskWith: "ip" }]
		const tm = new TemplateMiner(cfg)
		const result = tm.addLogMessage("client 192.168.1.1 connected")
		expect(result.templateMined).toContain("<ip>")
	})
})

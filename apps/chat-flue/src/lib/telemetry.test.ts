import { describe, expect, it } from "vitest"
import { setupTelemetry, telemetryResourceAttributes } from "./telemetry.ts"

describe("setupTelemetry", () => {
	it("is a no-op (returns undefined) when no ingest key is configured", () => {
		expect(setupTelemetry({})).toBeUndefined()
		expect(setupTelemetry({ ingestKey: "   " })).toBeUndefined()
		expect(setupTelemetry({ environment: "production" })).toBeUndefined()
	})

	it("returns a flushable tracer provider when an ingest key is set", () => {
		const provider = setupTelemetry({
			ingestKey: "maple_pk_test",
			environment: "test",
		})

		expect(provider).toBeDefined()
		expect(typeof provider?.getTracer).toBe("function")
		expect(typeof provider?.forceFlush).toBe("function")
		expect(provider?.getTracer("maple-chat-flue")).toBeDefined()
	})

	it("emits canonical Cloudflare Worker resource attributes", () => {
		expect(
			telemetryResourceAttributes(
				{ environment: "production", serviceVersion: "abc123" },
				"instance-1",
			),
		).toMatchObject({
			"service.name": "maple-chat-flue",
			"service.namespace": "backend",
			"service.instance.id": "instance-1",
			"service.version": "abc123",
			"deployment.environment": "production",
			"deployment.environment.name": "production",
			"cloud.provider": "cloudflare",
			"cloud.platform": "cloudflare.workers",
			"process.runtime.name": "workerd",
			"maple.sdk.type": "flue",
		})
	})

	it("uses explicit development defaults for required resource identity", () => {
		expect(telemetryResourceAttributes({}, "instance-dev")).toMatchObject({
			"service.version": "dev",
			"deployment.environment": "development",
			"deployment.environment.name": "development",
		})
	})
})

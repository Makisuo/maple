import { describe, expect, it } from "vitest"
import * as EnvConfig from "./config.js"

describe("parseOtelResourceAttributes", () => {
	it("parses comma-separated key=value pairs", () => {
		const out = EnvConfig.parseOtelResourceAttributes(
			"k8s.pod.ip=10.0.0.1,k8s.pod.uid=abc-123,k8s.pod.name=web-7d4c",
		)
		expect(out).toEqual({
			"k8s.pod.ip": "10.0.0.1",
			"k8s.pod.uid": "abc-123",
			"k8s.pod.name": "web-7d4c",
		})
	})

	it("trims whitespace around keys and values", () => {
		const out = EnvConfig.parseOtelResourceAttributes(
			"  service.name = checkout , deployment.environment = prod ",
		)
		expect(out).toEqual({
			"service.name": "checkout",
			"deployment.environment": "prod",
		})
	})

	it("URL-decodes values per OTel spec", () => {
		const out = EnvConfig.parseOtelResourceAttributes("url=https%3A%2F%2Fexample.com%2Fpath")
		expect(out).toEqual({ url: "https://example.com/path" })
	})

	it("falls back to raw value when URL-decoding fails", () => {
		const out = EnvConfig.parseOtelResourceAttributes("bad=50%off")
		expect(out).toEqual({ bad: "50%off" })
	})

	it("skips malformed pairs (no equals sign)", () => {
		const out = EnvConfig.parseOtelResourceAttributes("k=v,malformed,other=ok")
		expect(out).toEqual({ k: "v", other: "ok" })
	})

	it("skips empty keys", () => {
		const out = EnvConfig.parseOtelResourceAttributes("=novalue,k=v")
		expect(out).toEqual({ k: "v" })
	})

	it("returns an empty object for an empty string", () => {
		expect(EnvConfig.parseOtelResourceAttributes("")).toEqual({})
	})
})

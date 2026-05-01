import { describe, expect, it } from "vitest"
import { derivePlatformAttributes, type PlatformInputs } from "./platform.js"

const baseInputs = (overrides: Partial<PlatformInputs> = {}): PlatformInputs => ({
	runtime: "",
	provider: "",
	platform: "",
	arch: "",
	env: {},
	...overrides,
})

describe("derivePlatformAttributes", () => {
	it("maps node runtime to OTel process.runtime.name=nodejs", () => {
		const attrs = derivePlatformAttributes(baseInputs({ runtime: "node" }))
		expect(attrs["process.runtime.name"]).toBe("nodejs")
		expect(attrs["maple.runtime"]).toBe("node")
	})

	it("passes bun and deno runtimes through verbatim", () => {
		expect(derivePlatformAttributes(baseInputs({ runtime: "bun" }))["process.runtime.name"]).toBe("bun")
		expect(derivePlatformAttributes(baseInputs({ runtime: "deno" }))["process.runtime.name"]).toBe("deno")
	})

	it("maps Node platform values to OTel os.type", () => {
		expect(derivePlatformAttributes(baseInputs({ platform: "darwin" }))["os.type"]).toBe("darwin")
		expect(derivePlatformAttributes(baseInputs({ platform: "win32" }))["os.type"]).toBe("windows")
		expect(derivePlatformAttributes(baseInputs({ platform: "linux" }))["os.type"]).toBe("linux")
	})

	it("normalizes arch names (x64 → amd64, ia32 → x86)", () => {
		expect(derivePlatformAttributes(baseInputs({ arch: "x64" }))["host.arch"]).toBe("amd64")
		expect(derivePlatformAttributes(baseInputs({ arch: "arm64" }))["host.arch"]).toBe("arm64")
		expect(derivePlatformAttributes(baseInputs({ arch: "ia32" }))["host.arch"]).toBe("x86")
	})

	it("detects AWS Lambda from AWS_LAMBDA_FUNCTION_NAME", () => {
		const attrs = derivePlatformAttributes(
			baseInputs({
				runtime: "node",
				env: {
					AWS_LAMBDA_FUNCTION_NAME: "checkout-handler",
					AWS_LAMBDA_FUNCTION_VERSION: "42",
					AWS_LAMBDA_LOG_STREAM_NAME: "2026/05/02/[$LATEST]abc",
					AWS_REGION: "eu-west-1",
				},
			}),
		)
		expect(attrs["cloud.provider"]).toBe("aws")
		expect(attrs["cloud.platform"]).toBe("aws_lambda")
		expect(attrs["faas.name"]).toBe("checkout-handler")
		expect(attrs["faas.version"]).toBe("42")
		expect(attrs["faas.instance"]).toBe("2026/05/02/[$LATEST]abc")
		expect(attrs["cloud.region"]).toBe("eu-west-1")
	})

	it("AWS Lambda detection wins over std-env provider", () => {
		// e.g. someone running Lambda inside a CI provider — Lambda is the
		// runtime that matters for the dashboard.
		const attrs = derivePlatformAttributes(
			baseInputs({
				provider: "vercel",
				env: { AWS_LAMBDA_FUNCTION_NAME: "fn" },
			}),
		)
		expect(attrs["cloud.platform"]).toBe("aws_lambda")
		expect(attrs["cloud.provider"]).toBe("aws")
	})

	it("maps cloudflare_workers provider to OTel cloudflare.workers", () => {
		const attrs = derivePlatformAttributes(baseInputs({ provider: "cloudflare_workers", runtime: "workerd" }))
		expect(attrs["cloud.provider"]).toBe("cloudflare")
		expect(attrs["cloud.platform"]).toBe("cloudflare.workers")
	})

	it("maps cloudflare_pages provider", () => {
		const attrs = derivePlatformAttributes(baseInputs({ provider: "cloudflare_pages" }))
		expect(attrs["cloud.platform"]).toBe("cloudflare.pages")
	})

	it("workerd runtime alone (no provider) is still treated as Cloudflare Workers", () => {
		const attrs = derivePlatformAttributes(baseInputs({ runtime: "workerd" }))
		expect(attrs["cloud.provider"]).toBe("cloudflare")
		expect(attrs["cloud.platform"]).toBe("cloudflare.workers")
	})

	it("maps Vercel provider with region and deployment id", () => {
		const attrs = derivePlatformAttributes(
			baseInputs({
				provider: "vercel",
				env: { VERCEL_REGION: "iad1", VERCEL_DEPLOYMENT_ID: "dpl_abc" },
			}),
		)
		expect(attrs["cloud.provider"]).toBe("vercel")
		expect(attrs["cloud.region"]).toBe("iad1")
		expect(attrs["faas.instance"]).toBe("dpl_abc")
	})

	it("edge-light + VERCEL env falls back to Vercel platform", () => {
		const attrs = derivePlatformAttributes(baseInputs({ runtime: "edge-light", env: { VERCEL: "1" } }))
		expect(attrs["cloud.provider"]).toBe("vercel")
	})

	it("maps google_cloudrun provider with K_SERVICE / K_REVISION", () => {
		const attrs = derivePlatformAttributes(
			baseInputs({
				provider: "google_cloudrun",
				env: { K_SERVICE: "billing", K_REVISION: "billing-00042-abc" },
			}),
		)
		expect(attrs["cloud.provider"]).toBe("gcp")
		expect(attrs["cloud.platform"]).toBe("gcp_cloud_run")
		expect(attrs["faas.name"]).toBe("billing")
		expect(attrs["faas.version"]).toBe("billing-00042-abc")
	})

	it("maps deno-deploy provider", () => {
		const attrs = derivePlatformAttributes(
			baseInputs({
				provider: "deno-deploy",
				runtime: "deno",
				env: { DENO_REGION: "us-east1", DENO_DEPLOYMENT_ID: "abc123" },
			}),
		)
		expect(attrs["cloud.provider"]).toBe("deno")
		expect(attrs["cloud.platform"]).toBe("deno_deploy")
		expect(attrs["cloud.region"]).toBe("us-east1")
		expect(attrs["faas.instance"]).toBe("abc123")
	})

	it("maps render and railway providers", () => {
		expect(derivePlatformAttributes(baseInputs({ provider: "render" }))["cloud.platform"]).toBe("render")
		expect(derivePlatformAttributes(baseInputs({ provider: "railway" }))["cloud.platform"]).toBe("railway")
	})

	it("returns no cloud.* when provider is unknown and not a known runtime", () => {
		const attrs = derivePlatformAttributes(baseInputs({ runtime: "node", provider: "" }))
		expect(attrs["cloud.provider"]).toBeUndefined()
		expect(attrs["cloud.platform"]).toBeUndefined()
	})

	it("does not leak unrelated env vars", () => {
		// Sanity check: derivePlatformAttributes only inspects the subset passed
		// in via inputs.env. We never reach for process.env inside the pure path.
		const attrs = derivePlatformAttributes(
			baseInputs({
				runtime: "node",
				env: { SECRET_TOKEN: "leak-me", DATABASE_URL: "postgres://..." },
			}),
		)
		expect(JSON.stringify(attrs)).not.toContain("leak-me")
		expect(JSON.stringify(attrs)).not.toContain("postgres")
	})
})

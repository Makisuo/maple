import { describe, expect, it } from "vitest"
import {
	APDEX_THRESHOLD_MS_BY_APP_KIND,
	DEFAULT_APDEX_THRESHOLD_MS,
	apdexThresholdMsForAppKind,
	classifyServiceAppKind,
	type ServiceAppKind,
	type ServiceAppKindSignals,
} from "./service-app-kind"

const NO_SIGNALS: ServiceAppKindSignals = {
	browserPlatform: "",
	telemetrySdkLanguage: "",
	mapleSdkType: "",
	deviceType: "",
	cloudPlatform: "",
	cloudProvider: "",
	faasName: "",
	k8sPodName: "",
	k8sDeploymentName: "",
}

const signals = (overrides: Partial<ServiceAppKindSignals>): ServiceAppKindSignals => ({
	...NO_SIGNALS,
	...overrides,
})

describe("classifyServiceAppKind", () => {
	const cases: ReadonlyArray<readonly [string, ServiceAppKindSignals, ServiceAppKind]> = [
		// Maple's own browser SDK writes "browser" (packages/browser/src/tracing.ts).
		// It classified as `unknown` before this signal existed, which is exactly how
		// every browser app ended up scored against a 500 ms backend target.
		["maple browser SDK", signals({ mapleSdkType: "browser" }), "browser"],
		["maple effect client SDK", signals({ mapleSdkType: "client" }), "browser"],
		// The case the vendor-neutral signals exist for: no Maple SDK anywhere.
		["vanilla OTel web", signals({ telemetrySdkLanguage: "webjs" }), "browser"],
		["browser.platform alone", signals({ browserPlatform: "macOS" }), "browser"],
		["maple mobile SDK", signals({ mapleSdkType: "mobile" }), "mobile"],
		["swift SDK", signals({ telemetrySdkLanguage: "swift" }), "mobile"],
		["device.type alone", signals({ deviceType: "phone" }), "mobile"],
		["kubernetes pod", signals({ k8sPodName: "api-7d9f-x2k" }), "backend"],
		[
			"cloudflare worker",
			signals({ cloudPlatform: "cloudflare.workers", cloudProvider: "cloudflare" }),
			"backend",
		],
		["lambda", signals({ faasName: "checkout-handler" }), "backend"],
		["maple server SDK", signals({ mapleSdkType: "server" }), "backend"],
		["no signals at all", NO_SIGNALS, "unknown"],
	]

	for (const [name, input, expected] of cases) {
		it(`classifies ${name} as ${expected}`, () => {
			expect(classifyServiceAppKind(input)).toBe(expected)
		})
	}

	// A browser app can pick up `cloud.provider` from a CDN or a `k8s.*` leak from
	// an OTel gateway it was proxied through. Neither makes it a backend, and the
	// reverse mistake is impossible — a server never reports `browser.platform`.
	it("prefers browser over host-infrastructure signals on the same service", () => {
		expect(
			classifyServiceAppKind(
				signals({
					browserPlatform: "Windows",
					cloudProvider: "cloudflare",
					k8sPodName: "otel-gateway-abc",
				}),
			),
		).toBe("browser")
	})

	it("prefers mobile over host-infrastructure signals on the same service", () => {
		expect(classifyServiceAppKind(signals({ mapleSdkType: "mobile", cloudProvider: "aws" }))).toBe(
			"mobile",
		)
	})
})

describe("apdexThresholdMsForAppKind", () => {
	it("keeps the backend default for backend and unknown", () => {
		expect(apdexThresholdMsForAppKind("backend")).toBe(DEFAULT_APDEX_THRESHOLD_MS)
		expect(apdexThresholdMsForAppKind("unknown")).toBe(DEFAULT_APDEX_THRESHOLD_MS)
	})

	// 2500 ms is the Core Web Vitals "good" LCP boundary, which puts the
	// frustrated line (4T, per the Apdex spec) at 10s.
	it("scores a browser app against the Core Web Vitals boundary", () => {
		expect(apdexThresholdMsForAppKind("browser")).toBe(2500)
	})

	it("raises the mobile target above backend but below browser", () => {
		expect(APDEX_THRESHOLD_MS_BY_APP_KIND.mobile).toBeGreaterThan(DEFAULT_APDEX_THRESHOLD_MS)
		expect(APDEX_THRESHOLD_MS_BY_APP_KIND.mobile).toBeLessThan(APDEX_THRESHOLD_MS_BY_APP_KIND.browser)
	})
})

import { Schema } from "effect"

/**
 * What kind of application a service *is* — deliberately orthogonal to
 * `ServicePlatform`, which says where it *runs*. A browser app has no hosting
 * platform; a Kubernetes pod can be a backend or a batch worker.
 *
 * The distinction earns its keep in one place today: the Apdex threshold. Apdex
 * scores a request against a satisfaction target T, and 500 ms is a target for a
 * backend API. Applied to a browser app — where a span is a request made from a
 * device on someone's home wifi — it scores every real-world user as frustrated
 * and the chart stops carrying signal.
 */
export const ServiceAppKind = Schema.Literals(["browser", "mobile", "backend", "unknown"])
export type ServiceAppKind = Schema.Schema.Type<typeof ServiceAppKind>

/** The Apdex target for a service whose kind could not be determined, and the
 * value every caller that has no service in hand (dashboards, ad-hoc queries,
 * alert rules) uses. Also the constant baked into
 * `service_overview_hourly.ApdexSatisfiedCount` / `ApdexToleratingCount`, which
 * is why the rollup path is only valid at exactly this threshold. */
export const DEFAULT_APDEX_THRESHOLD_MS = 500

/**
 * Apdex T per app kind. Frustrated starts at 4T in every case (the Apdex spec),
 * so these also set the ceilings: 2 s / 10 s for a browser app, 4 s for mobile.
 *
 * `browser` is 2500 ms because that is the Core Web Vitals "good" LCP boundary —
 * the number the rest of the industry already uses for "this page felt fast" —
 * and it puts the frustrated line at 10 s. `mobile` sits between the two: a
 * native app's network calls are slower than a datacenter's and faster than a
 * cold page load.
 */
export const APDEX_THRESHOLD_MS_BY_APP_KIND: Readonly<Record<ServiceAppKind, number>> = Object.freeze({
	browser: 2500,
	mobile: 1000,
	backend: DEFAULT_APDEX_THRESHOLD_MS,
	unknown: DEFAULT_APDEX_THRESHOLD_MS,
})

export const apdexThresholdMsForAppKind = (kind: ServiceAppKind): number =>
	APDEX_THRESHOLD_MS_BY_APP_KIND[kind]

/**
 * The resource-attribute signals the classifier reads, as stored per hour in
 * `service_platforms_hourly`. Every field is "" when the attribute was absent.
 */
export interface ServiceAppKindSignals {
	/** `browser.platform` — per OTel semconv, only ever set in a browser. */
	readonly browserPlatform: string
	/** `telemetry.sdk.language` — `webjs` is the OTel browser SDK. */
	readonly telemetrySdkLanguage: string
	/** `maple.sdk.type` — set only by Maple's own SDKs. */
	readonly mapleSdkType: string
	/** `device.type` — the mobile-side marker. */
	readonly deviceType: string
	readonly cloudPlatform: string
	readonly cloudProvider: string
	readonly faasName: string
	readonly k8sPodName: string
	readonly k8sDeploymentName: string
}

/** `telemetry.sdk.language` values that only a mobile SDK reports. */
const MOBILE_SDK_LANGUAGES = new Set(["swift", "objc", "kotlin", "android"])

/**
 * Classify a service from its resource attributes, first match wins.
 *
 * Browser is checked before everything else on purpose: a browser app can carry
 * `cloud.provider` (a CDN-injected attribute) or a `k8s.*` leak from an OTel
 * gateway it was proxied through, and neither makes it a backend. The reverse
 * mistake is not possible — a server never reports `browser.platform`.
 *
 * All-empty signals return `unknown` rather than guessing `backend`: `unknown`
 * and `backend` resolve to the same 500 ms threshold, so the honest answer costs
 * nothing, and the UI can decline to render a badge it isn't sure about.
 */
export const classifyServiceAppKind = (signals: ServiceAppKindSignals): ServiceAppKind => {
	if (
		signals.browserPlatform !== "" ||
		signals.telemetrySdkLanguage === "webjs" ||
		signals.mapleSdkType === "browser" ||
		signals.mapleSdkType === "client"
	) {
		return "browser"
	}
	if (
		signals.mapleSdkType === "mobile" ||
		MOBILE_SDK_LANGUAGES.has(signals.telemetrySdkLanguage) ||
		signals.deviceType !== ""
	) {
		return "mobile"
	}
	if (
		signals.k8sPodName !== "" ||
		signals.k8sDeploymentName !== "" ||
		signals.cloudPlatform !== "" ||
		signals.cloudProvider !== "" ||
		signals.faasName !== "" ||
		signals.mapleSdkType !== ""
	) {
		return "backend"
	}
	return "unknown"
}

/** Human label for the app-kind badge. `unknown` has none — the UI renders
 * nothing rather than a badge that says it doesn't know. */
export const SERVICE_APP_KIND_LABELS: Readonly<Record<Exclude<ServiceAppKind, "unknown">, string>> =
	Object.freeze({
		browser: "Browser",
		mobile: "Mobile",
		backend: "Backend",
	})

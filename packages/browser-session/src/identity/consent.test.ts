import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configurePrivacy,
	consentAllowedSince,
	hasConsent,
	mayPersistIdentifier,
	onConsentChange,
	resetConsentForTests,
	setConsent,
} from "./consent"

afterEach(() => {
	resetConsentForTests()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("consent", () => {
	it("captures by default", () => {
		// Defaulting `requireConsent` to true would silently stop telemetry for
		// every existing install — an availability incident dressed as a privacy
		// win. Apps opt in.
		configurePrivacy(undefined)
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(true)
	})

	it("captures nothing until consent is granted when required", () => {
		configurePrivacy({ requireConsent: true })
		expect(hasConsent()).toBe(false)
		expect(mayPersistIdentifier()).toBe(false)

		setConsent(true)
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(true)

		setConsent(false)
		expect(hasConsent()).toBe(false)
	})

	it("notifies only effective transitions and advances the grant boundary", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T10:00:00Z"))
		const changes: boolean[] = []
		const stop = onConsentChange((allowed) => changes.push(allowed))

		configurePrivacy({ requireConsent: true })
		expect(changes).toEqual([false])
		expect(consentAllowedSince()).toBe(Number.POSITIVE_INFINITY)
		vi.advanceTimersByTime(1_000)
		setConsent(true)
		expect(changes).toEqual([false, true])
		expect(consentAllowedSince()).toBe(Date.now())
		setConsent(true)
		expect(changes).toEqual([false, true])

		stop()
		setConsent(false)
		expect(changes).toEqual([false, true])
	})

	it("re-stamps the allowed-since boundary across a revoke/re-grant cycle", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T12:00:00Z"))
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		const firstGrant = consentAllowedSince()

		setConsent(false)
		expect(consentAllowedSince()).toBe(Number.POSITIVE_INFINITY)

		vi.advanceTimersByTime(60_000)
		setConsent(true)

		// Exporters discard anything older than this, so resurrecting the first
		// grant's timestamp would release everything buffered during the revoked
		// window — the case the doc comment on `consentAllowedSince` promises.
		expect(consentAllowedSince()).toBe(firstGrant + 60_000)
	})

	it("only ever tightens: a second configure without the option keeps the gate", () => {
		// Both SDKs call configurePrivacy at startup, and an app can init one of
		// them without a privacy block. Letting the absent option win would drop
		// the gate and — worse — the denied→allowed transition would start capture
		// on a user who never consented.
		const changes: boolean[] = []
		configurePrivacy({ requireConsent: true })
		onConsentChange((allowed) => changes.push(allowed))

		configurePrivacy(undefined)

		expect(hasConsent()).toBe(false)
		expect(changes).toEqual([])
	})

	it("shares one decision across every copy of the module on the page", () => {
		// An app bundling both SDKs gets two copies of this module; per-copy state
		// would mean one copy captures while the other is still gated.
		configurePrivacy({ requireConsent: true })
		setConsent(true)

		const shared = (globalThis as Record<string, unknown>)["__MAPLE_BROWSER_CONSENT__"]
		expect(shared).toMatchObject({ granted: true, requireConsent: true })
	})

	it("honors Global Privacy Control against the persistent id only", () => {
		vi.stubGlobal("navigator", { globalPrivacyControl: true })
		configurePrivacy(undefined)
		// GPC is legally recognized in several US states and maps exactly onto the
		// one cross-session identifier this SDK stores. The session itself — which
		// powers replay and error triage — is still captured, anonymously.
		expect(hasConsent()).toBe(true)
		expect(mayPersistIdentifier()).toBe(false)
	})

	it("ignores doNotTrack unless the app opts in", () => {
		vi.stubGlobal("navigator", { doNotTrack: "1" })

		// Deprecated and removed from Safari, so honoring it by default would
		// mostly drop data from users who never intended to opt out.
		configurePrivacy(undefined)
		expect(mayPersistIdentifier()).toBe(true)

		configurePrivacy({ respectDoNotTrack: true })
		expect(mayPersistIdentifier()).toBe(false)
	})

	it("does not assume a navigator exists", () => {
		configurePrivacy(undefined)
		expect(mayPersistIdentifier()).toBe(true)
	})
})

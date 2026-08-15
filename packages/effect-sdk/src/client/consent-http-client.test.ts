// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, describe, expect, it, vi } from "vitest"
import { configurePrivacy, resetConsentForTests, setConsent } from "@maple/browser-session"
import { HttpClientRequest } from "effect/unstable/http"
import { filterOtlpRequestForConsent } from "./consent-http-client.js"

const traceRequest = (spans: Array<{ name: string; startTimeUnixNano: string }>) =>
	HttpClientRequest.post("https://collector.test/v1/traces").pipe(
		HttpClientRequest.bodyJsonUnsafe({
			resourceSpans: [{ scopeSpans: [{ spans }] }],
		}),
	)

interface ReadSpan {
	readonly name: string
	readonly startTimeUnixNano?: unknown
}
interface ReadOtlpBody {
	readonly resourceSpans: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ReadSpan> }>
	}>
}

const readJson = (request: HttpClientRequest.HttpClientRequest): ReadOtlpBody => {
	if (request.body._tag !== "Uint8Array") throw new Error("expected JSON body")
	return JSON.parse(new TextDecoder().decode(request.body.body)) as ReadOtlpBody
}

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	vi.useRealTimers()
})

describe("consent OTLP transport", () => {
	it("drops every request while denied", () => {
		configurePrivacy({ requireConsent: true })
		expect(filterOtlpRequestForConsent(traceRequest([]), true)).toBeUndefined()
	})

	it("removes spans captured before the current grant", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T12:00:00Z"))
		configurePrivacy({ requireConsent: true })
		const beforeGrant = BigInt(Date.now() - 1_000) * 1_000_000n
		setConsent(true)
		const afterGrant = BigInt(Date.now() + 1) * 1_000_000n
		const filtered = filterOtlpRequestForConsent(
			traceRequest([
				{ name: "before", startTimeUnixNano: beforeGrant.toString() },
				{ name: "after", startTimeUnixNano: afterGrant.toString() },
			]),
			true,
		)

		expect(filtered).toBeDefined()
		const spans = readJson(filtered!).resourceSpans[0].scopeSpans[0].spans
		expect(spans.map((span) => span.name)).toEqual(["after"])
	})

	it("removes spans from a previous grant after a revoke/re-grant cycle", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-02T12:00:00Z"))
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		const duringFirstGrant = BigInt(Date.now() + 1) * 1_000_000n

		setConsent(false)
		vi.advanceTimersByTime(60_000)
		setConsent(true)
		const afterReGrant = BigInt(Date.now() + 1) * 1_000_000n

		// A revoke is a request to forget, so the re-grant must not release what
		// the earlier grant produced — the boundary moves forward, it does not
		// reopen.
		const filtered = filterOtlpRequestForConsent(
			traceRequest([
				{ name: "first-grant", startTimeUnixNano: duringFirstGrant.toString() },
				{ name: "second-grant", startTimeUnixNano: afterReGrant.toString() },
			]),
			true,
		)

		expect(filtered).toBeDefined()
		const spans = readJson(filtered!).resourceSpans[0].scopeSpans[0].spans
		expect(spans.map((span) => span.name)).toEqual(["second-grant"])
	})

	it("fails closed for cumulative metrics under explicit consent gating", () => {
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		const request = HttpClientRequest.post("https://collector.test/v1/metrics").pipe(
			HttpClientRequest.bodyJsonUnsafe({ resourceMetrics: [] }),
		)
		expect(filterOtlpRequestForConsent(request, true)).toBeUndefined()
	})
})

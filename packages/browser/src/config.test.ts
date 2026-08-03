import { describe, expect, it } from "vitest"
import { resolveConfig } from "./config"

describe("resolveConfig", () => {
	it("applies defaults and strips the endpoint's trailing slash", () => {
		const config = resolveConfig({
			ingestKey: "maple_pk_x",
			serviceName: "acme-web",
		})
		expect(config.endpoint).toBe("https://ingest.maple.dev")
		expect(config.tracingEnabled).toBe(true)
		expect(config.tracingInstrumentFetch).toBe(true)
		expect(config.replayEnabled).toBe(true)
		expect(config.replaySampleRate).toBe(1)
		expect(config.maskAllInputs).toBe(true)
		expect(config.maskAllText).toBe(false)
		// Capture everything by default; a consent gate or a visitor-id opt-out is
		// something an app turns on, not something that silently changes under it.
		expect(config.persistVisitorId).toBe(true)
		expect(config.requireConsent).toBe(false)
		expect(config.captureUserEmail).toBe(true)
		expect(config.respectDoNotTrack).toBe(false)

		const custom = resolveConfig({
			ingestKey: "maple_pk_x",
			serviceName: "acme-web",
			endpoint: "https://ingest.example.com/",
			userId: null,
			tracing: { instrumentFetch: false },
			replay: { sampleRate: 0.25 },
			privacy: { persistVisitorId: false, requireConsent: true },
		})
		expect(custom.endpoint).toBe("https://ingest.example.com")
		expect(custom.identity).toBeUndefined()
		expect(custom.tracingInstrumentFetch).toBe(false)
		expect(custom.replaySampleRate).toBe(0.25)
		expect(custom.persistVisitorId).toBe(false)
		expect(custom.requireConsent).toBe(true)
	})

	it("accepts the legacy userId string and the richer user object", () => {
		// `userId` is what every existing integration passes, so it has to keep
		// resolving to the same identity the new `user` object produces.
		const legacy = resolveConfig({
			ingestKey: "k",
			serviceName: "s",
			userId: "user_123",
		})
		expect(legacy.identity).toEqual({ id: "user_123", traits: {} })

		const rich = resolveConfig({
			ingestKey: "k",
			serviceName: "s",
			user: {
				id: "user_123",
				email: "a@b.com",
				groupId: "org_1",
				groupName: "Acme",
			},
		})
		expect(rich.identity).toMatchObject({
			id: "user_123",
			email: "a@b.com",
			groupId: "org_1",
			groupName: "Acme",
		})
	})

	it("prefers user over the deprecated userId when both are set", () => {
		const config = resolveConfig({
			ingestKey: "k",
			serviceName: "s",
			userId: "legacy",
			user: { id: "modern" },
		})
		expect(config.identity?.id).toBe("modern")
	})
})

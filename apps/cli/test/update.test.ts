import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { match, ok, strictEqual } from "node:assert"
import {
	CHECK_TTL_MS,
	fetchLatestTag,
	fetchText,
	isNewer,
	shouldCheck,
	stripV,
	targetTripleFor,
	downloadTo,
} from "../src/core/update"

describe("stripV", () => {
	it("drops a leading v", () => {
		strictEqual(stripV("v0.6.0"), "0.6.0")
		strictEqual(stripV("0.6.0"), "0.6.0")
		strictEqual(stripV("v1.2.3-beta.1"), "1.2.3-beta.1")
	})
})

describe("isNewer", () => {
	it("detects newer major/minor/patch", () => {
		strictEqual(isNewer("0.5.0", "v0.6.0"), true)
		strictEqual(isNewer("0.5.9", "v0.6.0"), true)
		strictEqual(isNewer("0.6.0", "v0.6.1"), true)
		strictEqual(isNewer("0.9.9", "v1.0.0"), true)
	})

	it("is false for equal or older latest", () => {
		strictEqual(isNewer("0.6.0", "v0.6.0"), false)
		strictEqual(isNewer("0.6.1", "v0.6.0"), false)
		strictEqual(isNewer("1.0.0", "v0.9.9"), false)
	})

	it("normalizes a leading v on both sides", () => {
		strictEqual(isNewer("v0.5.0", "v0.6.0"), true)
		strictEqual(isNewer("0.5.0", "0.6.0"), true)
	})

	it("ignores pre-release/build suffixes (compares major.minor.patch)", () => {
		strictEqual(isNewer("0.6.0", "v0.6.0-rc.1"), false)
		strictEqual(isNewer("0.5.0", "v0.6.0-rc.1"), true)
	})

	it("never nags for dev or unparseable versions", () => {
		strictEqual(isNewer("dev", "v0.6.0"), false)
		strictEqual(isNewer("0.6.0", "nightly"), false)
		strictEqual(isNewer("garbage", "v0.6.0"), false)
	})
})

describe("targetTripleFor", () => {
	it("maps supported platform/arch pairs", () => {
		strictEqual(targetTripleFor("darwin", "arm64"), "aarch64-apple-darwin")
		strictEqual(targetTripleFor("darwin", "x64"), "x86_64-apple-darwin")
		strictEqual(targetTripleFor("linux", "x64"), "x86_64-unknown-linux-gnu")
		strictEqual(targetTripleFor("linux", "arm64"), "aarch64-unknown-linux-gnu")
	})

	it("returns null for unsupported pairs", () => {
		strictEqual(targetTripleFor("win32", "x64"), null)
		strictEqual(targetTripleFor("darwin", "ia32"), null)
		strictEqual(targetTripleFor("linux", "mips"), null)
	})
})

describe("shouldCheck", () => {
	const now = Date.parse("2026-05-31T12:00:00.000Z")

	it("checks when never checked or unparseable", () => {
		strictEqual(shouldCheck(undefined, now), true)
		strictEqual(shouldCheck("not-a-date", now), true)
	})

	it("skips within the TTL window", () => {
		const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
		strictEqual(shouldCheck(oneHourAgo, now), false)
	})

	it("checks once the TTL has elapsed", () => {
		const stale = new Date(now - CHECK_TTL_MS - 1000).toISOString()
		strictEqual(shouldCheck(stale, now), true)
	})

	it("checks exactly at the TTL boundary", () => {
		const exactlyTtl = new Date(now - CHECK_TTL_MS).toISOString()
		strictEqual(shouldCheck(exactlyTtl, now), true)
	})
})

describe("fetchLatestTag", () => {
	it.effect("uses an interruptible request and returns the published tag", () =>
		Effect.gen(function* () {
			let signal: AbortSignal | undefined
			const fetchStub: typeof globalThis.fetch = async (_input, init) => {
				signal = init?.signal ?? undefined
				return Response.json({ tag_name: "v1.2.3" })
			}

			strictEqual(
				yield* fetchLatestTag().pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub)),
				"v1.2.3",
			)
			ok(signal instanceof AbortSignal)
		}),
	)

	it.effect("maps GitHub failures to UpdateError", () =>
		Effect.gen(function* () {
			const fetchStub: typeof globalThis.fetch = async () =>
				new Response("busy", { status: 503, statusText: "Busy" })

			const error = yield* fetchLatestTag().pipe(
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
				Effect.flip,
			)

			strictEqual(error._tag, "@maple/cli/UpdateError")
			match(error.message, /GitHub API returned 503 Busy/)
		}),
	)

	it.effect("rejects an empty release tag", () =>
		Effect.gen(function* () {
			const fetchStub: typeof globalThis.fetch = async () => Response.json({ tag_name: "   " })
			const error = yield* fetchLatestTag().pipe(
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
				Effect.flip,
			)

			match(error.message, /did not include a release tag/)
		}),
	)

	it.live("aborts a stalled latest-release request on timeout", () =>
		Effect.gen(function* () {
			let signal: AbortSignal | undefined
			const fetchStub: typeof globalThis.fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					signal = init?.signal ?? undefined
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
				})
			const error = yield* fetchLatestTag(10).pipe(
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
				Effect.flip,
			)

			strictEqual(signal?.aborted, true)
			match(error.message, /timed out after 10ms/)
		}),
	)

	it.live("aborts stalled release asset and checksum requests", () =>
		Effect.gen(function* () {
			const signals: AbortSignal[] = []
			const fetchStub: typeof globalThis.fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal
					if (signal) signals.push(signal)
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
				})
			const runTimed = <A>(effect: Effect.Effect<A, unknown>) =>
				effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub), Effect.flip)

			const downloadError = yield* runTimed(
				downloadTo("https://releases.test/bundle.tar.gz", "/tmp/maple-test-bundle", "25 millis"),
			)
			const checksumError = yield* runTimed(
				fetchText("https://releases.test/bundle.tar.gz.sha256", "25 millis"),
			)

			strictEqual(signals.length, 2)
			strictEqual(
				signals.every((signal) => signal.aborted),
				true,
			)
			match(String(downloadError), /download timed out/)
			match(String(checksumError), /request timed out/)
		}),
	)
})

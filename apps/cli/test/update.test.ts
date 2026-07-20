import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
	__testables,
	CHECK_TTL_MS,
	fetchLatestTag,
	isNewer,
	shouldCheck,
	stripV,
	targetTripleFor,
} from "../src/core/update"

const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>, fetchStub: typeof fetch) =>
	effect.pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fetchStub),
	)

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

describe("update HTTP", () => {
	it.effect("decodes the latest release tag without mutating global fetch", () =>
		Effect.gen(function* () {
			const fetchStub = (async () => Response.json({ tag_name: "v1.2.3" })) as typeof fetch
			const tag = yield* withFetch(fetchLatestTag(), fetchStub)
			strictEqual(tag, "v1.2.3")
		}),
	)

	it.effect("maps non-2xx and decode failures to UpdateError", () =>
		Effect.gen(function* () {
			const statusError = yield* Effect.flip(
				withFetch(
					fetchLatestTag(),
					(async () => new Response("unavailable", { status: 503 })) as typeof fetch,
				),
			)
			strictEqual(statusError._tag, "@maple/cli/UpdateError")
			ok(statusError.message.includes("503"))

			const decodeError = yield* Effect.flip(
				withFetch(fetchLatestTag(), (async () => new Response("not-json")) as typeof fetch),
			)
			strictEqual(decodeError._tag, "@maple/cli/UpdateError")
			ok(decodeError.message.includes("decode"))
		}),
	)

	it("aborts a tag request at its configured deadline", async () => {
		let aborted = false
		const fetchStub = ((input: string | URL | Request, init?: RequestInit) => {
			const signal = input instanceof Request ? input.signal : init?.signal
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					aborted = true
					reject(new DOMException("aborted", "AbortError"))
				})
			})
		}) as typeof fetch
		const error = await Effect.runPromise(Effect.flip(withFetch(fetchLatestTag(5), fetchStub)))
		ok(error.message.includes("timed out"))
		strictEqual(aborted, true)
	})

	it("downloads release bytes and reads checksums through the shared client", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maple-update-http-"))
		const destination = join(dir, "release.tar.gz")
		const fetchStub = (async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input)
			return url.endsWith(".sha256")
				? new Response("abc123  release.tar.gz\n")
				: new Response("release-bytes")
		}) as typeof fetch

		try {
			await Effect.runPromise(
				withFetch(
					__testables.downloadTo(
						"https://release.test/release.tar.gz",
						destination,
						Duration.seconds(1),
					),
					fetchStub,
				),
			)
			strictEqual(await readFile(destination, "utf8"), "release-bytes")
			strictEqual(
				await Effect.runPromise(
					withFetch(
						__testables.fetchText(
							"https://release.test/release.tar.gz.sha256",
							Duration.seconds(1),
						),
						fetchStub,
					),
				),
				"abc123  release.tar.gz\n",
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

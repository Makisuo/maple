import { describe, expect, it } from "vitest"
import { Effect, Exit, Option } from "effect"
import { safeFetch, UrlValidationError, validateExternalUrl, validateExternalUrlSync } from "./url-validator"

const runFailure = <A, E>(eff: Effect.Effect<A, E>): E | undefined => {
	const exit = Effect.runSyncExit(eff)
	return Option.getOrUndefined(Exit.findErrorOption(exit))
}

describe("validateExternalUrlSync", () => {
	it("accepts public https URLs", () => {
		const url = validateExternalUrlSync("https://api.example.com/probe")
		expect(url.hostname).toBe("api.example.com")
	})

	it("accepts public http URLs", () => {
		const url = validateExternalUrlSync("http://prom.public.dev:9090/metrics")
		expect(url.hostname).toBe("prom.public.dev")
	})

	it.each([
		"javascript:alert(1)",
		"file:///etc/passwd",
		"ftp://example.com",
		"data:text/html,<script>",
	])("rejects non-http(s) scheme: %s", (raw) => {
		expect(() => validateExternalUrlSync(raw)).toThrow(UrlValidationError)
	})

	it.each([
		"http://localhost",
		"http://localhost.localdomain",
		"http://127.0.0.1",
		"http://127.0.0.99/api",
		"http://0.0.0.0",
		"http://10.0.0.1",
		"http://192.168.1.1",
		"http://172.16.0.1",
		"http://172.31.255.255",
		"http://169.254.169.254/latest/meta-data/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://[::1]/",
		"http://[fe80::1]/",
		"http://[fc00::1]/",
		"http://[fd12:3456:789a::1]/",
		// IPv4-mapped IPv6: most URL parsers canonicalise these to the hex
		// form (e.g. `[::ffff:7f00:1]` for 127.0.0.1), so match both forms.
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[::ffff:10.0.0.1]/",
		"http://[::ffff:192.168.1.1]/",
		"http://[::ffff:172.20.0.1]/",
	])("rejects private/loopback host: %s", (raw) => {
		expect(() => validateExternalUrlSync(raw)).toThrow(UrlValidationError)
	})

	it("rejects empty string", () => {
		expect(() => validateExternalUrlSync("")).toThrow(UrlValidationError)
		expect(() => validateExternalUrlSync("   ")).toThrow(UrlValidationError)
	})

	it("rejects malformed input", () => {
		expect(() => validateExternalUrlSync("not a url")).toThrow(UrlValidationError)
	})
})

describe("validateExternalUrl (Effect)", () => {
	it("succeeds for a public URL", () => {
		const exit = Effect.runSyncExit(validateExternalUrl("https://hooks.slack.com/services/abc"))
		expect(Exit.isSuccess(exit)).toBe(true)
	})

	it("fails with UrlValidationError for a private URL", () => {
		const error = runFailure(validateExternalUrl("http://169.254.169.254"))
		expect(error).toBeInstanceOf(UrlValidationError)
	})
})

describe("safeFetch", () => {
	it("issues the request when the URL is public", async () => {
		const calls: Array<string> = []
		const fakeFetch: typeof fetch = async (input) => {
			const u = typeof input === "string" ? input : (input as URL).toString()
			calls.push(u)
			return new Response("ok", { status: 200 })
		}
		const response = await safeFetch("https://api.example.com/x", { fetchFn: fakeFetch })
		expect(response.status).toBe(200)
		expect(calls).toEqual(["https://api.example.com/x"])
	})

	it("rejects an internal URL before fetching", async () => {
		const fakeFetch: typeof fetch = async () => {
			throw new Error("should not be called")
		}
		await expect(
			safeFetch("http://169.254.169.254/", { fetchFn: fakeFetch }),
		).rejects.toBeInstanceOf(UrlValidationError)
	})

	it("rejects a redirect to an internal URL", async () => {
		let calls = 0
		const fakeFetch: typeof fetch = async () => {
			calls++
			return new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/admin" },
			})
		}
		await expect(
			safeFetch("https://api.example.com/x", { fetchFn: fakeFetch }),
		).rejects.toBeInstanceOf(UrlValidationError)
		expect(calls).toBe(1)
	})

	it("follows a redirect to another public URL", async () => {
		let calls = 0
		const fakeFetch: typeof fetch = async (input) => {
			calls++
			if (calls === 1) {
				return new Response(null, {
					status: 302,
					headers: { location: "https://api2.example.com/y" },
				})
			}
			expect(typeof input === "string" ? input : (input as URL).toString()).toBe(
				"https://api2.example.com/y",
			)
			return new Response("ok", { status: 200 })
		}
		const response = await safeFetch("https://api1.example.com/x", { fetchFn: fakeFetch })
		expect(response.status).toBe(200)
		expect(calls).toBe(2)
	})

	it("caps redirect chains", async () => {
		let calls = 0
		const fakeFetch: typeof fetch = async () => {
			calls++
			return new Response(null, {
				status: 302,
				headers: { location: `https://api${calls}.example.com/r` },
			})
		}
		await expect(
			safeFetch("https://api0.example.com/r", { fetchFn: fakeFetch }),
		).rejects.toBeInstanceOf(UrlValidationError)
	})
})

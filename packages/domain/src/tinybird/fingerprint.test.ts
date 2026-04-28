import { describe, expect, it } from "vitest"
import { computeFingerprintInputs } from "./fingerprint"

describe("error fingerprint normalization", () => {
	it("extracts and normalizes top 3 Node.js frames", () => {
		const stack = [
			"TypeError: Cannot read properties of undefined (reading 'id')",
			"    at getUser (/app/src/users.ts:42:18)",
			"    at handler (/app/src/routes/user.ts:17:21)",
			"    at process (/app/src/server.ts:88:12)",
			"    at Server._events (internal/server.js:512:9)",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "TypeError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		expect(result.topFrame).toBe("    at getUser (/app/src/users.ts)")
		expect(result.fpFrames.split("\n")).toHaveLength(3)
		expect(result.fpFrames).toContain("getUser")
		expect(result.fpFrames).toContain("handler")
		expect(result.fpFrames).toContain("process")
		expect(result.msgFallback).toBe("")
	})

	it("skips Python 'Traceback' header and picks the File lines", () => {
		const stack = [
			"Traceback (most recent call last):",
			'  File "/app/main.py", line 42, in get_user',
			"    user = db.query(user_id)",
			'  File "/app/db.py", line 101, in query',
			"    raise ValueError(f'bad id {user_id}')",
			"ValueError: bad id 12345",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "ValueError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		// Header line is skipped; only File lines with :NUMBER are kept.
		expect(result.topFrame).toContain("/app/main.py")
		expect(result.topFrame).not.toContain("Traceback")
		// Line numbers are stripped; identifiers remain.
		expect(result.topFrame).not.toMatch(/line 42/)
	})

	it("strips Java line numbers and keeps frame identifiers", () => {
		const stack = [
			'java.lang.NullPointerException: Cannot invoke "String.length()"',
			"\tat com.example.UserService.getUser(UserService.java:45)",
			"\tat com.example.UserController.handle(UserController.java:23)",
			"\tat com.example.Main.main(Main.java:12)",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "java.lang.NullPointerException",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		expect(result.topFrame).toContain("UserService.getUser")
		expect(result.topFrame).toContain("UserService.java)")
		expect(result.topFrame).not.toMatch(/:45/)
		expect(result.fpFrames.split("\n")).toHaveLength(3)
	})

	it("ignores language-specific header lines that have no :NUMBER", () => {
		const stack = [
			"RuntimeError: something went wrong 0xdeadbeef",
			"\tat main.go:10 +0x1234",
			"\tat runtime.go:50 +0x5678",
		].join("\n")

		const result = computeFingerprintInputs({
			exceptionType: "RuntimeError",
			exceptionStacktrace: stack,
			statusMessage: "",
		})

		// Header ("RuntimeError: ...") contains no :NUMBER and is skipped.
		expect(result.topFrame).toContain("main.go")
		expect(result.topFrame).not.toContain("RuntimeError")
		// Hex pointers are stripped.
		expect(result.fpFrames).not.toMatch(/0x[0-9a-fA-F]+/)
	})

	it("produces stable fpFrames under line-number churn", () => {
		const stackA = "    at f (/a.ts:10:5)\n    at g (/b.ts:20:5)"
		const stackB = "    at f (/a.ts:99:1)\n    at g (/b.ts:200:9)"

		const a = computeFingerprintInputs({
			exceptionType: "Error",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "Error",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		expect(a.fpFrames).toBe(b.fpFrames)
	})

	it("distinguishes different call sites even when the top frame is shared", () => {
		const shared = "    at JSON.parse (/node_modules/json/index.js:5:10)"
		const stackA = `${shared}\n    at loadConfig (/app/config.ts:42:5)`
		const stackB = `${shared}\n    at loadUser (/app/user.ts:99:3)`

		const a = computeFingerprintInputs({
			exceptionType: "SyntaxError",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "SyntaxError",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		// Top frame is the same shared library site, but deeper frames differ,
		// so fpFrames (which feeds the hash) must differ.
		expect(a.topFrame).toBe(b.topFrame)
		expect(a.fpFrames).not.toBe(b.fpFrames)
	})

	describe("status-only error fallback", () => {
		it("redacts IDs and numbers from StatusMessage when no stack is present", () => {
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "failed to load user 12345 from tenant abcdef1234",
			})

			expect(result.fpFrames).toBe("")
			expect(result.msgFallback).toBe("failed to load user # from tenant #")
		})

		it("groups two status-only errors with the same shape but different IDs", () => {
			const a = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "db timeout on query 42",
			})
			const b = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "db timeout on query 9999",
			})

			expect(a.msgFallback).toBe(b.msgFallback)
		})

		it("still computes the fallback when only an exception type is present (no frames)", () => {
			// Previously the fallback was gated on exceptionType === "", which let
			// generic types like "HttpServerError" or "Error" monopolize one bucket
			// per service. With frames absent, the normalized message must
			// differentiate occurrences regardless of whether a type was set.
			const result = computeFingerprintInputs({
				exceptionType: "TimeoutError",
				exceptionStacktrace: "",
				statusMessage: "db timeout 12345",
			})

			expect(result.msgFallback).toBe("db timeout #")
		})

		it("splits a generic ExceptionType bucket by normalized StatusMessage", () => {
			const a = computeFingerprintInputs({
				exceptionType: "HttpServerError",
				exceptionStacktrace: "",
				statusMessage: "RouteNotFound (GET /robots.txt)",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpServerError",
				exceptionStacktrace: "",
				statusMessage: "RouteNotFound (GET /.env)",
			})

			expect(a.msgFallback).not.toBe(b.msgFallback)
			expect(a.msgFallback).toContain("/robots.txt")
			expect(b.msgFallback).toContain("/.env")
		})

		it("splits a malformed-ExceptionType bucket (JSON-prefix leak) by message", () => {
			// Regression guard: if upstream instrumentation ever leaks a truncated
			// JSON prefix like `{ "type"` into exception.type, distinct underlying
			// errors must still produce distinct msgFallbacks.
			const a = computeFingerprintInputs({
				exceptionType: '{ "type"',
				exceptionStacktrace: "",
				statusMessage: "StripeCardError: card_declined for customer cus_abc",
			})
			const b = computeFingerprintInputs({
				exceptionType: '{ "type"',
				exceptionStacktrace: "",
				statusMessage: "StripeInvalidRequestError: No such price: price_xyz",
			})

			expect(a.msgFallback).not.toBe(b.msgFallback)
		})

		it("does not use the fallback when there are frames", () => {
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "    at f (/a.ts:10:5)",
				statusMessage: "status only 123",
			})

			expect(result.msgFallback).toBe("")
		})

		it("truncates long StatusMessage to 200 characters before redaction", () => {
			const long = "x".repeat(500)
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: long,
			})

			expect(result.msgFallback.length).toBeLessThanOrEqual(200)
		})
	})
})

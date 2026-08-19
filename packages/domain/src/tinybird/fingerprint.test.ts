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
		expect(result.msgSignature).toBe("")
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

	it("produces stable fpFrames under trace/span id churn in the frame line", () => {
		// The real defect behind 634 duplicate @maple/cli/IngestRejected issues: the
		// first stack line carried a trace id, and only `:<line>` was redacted.
		const stackA =
			"    at ingest (/app/cli.ts:10:5) traceId=4bf92f3577b34da6a3ce929d0e0e4736 req=1048576\n    at g (/b.ts:20:5)"
		const stackB =
			"    at ingest (/app/cli.ts:10:5) traceId=00f067aa0ba902b7a1b2c3d4e5f60718 req=2097152\n    at g (/b.ts:20:5)"

		const a = computeFingerprintInputs({
			exceptionType: "IngestRejected",
			exceptionStacktrace: stackA,
			statusMessage: "",
		})
		const b = computeFingerprintInputs({
			exceptionType: "IngestRejected",
			exceptionStacktrace: stackB,
			statusMessage: "",
		})

		expect(a.fpFrames).toBe(b.fpFrames)
		expect(a.topFrame).toBe(b.topFrame)
		expect(a.fpFrames).not.toMatch(/[0-9a-fA-F]{8,}/)
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

	describe("frame shape matching", () => {
		// Every case here is a real production stack that the old
		// "contains :NUMBER" rule accepted as a frame, putting variable text into
		// the hash. Together they accounted for ~66k of 68.5k fingerprints.

		it("does not treat Drizzle's params line as a frame", () => {
			// The params line carries the actual row values — uuid, org id, customer
			// email, branch names, timestamps — so one bug became one issue per row:
			// 15,051 fingerprints for 13 real call sites.
			const stack = [
				'@maple/api/lib/DatabaseError: Failed query: insert into "planetscale_events"',
				"params: e6261d5f-bee7-4f98-a313-42cb91f5f5bc,org_3AuiNC,deploy_request.opened,36,david@superwall.com,2026-08-05T00:30:19.311Z",
				"    at toDatabaseError (worker.js:1542:13655)",
				"    at worker.js:14:7233",
			].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/api/lib/DatabaseError",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toContain("toDatabaseError")
			expect(result.fpFrames).not.toContain("params:")
			expect(result.fpFrames).not.toContain("@superwall.com")
		})

		it("does not treat a multi-line SQL body as frames", () => {
			// `from (values ($2::text, ...))` matched the Ruby `from ` alternative
			// until it was required to carry a `path:line`.
			const stack = [
				"@maple/api/lib/DatabaseError: Failed query: update x",
				"\t\t\t\tfrom (values ($2::text, $3::timestamptz, $4::integer)) as v(id, seen, cnt)",
				"    at toDatabaseError (worker.js:1542:13655)",
			].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/api/lib/DatabaseError",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toContain("toDatabaseError")
			expect(result.fpFrames).not.toContain("values")
		})

		it("does not treat the `Type: message` header as a frame", () => {
			// `Code: 62` and `position 1628` made the header look frame-shaped, so
			// the embedded query text entered the hash: 19,667 fingerprints for 23
			// real call sites.
			const header =
				'@maple/cli/IngestRejected: chDB insert (traces): Code: 62. Syntax error: failed at position 1628 (\'{"start_time":"2026-08-15 14:32:11"}\')'
			const stack = [header, "    at <anonymous> (/$bunfs/root/maple:61585:39)"].join("\n")

			const result = computeFingerprintInputs({
				exceptionType: "@maple/cli/IngestRejected",
				exceptionStacktrace: stack,
				statusMessage: "",
			})

			expect(result.topFrame).toContain("/$bunfs/root/maple")
			expect(result.fpFrames).not.toContain("position")
			expect(result.fpFrames).not.toContain("start_time")
		})

		it("groups the same bug across preview hosts and redeploys", () => {
			// Vite rewrites the 8-char content hash on every build, and preview
			// deploys serve from their own host; on the old rule each combination
			// was a separate issue for the same bug.
			const a = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace:
					"    at catch (https://app.maple.dev/assets/atom-client-eWeX5omb.js:1:2)",
				statusMessage: "",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace:
					"    at catch (https://app-pr-246.maple.dev/assets/atom-client-DpaqQq9R.js:9:9)",
				statusMessage: "",
			})

			expect(a.fpFrames).toBe(b.fpFrames)
			expect(a.fpFrames).toContain("/assets/atom-client.js")
		})

		it("accepts a Firefox/Safari `func@url:line:col` frame", () => {
			const result = computeFingerprintInputs({
				exceptionType: "TypeError",
				exceptionStacktrace: "getUser@https://app.maple.dev/assets/index-s17g7I3p.js:42:18",
				statusMessage: "",
			})

			expect(result.topFrame).toBe("getUser@/assets/index.js")
		})

		it("falls back to the signature when a stack has no frame-shaped lines", () => {
			const result = computeFingerprintInputs({
				exceptionType: "SomeError",
				exceptionStacktrace: "SomeError: everything is on fire at 12:30",
				statusMessage: "everything is on fire at 12:30",
			})

			expect(result.fpFrames).toBe("")
			expect(result.msgSignature).toBe("everything is on fire at #:#")
		})
	})

	describe("message signature", () => {
		it("redacts IDs and numbers from StatusMessage when no stack is present", () => {
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "failed to load user 12345 from tenant abcdef1234",
			})

			expect(result.fpFrames).toBe("")
			expect(result.msgSignature).toBe("failed to load user # from tenant #")
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

			expect(a.msgSignature).toBe(b.msgSignature)
		})

		it("still computes the signature when only an exception type is present (no frames)", () => {
			// Previously the signature was gated on exceptionType === "", which let
			// generic types like "HttpServerError" or "Error" monopolize one bucket
			// per service. With frames absent, the normalized message must
			// differentiate occurrences regardless of whether a type was set.
			const result = computeFingerprintInputs({
				exceptionType: "TimeoutError",
				exceptionStacktrace: "",
				statusMessage: "db timeout 12345",
			})

			expect(result.msgSignature).toBe("db timeout #")
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

			expect(a.msgSignature).not.toBe(b.msgSignature)
			expect(a.msgSignature).toContain("/robots.txt")
			expect(b.msgSignature).toContain("/.env")
		})

		it("splits a malformed-ExceptionType bucket (JSON-prefix leak) by message", () => {
			// Regression guard: if upstream instrumentation ever leaks a truncated
			// JSON prefix like `{ "type"` into exception.type, distinct underlying
			// errors must still produce distinct signatures.
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

			expect(a.msgSignature).not.toBe(b.msgSignature)
		})

		it("computes the signature even when frames are present", () => {
			// The signature is folded in ALWAYS. A bundled runtime minifies every
			// module into one file, so two different bugs in the same Worker share
			// their top three frames; without the signature they collapse into one
			// issue (25 distinct DatabaseError bugs did exactly that in production).
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "    at f (/a.ts:10:5)",
				statusMessage: "status only 123",
			})

			expect(result.msgSignature).toBe("status only #")
		})

		it("separates two bugs that share identical minified frames", () => {
			const frames = "    at toDatabaseError (worker.js:1542:13655)\n    at worker.js:14:7233"
			const a = computeFingerprintInputs({
				exceptionType: "DatabaseError",
				exceptionStacktrace: frames,
				statusMessage: 'Failed query: insert into "planetscale_events"',
			})
			const b = computeFingerprintInputs({
				exceptionType: "DatabaseError",
				exceptionStacktrace: frames,
				statusMessage: 'Failed query: insert into "anomaly_detector_states"',
			})

			expect(a.fpFrames).toBe(b.fpFrames)
			expect(a.msgSignature).not.toBe(b.msgSignature)
		})

		it("truncates long StatusMessage to 120 characters after redaction", () => {
			const long = "x".repeat(500)
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: long,
			})

			expect(result.msgSignature.length).toBeLessThanOrEqual(120)
		})

		it("keeps the route but drops the origin, so preview hosts share one issue", () => {
			const a = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace: "",
				statusMessage: "Transport error (POST https://app.maple.dev/api/query-engine/overview)",
			})
			const b = computeFingerprintInputs({
				exceptionType: "HttpClientError",
				exceptionStacktrace: "",
				statusMessage:
					"Transport error (POST https://app-pr-246.maple.dev/api/query-engine/overview)",
			})

			expect(a.msgSignature).toBe(b.msgSignature)
			expect(a.msgSignature).toContain("/api/query-engine/overview")
		})

		it("collapses per-user home directories but keeps the rest of the path", () => {
			const a = computeFingerprintInputs({
				exceptionType: "IngestRejected",
				exceptionStacktrace: "",
				statusMessage: "Cannot open file /Users/riordan/.maple/data/store: No space left on device",
			})
			const b = computeFingerprintInputs({
				exceptionType: "IngestRejected",
				exceptionStacktrace: "",
				statusMessage:
					"Cannot open file /Users/juanbermudez/.maple/data/store: No space left on device",
			})

			expect(a.msgSignature).toBe(b.msgSignature)
			expect(a.msgSignature).toContain("/.maple/data/store")
		})

		it("redacts an email address out of the signature", () => {
			// Drizzle's `params:` line put customer emails into the fingerprint and
			// into error_issues.top_frame. Frame shape matching keeps that line out
			// of the hash; this keeps an address out of the signature too.
			const result = computeFingerprintInputs({
				exceptionType: "",
				exceptionStacktrace: "",
				statusMessage: "insert failed for david@superwall.com",
			})

			expect(result.msgSignature).not.toContain("@superwall.com")
			expect(result.msgSignature).toBe("insert failed for EMAIL")
		})
	})

	describe("JSON-object signature (key-name-agnostic)", () => {
		const sig = (statusMessage: string) =>
			computeFingerprintInputs({ exceptionType: "", exceptionStacktrace: "", statusMessage })
				.msgSignature

		it("builds a sorted key=value signature over all top-level keys", () => {
			expect(
				sig(
					'{"type":"https://e/rate-limit","title":"Rate limited","detail":"retry in 5s","status":429}',
				),
			).toBe('detail="retry in #s"|status=#|title="Rate limited"|type="https://e/rate-limit"')
		})

		it("is insensitive to key order", () => {
			expect(sig('{"title":"X","code":"E1"}')).toBe(sig('{"code":"E1","title":"X"}'))
		})

		it("is robust to volatile numeric/hex ids in values", () => {
			expect(sig('{"detail":"retry user 12345 in 5s"}')).toBe(sig('{"detail":"retry user 99 in 5s"}'))
			expect(sig('{"id":"a1b2c3d4e5f6"}')).toBe(sig('{"id":"ffffffffffff"}'))
		})

		it("splits on differing static field wording (intended)", () => {
			expect(sig('{"detail":"disk full"}')).not.toBe(sig('{"detail":"out of memory"}'))
		})

		it("forms a signature from whatever keys exist (no common key required)", () => {
			expect(sig('{"foo":"bar"}')).toBe('foo="bar"')
		})

		it("falls back to plain redaction for arrays (not an object)", () => {
			expect(sig("[1,2,3]")).toBe("[#,#,#]")
		})

		it("uses the JSON signature even when frames are present", () => {
			expect(
				computeFingerprintInputs({
					exceptionType: "",
					exceptionStacktrace: "    at f (/a.ts:10:5)",
					statusMessage: '{"title":"Rate limited"}',
				}).msgSignature,
			).toBe('title="Rate limited"')
		})
	})

	describe("value-aware label", () => {
		const label = (statusMessage: string, exceptionType = "") =>
			computeFingerprintInputs({ exceptionType, exceptionStacktrace: "", statusMessage }).label

		it("prefers the exception type when present", () => {
			expect(label('{"title":"Rate limited"}', "TimeoutError")).toBe("TimeoutError")
		})

		it("reads problem+json title", () => {
			expect(label('{"type":"https://e/rate-limit","title":"Rate limited"}')).toBe("Rate limited")
		})

		it("falls back to _tag, then last path-segment of type, then 'JSON error'", () => {
			expect(label('{"_tag":"NetworkError"}')).toBe("NetworkError")
			expect(label('{"type":"https://api/errors/not_found"}')).toBe("not_found")
			expect(label('{"foo":"bar"}')).toBe("JSON error")
			expect(label("[1,2,3]")).toBe("JSON error")
		})

		it("labels Effect ParseError by first field", () => {
			expect(label("{ readonly userId: string }")).toBe("Schema parse error: userId")
			expect(label("Expected string\n└─ at index 0")).toBe("Schema parse error")
		})

		it("cuts legacy messages at the first delimiter (in order)", () => {
			expect(label("TypeError: undefined is not a function")).toBe("TypeError")
			expect(label("RouteNotFound (GET /robots.txt)")).toBe("RouteNotFound")
			expect(label("")).toBe("Unknown Error")
		})
	})
})

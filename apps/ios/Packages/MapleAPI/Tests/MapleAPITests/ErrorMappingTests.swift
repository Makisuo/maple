import Foundation
import Testing

@testable import MapleAPI

/// The mapping from a wire error to a recovery action is what decides whether a
/// failure sends the user back to sign-in, back to the org picker, or just
/// shows a message. Getting it wrong is silent, so it is tested directly.
@Suite("Error mapping")
struct ErrorMappingTests {
	private func envelope(
		tag: String,
		type: String,
		code: String,
		title: String = "Something went wrong",
		message: String,
		retryable: Bool = false,
		recovery: String,
		extra: String = ""
	) -> Data {
		Data(
			"""
			{"error":{"_tag":"\(tag)","type":"\(type)","code":"\(code)","title":"\(title)",
			"message":"\(message)","retryable":\(retryable),"recovery":"\(recovery)"\(extra)}}
			""".utf8
		)
	}

	@Test("401 invalid_credentials asks for re-authentication")
	func invalidCredentials() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 401,
			data: envelope(
				tag: "@maple/http/v2/InvalidCredentialsError",
				type: "authentication_error",
				code: "invalid_credentials",
				title: "Sign in required",
				message: "The session token is missing or invalid.",
				recovery: "reauthenticate"
			)
		)

		#expect(error.requiresReauthentication)
		#expect(!error.requiresOrganization)
		#expect(error.body?.code == "invalid_credentials")
		#expect(error.title == "Sign in required")
	}

	/// v2 resolves the org from the token's claim, so this must land on the org
	/// picker rather than signing the user out — they are still authenticated.
	@Test("401 without an active organization asks for an organization, not a sign-out")
	func missingOrganization() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 401,
			data: envelope(
				tag: "@maple/http/v2/UnauthorizedError",
				type: "authentication_error",
				code: "unauthorized",
				message: "Active organization is required",
				recovery: "reauthenticate"
			)
		)

		#expect(error.requiresOrganization)
	}

	@Test("429 carries the server's retry delay")
	func rateLimited() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 429,
			data: envelope(
				tag: "@maple/http/v2/RateLimitError",
				type: "rate_limit_error",
				code: "rate_limited",
				message: "Too many requests.",
				retryable: true,
				recovery: "retry",
				extra: ",\"retry_after_seconds\":30"
			)
		)

		#expect(error.isRetryable)
		#expect(error.retryAfter == 30)
		#expect(error.recovery == .retry)
	}

	@Test("400 surfaces the offending parameter")
	func parameterInvalid() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 400,
			data: envelope(
				tag: "@maple/http/v2/ParameterInvalidError",
				type: "invalid_request_error",
				code: "parameter_invalid",
				message: "end_time must be after start_time.",
				recovery: "fix_request",
				extra: ",\"param\":\"end_time\""
			)
		)

		#expect(error.body?.param == "end_time")
		#expect(error.recovery == .fixRequest)
	}

	/// A proxy 502 returns HTML, not an envelope. It must degrade to a readable
	/// error rather than crashing or being reported as a decoding bug.
	@Test("A non-envelope error body degrades instead of crashing")
	func unexpectedBody() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 502,
			data: Data("<html><body>Bad gateway</body></html>".utf8)
		)

		guard case .unexpectedStatus(let status, let body) = error else {
			Issue.record("expected .unexpectedStatus, got \(error)")
			return
		}
		#expect(status == 502)
		#expect(body?.contains("Bad gateway") == true)
		#expect(!error.requiresReauthentication)
		#expect(!error.isRetryable)
	}

	@Test("An empty error body still yields the status")
	func emptyBody() throws {
		let error = ErrorMappingMiddleware.mapError(status: 504, data: nil)
		guard case .unexpectedStatus(let status, let body) = error else {
			Issue.record("expected .unexpectedStatus, got \(error)")
			return
		}
		#expect(status == 504)
		#expect(body == nil)
	}

	/// A tag this build has never heard of must still decode: the server adds
	/// error tags without a client release.
	@Test("An unknown error tag still decodes")
	func unknownTag() throws {
		let error = ErrorMappingMiddleware.mapError(
			status: 409,
			data: envelope(
				tag: "@maple/http/v2/SomeFutureError",
				type: "conflict_error",
				code: "some_future_code",
				message: "A thing this build predates.",
				recovery: "contact_support"
			)
		)

		#expect(error.body?.code == "some_future_code")
		#expect(error.recovery == .contactSupport)
	}
}

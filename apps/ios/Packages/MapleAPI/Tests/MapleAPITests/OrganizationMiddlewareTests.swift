import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

/// Captures the request a middleware chain produced, and answers with an empty
/// 200 so the chain completes.
private final class RecordingTransport: ClientTransport, @unchecked Sendable {
	private(set) var lastRequest: HTTPRequest?

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		lastRequest = request
		return (HTTPResponse(status: .ok), nil)
	}
}

private actor CountingTokens: MapleTokenProvider {
	private(set) var forcedRefreshes = 0

	func token(forceRefresh: Bool) async throws -> String? {
		if forceRefresh { forcedRefreshes += 1 }
		return "test-token"
	}

	func forcedRefreshCount() -> Int { forcedRefreshes }
}

@Suite("Organization scoping")
struct OrganizationMiddlewareTests {
	private func send(through middlewares: [any ClientMiddleware], transport: RecordingTransport) async throws {
		var next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?) = {
			try await transport.send($0, body: $1, baseURL: $2, operationID: "test")
		}
		for middleware in middlewares.reversed() {
			let inner = next
			next = { @Sendable request, body, baseURL in
				try await middleware.intercept(
					request,
					body: body,
					baseURL: baseURL,
					operationID: "test",
					next: inner
				)
			}
		}
		_ = try await next(
			HTTPRequest(method: .get, scheme: "https", authority: "api.maple.test", path: "/v2/services"),
			nil,
			URL(string: "https://api.maple.test")!
		)
	}

	@Test("A scoped client names the organization; an unscoped one does not")
	func headerPresenceFollowsScope() async throws {
		let tokens = CountingTokens()

		let scoped = RecordingTransport()
		try await send(
			through: [
				BearerAuthMiddleware(tokens: tokens),
				OrganizationMiddleware(organizationId: "org_2abc"),
			],
			transport: scoped
		)
		#expect(scoped.lastRequest?.headerFields[OrganizationMiddleware.headerName] == "org_2abc")
		#expect(scoped.lastRequest?.headerFields[.authorization] == "Bearer test-token")

		let unscoped = RecordingTransport()
		try await send(through: [BearerAuthMiddleware(tokens: tokens)], transport: unscoped)
		// Absent, not empty: the app's own requests must keep resolving the
		// organization from the token's claim.
		#expect(unscoped.lastRequest?.headerFields[OrganizationMiddleware.headerName] == nil)
	}

	/// A background fetch for one organization must not invalidate the token the
	/// foreground is using for another.
	@Test("Scoped requests never force a token refresh")
	func scopedRequestsDoNotRefreshTheToken() async throws {
		let tokens = CountingTokens()
		let transport = RecordingTransport()

		try await send(
			through: [
				BearerAuthMiddleware(tokens: tokens),
				OrganizationMiddleware(organizationId: "org_2abc"),
			],
			transport: transport
		)

		#expect(await tokens.forcedRefreshCount() == 0)
	}

	/// The header name is a wire contract with `packages/auth`.
	@Test("The header name matches the server's")
	func headerNameIsPinned() {
		#expect(OrganizationMiddleware.headerName.canonicalName == "x-maple-org-id")
	}
}

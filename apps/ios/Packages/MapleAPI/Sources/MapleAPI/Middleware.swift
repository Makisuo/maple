import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Supplies the bearer token for a request.
///
/// A protocol rather than a direct Clerk call so the whole networking layer
/// builds and tests without the Clerk SDK, a simulator, or a signed-in user.
public protocol MapleTokenProvider: Sendable {
	/// The current session JWT, or nil when there is no session.
	///
	/// - Parameter forceRefresh: bypass any cache. Set after switching
	///   organizations, where the cached token still carries the old org claim.
	func token(forceRefresh: Bool) async throws -> String?
}

extension MapleTokenProvider {
	public func token() async throws -> String? {
		try await token(forceRefresh: false)
	}
}

/// Attaches `Authorization: Bearer <clerk session jwt>` to every request.
///
/// The token carries the organization: v2 reads the active-organization claim,
/// so switching organizations means re-minting the token rather than changing a
/// header. `OrganizationMiddleware` is the one exception, and it is deliberately
/// not applied to the app's own client — see `MapleAPI.scoped(to:)`.
public struct BearerAuthMiddleware: ClientMiddleware {
	private let tokens: any MapleTokenProvider

	public init(tokens: any MapleTokenProvider) {
		self.tokens = tokens
	}

	public func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		guard let token = try await tokens.token() else {
			throw MapleAPIError.notAuthenticated
		}
		var request = request
		request.headerFields[.authorization] = "Bearer \(token)"
		return try await next(request, body, baseURL)
	}
}

/// Names the organization explicitly, for the one caller that cannot use the
/// token's own claim.
///
/// That caller is the widget publisher, fetching for an organization the user
/// belongs to but has not made active. `Clerk.setActive` is global session
/// state the foreground is using, so the only way to read another organization
/// without disturbing the user is to name it per request. The server verifies
/// the name against the caller's memberships (`packages/auth`,
/// `ORG_SELECTION_HEADER`), so this header can never widen what the token
/// already authorizes — and an organization it cannot verify is a 403, never a
/// silent fallback to the active one.
public struct OrganizationMiddleware: ClientMiddleware {
	/// Must match `ORG_SELECTION_HEADER` in `packages/auth/src/index.ts`.
	public static let headerName = HTTPField.Name("x-maple-org-id")!

	private let organizationId: String

	public init(organizationId: String) {
		self.organizationId = organizationId
	}

	public func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		var request = request
		request.headerFields[Self.headerName] = organizationId
		return try await next(request, body, baseURL)
	}
}

/// Turns every non-2xx response into a typed `MapleAPIError` before the
/// generated code sees it.
///
/// Doing this here rather than per-operation is what keeps the client small:
/// each generated `Output` enum has a case per documented status, so handling
/// errors at the call site would mean five near-identical seven-case switches.
/// Intercepting once means every call site can use the `.ok` path and catch one
/// error type.
public struct ErrorMappingMiddleware: ClientMiddleware {
	/// Error bodies are a few hundred bytes; the cap only bounds a pathological
	/// response (an HTML error page from a proxy).
	private static let maxErrorBodyBytes = 64 * 1024

	public init() {}

	public func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		let (response, responseBody) = try await next(request, body, baseURL)

		let status = response.status.code
		guard status < 200 || status >= 300 else {
			return (response, responseBody)
		}

		let data = try await collect(responseBody)
		throw Self.mapError(status: status, data: data)
	}

	/// Exposed for tests: the status/body pair is the whole input to the mapping.
	public static func mapError(status: Int, data: Data?) -> MapleAPIError {
		guard let data, !data.isEmpty else {
			return .unexpectedStatus(status: status, body: nil)
		}
		if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
			return .api(status: status, error: envelope.error)
		}
		return .unexpectedStatus(status: status, body: String(data: data, encoding: .utf8))
	}

	private func collect(_ body: HTTPBody?) async throws -> Data? {
		guard let body else { return nil }
		do {
			return try await Data(collecting: body, upTo: Self.maxErrorBodyBytes)
		} catch {
			// A body we can't read still has a usable status code.
			return nil
		}
	}

	private struct ErrorEnvelope: Decodable {
		let error: MapleAPIErrorBody
	}
}

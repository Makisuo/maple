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
/// Note there is deliberately **no org header**: v2 resolves the organization
/// from the token's own active-organization claim, so switching orgs means
/// re-minting the token, not changing a header. Adding one here would do
/// nothing.
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

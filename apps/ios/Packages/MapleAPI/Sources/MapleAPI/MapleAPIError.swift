import Foundation

/// Every failure the Maple v2 API can hand back, plus the transport failures
/// around it.
///
/// The API models errors as one envelope keyed on a stable `_tag`; the pruned
/// spec collapses all of them to `MapleErrorEnvelope` so the client branches on
/// strings rather than on thirty generated enum cases.
public enum MapleAPIError: Error, Sendable {
	/// No Clerk session, so no bearer token could be minted.
	case notAuthenticated
	/// The API returned a structured error envelope.
	case api(status: Int, error: MapleAPIErrorBody)
	/// A non-2xx response whose body was not a Maple error envelope — a
	/// gateway 502, an HTML error page, a truncated body.
	case unexpectedStatus(status: Int, body: String?)
	/// URLSession, TLS, offline, cancellation.
	case transport(any Error)
	/// A 2xx response whose body did not match the schema.
	case decoding(any Error)
}

/// The `error` object inside a Maple error envelope.
///
/// Mirrors `packages/domain/src/http/v2/public-error.ts`. `tag` and `code` are
/// deliberately `String` rather than enums: the server documents them as stable
/// integration keys, and a new tag must not break decoding on an old build.
public struct MapleAPIErrorBody: Codable, Hashable, Sendable {
	public let tag: String
	public let type: String
	public let code: String
	public let title: String
	public let message: String
	public let retryable: Bool
	public let recovery: String
	public let retryAfterSeconds: Double?
	public let retryAt: String?
	public let param: String?

	private enum CodingKeys: String, CodingKey {
		case tag = "_tag"
		case type, code, title, message, retryable, recovery, param
		case retryAfterSeconds = "retry_after_seconds"
		case retryAt = "retry_at"
	}
}

/// The subset of the server's `recovery` vocabulary the app acts on.
///
/// Everything else renders as a plain error state, which is why this is a
/// lookup over the raw string rather than an exhaustive enum — an unrecognised
/// recovery must degrade, not crash.
public enum MapleRecovery: String, Sendable {
	case reauthenticate
	case retry
	case refresh
	case fixRequest = "fix_request"
	case requestAccess = "request_access"
	case reconnect
	case contactSupport = "contact_support"
	case none
}

extension MapleAPIError {
	public var body: MapleAPIErrorBody? {
		if case .api(_, let error) = self { return error }
		return nil
	}

	public var recovery: MapleRecovery? {
		body.flatMap { MapleRecovery(rawValue: $0.recovery) }
	}

	/// The credentials are stale or gone — re-run the Clerk sign-in flow.
	public var requiresReauthentication: Bool {
		recovery == .reauthenticate
	}

	/// The token authenticated but carries no active organization.
	///
	/// v2 resolves the org from the Clerk token's active-organization claim and
	/// has no org header, so this is an org-picker prompt rather than a
	/// sign-out. See `packages/auth/src/index.ts`.
	public var requiresOrganization: Bool {
		guard let body else { return false }
		return body.message.localizedCaseInsensitiveContains("active organization is required")
	}

	/// True when the underlying failure is a cancelled Task, however deeply the
	/// transport wrapped it. `MapleClient` normalizes these to a plain
	/// `CancellationError` before they escape, so this is a defensive check for
	/// callers that receive one anyway.
	public var isCancellation: Bool {
		MapleClient.isCancellation(self)
	}

	public var isRetryable: Bool {
		switch self {
		case .api(_, let error): error.retryable
		case .transport: true
		case .notAuthenticated, .unexpectedStatus, .decoding: false
		}
	}

	/// How long the server asked us to wait, when it said so.
	public var retryAfter: TimeInterval? {
		body?.retryAfterSeconds
	}

	/// Short, safe to show in UI.
	public var title: String {
		switch self {
		case .notAuthenticated: "Signed out"
		case .api(_, let error): error.title
		case .unexpectedStatus: "Something went wrong"
		case .transport: "Can't reach Maple"
		case .decoding: "Unexpected response"
		}
	}

	/// Longer, safe to show in UI.
	public var message: String {
		switch self {
		case .notAuthenticated:
			"Sign in again to continue."
		case .api(_, let error):
			error.message
		case .unexpectedStatus(let status, _):
			"The server returned an unexpected \(status) response."
		case .transport:
			"Check your connection and try again."
		case .decoding:
			"Maple returned data this version of the app can't read."
		}
	}
}

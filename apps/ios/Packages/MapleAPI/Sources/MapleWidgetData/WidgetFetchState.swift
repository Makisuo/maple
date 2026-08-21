import Foundation

/// What happened the last time a widget tried to fetch for itself.
///
/// The extension links no telemetry — it carries `MapleWidgetData` and nothing
/// else — so a fetch that fails there fails completely silently. That is the
/// exact failure mode this whole project exists to fix, so the extension writes
/// its outcome into the App Group and the app drains it into a span on the next
/// foreground. Without it, "did the widget actually refresh?" has no answer.
///
/// It is also load-bearing, not just diagnostic: `consecutiveFailures` drives
/// how far out the next timeline is asked for, and `credentialRejectedAt` stops
/// a rolled credential from spending the whole refresh budget on 401s.
public struct WidgetFetchState: Codable, Sendable, Equatable {
	public var lastAttemptAt: Date?
	public var lastSuccessAt: Date?
	public var lastOutcome: Outcome?
	public var consecutiveFailures: Int
	/// When the server last said this credential is not valid.
	///
	/// Terminal, deliberately: a rolled or revoked credential answers 401
	/// forever, and retrying on every rebuild would burn the entire refresh
	/// budget on failures. Cleared by the app when it mints a new one.
	public var credentialRejectedAt: Date?
	/// When an attempt started that has not reported an outcome yet.
	///
	/// A dedicated field rather than "there is an attempt but no outcome": after
	/// the very first completed fetch `lastOutcome` is never nil again, so
	/// inferring in-flight from it would silently stop working the moment it
	/// first worked — and the whole point of this is to keep the app and the
	/// extension from fetching the same thing at the same time, which is a
	/// steady-state concern, not a first-run one.
	public var inFlightSince: Date?

	public enum Outcome: String, Codable, Sendable {
		case success
		/// The credential was rejected. Only the app can fix this.
		case unauthorized
		/// No network, or the request outlived the provider's deadline. Retry soon.
		case unreachable
		/// The server answered, unhappily. Retry, but back off.
		case server
		/// A 200 this build could not read — including a payload from a newer
		/// server whose fields may have changed meaning.
		case undecodable
	}

	public init(
		lastAttemptAt: Date? = nil,
		lastSuccessAt: Date? = nil,
		lastOutcome: Outcome? = nil,
		consecutiveFailures: Int = 0,
		credentialRejectedAt: Date? = nil,
		inFlightSince: Date? = nil
	) {
		self.lastAttemptAt = lastAttemptAt
		self.lastSuccessAt = lastSuccessAt
		self.lastOutcome = lastOutcome
		self.consecutiveFailures = consecutiveFailures
		self.credentialRejectedAt = credentialRejectedAt
		self.inFlightSince = inFlightSince
	}

	/// Fetching is pointless until the app mints again.
	public var isCredentialRejected: Bool { credentialRejectedAt != nil }

	public func recording(_ outcome: Outcome, at date: Date) -> WidgetFetchState {
		var next = self
		next.lastAttemptAt = date
		next.lastOutcome = outcome
		next.inFlightSince = nil
		switch outcome {
		case .success:
			next.lastSuccessAt = date
			next.consecutiveFailures = 0
			next.credentialRejectedAt = nil
		case .unauthorized:
			next.consecutiveFailures += 1
			next.credentialRejectedAt = date
		case .unreachable, .server, .undecodable:
			next.consecutiveFailures += 1
		}
		return next
	}

	/// Stamped **before** the request goes out, so two providers woken for the
	/// same organization in the same second do not both fetch. See
	/// `WidgetSummaryFetcher` for the other half of that.
	public func attempting(at date: Date) -> WidgetFetchState {
		var next = self
		next.lastAttemptAt = date
		next.inFlightSince = date
		return next
	}

	/// Someone else is already fetching this, recently enough to wait for.
	///
	/// Bounded rather than open-ended: a process killed mid-fetch never clears
	/// `inFlightSince`, and a lock nothing can release would stop the widget
	/// refreshing until the next sign-out.
	public func isInFlight(at date: Date, within window: TimeInterval) -> Bool {
		guard let inFlightSince else { return false }
		return date.timeIntervalSince(inFlightSince) < window
	}
}

/// The fetch state, shared across the process boundary.
///
/// `UserDefaults` rather than a file, unlike the credential: there is nothing
/// secret here, it is written on every timeline build, and the suite gives
/// atomic-enough semantics for a record whose worst-case corruption is one
/// wasted request.
public struct WidgetFetchStateStore: Sendable {
	private let appGroupIdentifier: String

	public init(appGroupIdentifier: String = WidgetAppGroup.identifier) {
		self.appGroupIdentifier = appGroupIdentifier
	}

	private var defaults: UserDefaults? { UserDefaults(suiteName: appGroupIdentifier) }
	private func key(_ organizationId: String) -> String { "widget.fetch.v1.\(organizationId)" }

	public func load(organizationId: String) -> WidgetFetchState {
		guard
			let data = defaults?.data(forKey: key(organizationId)),
			let state = try? Self.decoder.decode(WidgetFetchState.self, from: data)
		else { return WidgetFetchState() }
		return state
	}

	public func save(_ state: WidgetFetchState, organizationId: String) {
		guard let defaults, let data = try? Self.encoder.encode(state) else { return }
		defaults.set(data, forKey: key(organizationId))
	}

	public func clear(organizationId: String) {
		defaults?.removeObject(forKey: key(organizationId))
	}

	/// The app, having minted a fresh credential, telling the widget to stop
	/// treating 401 as terminal.
	public func clearCredentialRejection(organizationId: String) {
		var state = load(organizationId: organizationId)
		guard state.isCredentialRejected else { return }
		state.credentialRejectedAt = nil
		state.consecutiveFailures = 0
		save(state, organizationId: organizationId)
	}

	private static var encoder: JSONEncoder {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		return encoder
	}

	private static var decoder: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}
}

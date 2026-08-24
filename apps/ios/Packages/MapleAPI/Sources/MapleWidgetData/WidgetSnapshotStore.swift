import Foundation

/// The App Group both targets are members of — the only channel between the
/// app and the widget extension.
///
/// Must match `com.apple.security.application-groups` in **both** entitlements
/// files. A typo here is silent: `UserDefaults(suiteName:)` hands back a
/// usable-looking store that the other process cannot see, so the widgets just
/// render "Open Maple" forever.
public enum WidgetAppGroup {
	public static let identifier = "group.com.maple.mobile"
}

/// One snapshot, shared across the process boundary as JSON in the App Group.
///
/// `UserDefaults(suiteName:)` rather than files in the container: the payloads
/// are a couple of kilobytes, the widgets read them on every timeline build,
/// and suite defaults need no file coordination between two processes that can
/// be woken independently.
///
/// Generic over the payload because there are two of them — ongoing issues and
/// throughput — and the storage rules (ISO dates, drop what will not decode,
/// clear on sign-out) must not drift apart between them.
public struct WidgetSnapshotStore<Value: Codable & Sendable>: Sendable {
	/// The suite name, not a resolved `UserDefaults`: the class is thread-safe
	/// but not `Sendable`, and these stores are read on the widget's timeline
	/// actor and written on the app's main actor. Resolving per call costs a
	/// dictionary lookup — `UserDefaults(suiteName:)` hands back the same
	/// shared instance every time.
	private let appGroupIdentifier: String
	private let key: String

	/// - Parameter appGroupIdentifier: overridden only by tests, which use a
	///   throwaway suite so they never touch the real one.
	public init(key: String, appGroupIdentifier: String = WidgetAppGroup.identifier) {
		self.key = key
		self.appGroupIdentifier = appGroupIdentifier
	}

	private var defaults: UserDefaults? { UserDefaults(suiteName: appGroupIdentifier) }

	/// Nil when the app has never written one — a fresh install, or a widget
	/// added before signing in. The widgets treat that as "open the app",
	/// which is a different statement from "you have no issues".
	public func load() -> Value? {
		guard let data = defaults?.data(forKey: key) else { return nil }
		// A snapshot written by a newer build with fields this one cannot
		// decode is dropped rather than crashing the extension.
		return try? Self.decoder.decode(Value.self, from: data)
	}

	@discardableResult
	public func save(_ snapshot: Value) -> Bool {
		guard let defaults, let data = try? Self.encoder.encode(snapshot) else { return false }
		defaults.set(data, forKey: key)
		return true
	}

	/// Sign-out. The Home Screen outlives the session, and one account's
	/// failures must not stay readable to whoever holds the phone next.
	public func clear() {
		defaults?.removeObject(forKey: key)
	}

	// ISO-8601 rather than the default seconds-since-reference-date: these are
	// read by a different process, possibly built from a different commit, and
	// a dated string survives inspection by eye.
	private static var encoder: JSONEncoder { WidgetJSON.encoder }
	/// Tolerant of fractional seconds — see `WidgetJSON`.
	private static var decoder: JSONDecoder { WidgetJSON.decoder }
}

// Keys are per organization *and* environment, because a widget can be pinned
// to either. One slot per organization was enough only while every widget
// showed the whole organization: two widgets on the same organization, one
// filtered to production and one to staging, would otherwise overwrite each
// other on every publish — and each would render the other's numbers under its
// own label, which looks exactly like working software.
//
// The unfiltered key is left as it was rather than versioned up. "All
// environments" is precisely what the existing key already means, so widgets
// placed before the environment picker keep reading the snapshot they always
// read, with no migration and no fallback to delete later.
//
// The `v1` keys below are read-only leftovers from before per-organization
// snapshots: a widget placed before that shipped would otherwise render "Open
// Maple" until the next publish. Delete them, and their readers, one release on.

/// The key segment identifying one environment, or nothing at all for the
/// whole organization. Shared so the two surfaces cannot disagree about which
/// slot a snapshot belongs in.
private func environmentKeySuffix(_ environment: String?) -> String {
	guard let environment, !environment.isEmpty else { return "" }
	return ".env.\(environment)"
}

extension WidgetSnapshotStore where Value == IssuesSnapshot {
	public static func issues(
		organizationId: String,
		environment: String? = nil,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> WidgetSnapshotStore<IssuesSnapshot> {
		.init(
			key: "issues.snapshot.v2.\(organizationId)\(environmentKeySuffix(environment))",
			appGroupIdentifier: appGroupIdentifier
		)
	}

	/// Read-only fallback for widgets placed before per-organization snapshots.
	/// Delete one release after that shipped, along with its readers.
	public static var legacyIssues: WidgetSnapshotStore<IssuesSnapshot> { .init(key: "issues.snapshot.v1") }
}

extension WidgetSnapshotStore where Value == ThroughputSnapshot {
	public static func throughput(
		organizationId: String,
		environment: String? = nil,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> WidgetSnapshotStore<ThroughputSnapshot> {
		.init(
			key: "throughput.snapshot.v2.\(organizationId)\(environmentKeySuffix(environment))",
			appGroupIdentifier: appGroupIdentifier
		)
	}

	/// Read-only fallback for widgets placed before per-organization snapshots.
	/// Delete one release after that shipped, along with its readers.
	public static var legacyThroughput: WidgetSnapshotStore<ThroughputSnapshot> {
		.init(key: "throughput.snapshot.v1")
	}
}

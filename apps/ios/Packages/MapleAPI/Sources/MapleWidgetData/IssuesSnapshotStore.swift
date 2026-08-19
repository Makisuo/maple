import Foundation

/// The one place the app and the widget agree on: a JSON snapshot in the App
/// Group both targets are members of.
///
/// `UserDefaults(suiteName:)` rather than a file in the container: the payload
/// is a couple of kilobytes, the widget reads it on every timeline build, and
/// suite defaults need no file coordination between two processes that can be
/// woken independently.
public struct IssuesSnapshotStore: Sendable {
	/// Must match `com.apple.security.application-groups` in **both**
	/// entitlements files. A typo here is silent: `UserDefaults(suiteName:)`
	/// returns a usable-looking store that the other process cannot see, so
	/// the widget just renders "Open Maple" forever.
	public static let appGroupIdentifier = "group.com.maple.mobile"

	private static let key = "issues.snapshot.v1"

	/// The suite name, not a resolved `UserDefaults`: the class is thread-safe
	/// but not `Sendable`, and this type is read on the widget's timeline
	/// actor and written on the app's main actor. Resolving per call costs a
	/// dictionary lookup — `UserDefaults(suiteName:)` hands back the same
	/// shared instance every time.
	private let appGroupIdentifier: String

	/// - Parameter appGroupIdentifier: overridden only by tests, which use a
	///   throwaway suite so they never touch the real one.
	public init(appGroupIdentifier: String = IssuesSnapshotStore.appGroupIdentifier) {
		self.appGroupIdentifier = appGroupIdentifier
	}

	private var defaults: UserDefaults? { UserDefaults(suiteName: appGroupIdentifier) }

	public static let shared = IssuesSnapshotStore()

	/// Nil when the app has never written one — a fresh install, or a user who
	/// added the widget before signing in. The widget treats that as "open the
	/// app", which is different from "you have no issues".
	public func load() -> IssuesSnapshot? {
		guard let data = defaults?.data(forKey: Self.key) else { return nil }
		// A snapshot written by a newer build with fields this one cannot
		// decode is dropped rather than crashing the extension.
		return try? Self.decoder.decode(IssuesSnapshot.self, from: data)
	}

	@discardableResult
	public func save(_ snapshot: IssuesSnapshot) -> Bool {
		guard let defaults, let data = try? Self.encoder.encode(snapshot) else { return false }
		defaults.set(data, forKey: Self.key)
		return true
	}

	/// Sign-out. The widget must not keep showing one account's failures to
	/// whoever holds the phone next.
	public func clear() {
		defaults?.removeObject(forKey: Self.key)
	}

	// ISO-8601 rather than the default `Double` since-reference-date: the
	// snapshot is read by a different process, possibly built from a different
	// commit, and a dated string survives that inspection-by-eye.
	private static let encoder: JSONEncoder = {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		return encoder
	}()

	private static let decoder: JSONDecoder = {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}()
}

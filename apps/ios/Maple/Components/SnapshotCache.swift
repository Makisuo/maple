import Foundation

/// Last-known-good screen snapshots, on disk.
///
/// A cold launch used to blank every screen behind a skeleton for the full
/// API fan-out — a median of 2.5s on Home. Seeding the previous board and
/// revalidating turns that into an instant paint plus a background refresh,
/// which is the single biggest lever on how fast the app *feels*.
///
/// Keys are (screen, organization, environment): a cached board must never
/// leak across the two scoping axes, for the same reason `dataGeneration`
/// exists. `clear()` removes everything and is called on sign-out — the
/// previous account's incidents must not be readable from the next one.
enum SnapshotCache {
	/// Bump when a cached shape changes meaning in a way `Decodable` cannot
	/// catch — old files then read as "no cache" instead of as wrong data.
	private static let formatVersion = 1

	private struct Envelope<Value: Codable>: Codable {
		let savedAt: Date
		let value: Value
	}

	static func load<Value: Codable>(
		_ type: Value.Type,
		screen: String,
		organizationId: String,
		environment: String?,
		maxAge: TimeInterval = 24 * 60 * 60
	) -> Value? {
		guard let url = fileURL(screen: screen, organizationId: organizationId, environment: environment),
			let data = try? Data(contentsOf: url),
			let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: data)
		else { return nil }
		// A board from last week is more confusing than a skeleton — the
		// refresh that follows a seed can take seconds, and until it lands the
		// stale numbers read as current.
		guard Date().timeIntervalSince(envelope.savedAt) <= maxAge else { return nil }
		return envelope.value
	}

	static func save<Value: Codable>(
		_ value: Value,
		screen: String,
		organizationId: String,
		environment: String?
	) {
		guard let url = fileURL(screen: screen, organizationId: organizationId, environment: environment),
			let data = try? JSONEncoder().encode(Envelope(savedAt: Date(), value: value))
		else { return }
		try? data.write(to: url, options: .atomic)
	}

	/// Sign-out: nothing cached may survive the account it belongs to.
	static func clear() {
		guard let directory else { return }
		try? FileManager.default.removeItem(at: directory)
	}

	private static var directory: URL? {
		guard
			let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
		else { return nil }
		return base.appendingPathComponent("ScreenSnapshots", isDirectory: true)
	}

	private static func fileURL(screen: String, organizationId: String, environment: String?) -> URL? {
		guard let directory else { return nil }
		try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		// The environment is user-supplied text, so the key is encoded rather
		// than spliced into a filename.
		let key = [screen, organizationId, environment ?? ""].joined(separator: "|")
		let name = Data(key.utf8).base64EncodedString()
			.replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "+", with: "-")
		return directory.appendingPathComponent("\(name)-v\(formatVersion).json")
	}
}

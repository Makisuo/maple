import Foundation

/// The credential a device's Home Screen widgets fetch with.
///
/// Read-only, expiring, and fenced by the server to `/v2/widget_summary` alone.
/// Minted by the app — the only process that holds a Clerk session — and read
/// by the widget extension, which holds none: session tokens live one minute,
/// and two processes refreshing the same rotating refresh token is a way to
/// sign the user out.
public struct WidgetCredential: Codable, Sendable, Equatable {
	/// The organization the credential is bound to. An API key cannot select a
	/// different one, so this is also the key's identity — one per organization
	/// the user has actually pinned a widget to.
	public var organizationId: String
	public var secret: String
	/// The host that issued it.
	///
	/// Stored with the credential rather than read from the extension's own
	/// Info.plist, because the two can never be right separately: a credential
	/// minted against a local API is worthless to production and vice versa, and
	/// a widget that mixes them fails as a 401 that looks like an expiry. It
	/// also keeps the production URL from being written down a second time — the
	/// app already gets it from the OpenAPI document.
	public var apiBaseURL: URL
	public var expiresAt: Date
	public var mintedAt: Date

	public init(organizationId: String, secret: String, apiBaseURL: URL, expiresAt: Date, mintedAt: Date) {
		self.organizationId = organizationId
		self.secret = secret
		self.apiBaseURL = apiBaseURL
		self.expiresAt = expiresAt
		self.mintedAt = mintedAt
	}

	public func isExpired(at date: Date) -> Bool { date >= expiresAt }

	/// Re-mint with a week to spare.
	///
	/// The window is generous on purpose: renewal needs a signed-in foreground,
	/// and a phone that only gets opened at the weekend must not be one bad
	/// Monday away from a Home Screen that has gone quiet with no way to
	/// recover on its own.
	public static let renewalLead: TimeInterval = 7 * 24 * 60 * 60

	public func needsRenewal(at date: Date) -> Bool {
		date.addingTimeInterval(Self.renewalLead) >= expiresAt
	}
}

/// Where the credential lives: a file in the shared App Group container.
///
/// **Not `UserDefaults`, unlike the snapshots.** A suite plist is a bearer
/// credential sitting in cleartext in a backup; a file can carry a data
/// protection class, and `completeUntilFirstUserAuthentication` is the one that
/// matches when a widget actually runs — WidgetKit rebuilds Lock Screen
/// accessories on a locked phone, so anything stricter would make the widget
/// fail exactly where it is most visible.
///
/// **Not the Keychain either, yet.** The app's keychain access group is where
/// Clerk keeps the session, and sharing *that* group with the extension would
/// hand it the session this whole design exists to keep out of it. A separate
/// group is the eventual home; it needs a provisioning change, and this store's
/// interface is what lets that happen later without touching the wire.
public struct WidgetCredentialStore: Sendable {
	private let appGroupIdentifier: String
	/// Tests only. `containerURL(forSecurityApplicationGroupIdentifier:)` answers
	/// nil outside a signed app, so without this the store's behaviour could
	/// only be exercised on a simulator — and the rules it enforces (whose
	/// credential this is, what a sign-out leaves behind) are exactly the ones
	/// worth testing with `swift test`.
	private let overrideDirectory: URL?

	/// - Parameter appGroupIdentifier: overridden only by tests.
	public init(appGroupIdentifier: String = WidgetAppGroup.identifier) {
		self.appGroupIdentifier = appGroupIdentifier
		self.overrideDirectory = nil
	}

	init(directory: URL) {
		self.appGroupIdentifier = WidgetAppGroup.identifier
		self.overrideDirectory = directory
	}

	private var directory: URL? {
		if let overrideDirectory { return overrideDirectory }
		return FileManager.default
			.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
			.appendingPathComponent("credentials", isDirectory: true)
	}

	/// One file per organization, named by its id.
	///
	/// Organization ids are `org_` plus base62 and contain nothing path-ish, but
	/// this is the one place a value that arrived over the network becomes a
	/// filename — so it is checked rather than trusted.
	///
	/// **Rejected, not sanitized.** Stripping the offending characters would map
	/// `../../org_a` and `org_a` onto the same file, so an id that should have
	/// been refused outright would instead quietly overwrite a real
	/// organization's credential. Nothing legitimate ever fails this check.
	private func url(for organizationId: String) -> URL? {
		guard
			!organizationId.isEmpty,
			organizationId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
		else { return nil }
		return directory?.appendingPathComponent("widget-\(organizationId).json", isDirectory: false)
	}

	public func load(organizationId: String) -> WidgetCredential? {
		guard let url = url(for: organizationId), let data = try? Data(contentsOf: url) else { return nil }
		// A credential written by a newer build that this one cannot decode is
		// dropped rather than crashing the extension mid-timeline.
		guard let credential = try? Self.decoder.decode(WidgetCredential.self, from: data) else {
			return nil
		}
		// A file whose contents name a different organization is not this
		// organization's credential, whatever it is doing under that name.
		return credential.organizationId == organizationId ? credential : nil
	}

	@discardableResult
	public func save(_ credential: WidgetCredential) -> Bool {
		guard
			let directory,
			let url = url(for: credential.organizationId),
			let data = try? Self.encoder.encode(credential)
		else { return false }
		try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		do {
			try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
			return true
		} catch {
			return false
		}
	}

	public func clear(organizationId: String) {
		guard let url = url(for: organizationId) else { return }
		try? FileManager.default.removeItem(at: url)
	}

	/// Sign-out. Everything, not just the organizations this build knows about:
	/// the Home Screen outlives the session, and a credential left behind is one
	/// the next person holding the phone could still fetch with.
	public func clearAll() {
		guard let directory else { return }
		try? FileManager.default.removeItem(at: directory)
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

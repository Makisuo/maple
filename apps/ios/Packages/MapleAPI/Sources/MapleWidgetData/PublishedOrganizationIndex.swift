import Foundation

/// An organization the app has published a snapshot for.
public struct PublishedOrganization: Codable, Hashable, Sendable, Identifiable {
	public var id: String
	/// Display name, when the app knew one. The id is the stable identity —
	/// an organization can be renamed, and a widget pinned to it must survive
	/// that.
	public var name: String?
	public var lastPublishedAt: Date

	public init(id: String, name: String?, lastPublishedAt: Date) {
		self.id = id
		self.name = name
		self.lastPublishedAt = lastPublishedAt
	}
}

/// Which organizations the widget extension may show, and which one is active.
///
/// The extension has no session and cannot ask Clerk anything, so this is its
/// only source of truth for the organization picker and for resolving a widget
/// that was never configured. The app writes it whenever it publishes.
public struct PublishedOrganizationIndex: Sendable {
	private let appGroupIdentifier: String

	private enum Key {
		static let organizations = "widgets.organizations.v1"
		static let active = "widgets.activeOrganization.v1"
	}

	public init(appGroupIdentifier: String = WidgetAppGroup.identifier) {
		self.appGroupIdentifier = appGroupIdentifier
	}

	private var defaults: UserDefaults? { UserDefaults(suiteName: appGroupIdentifier) }

	/// The organization a widget with no configuration resolves to — including
	/// every widget migrated from before the picker existed.
	public var activeOrganizationId: String? {
		defaults?.string(forKey: Key.active)
	}

	/// Published organizations, **active first**, then by most recently
	/// published. That ordering is what the picker shows and what
	/// `defaultResult()` picks, so a newly placed widget lands where the user
	/// already is.
	public func load() -> [PublishedOrganization] {
		guard let data = defaults?.data(forKey: Key.organizations),
			let decoded = try? Self.decoder.decode([PublishedOrganization].self, from: data)
		else { return [] }

		let active = activeOrganizationId
		return decoded.sorted { first, second in
			if (first.id == active) != (second.id == active) { return first.id == active }
			return first.lastPublishedAt > second.lastPublishedAt
		}
	}

	/// Record a publish. Replaces the existing entry rather than appending, so
	/// republishing does not grow the list.
	public func record(_ organization: PublishedOrganization, isActive: Bool) {
		guard let defaults else { return }
		var organizations = load().filter { $0.id != organization.id }
		organizations.append(organization)
		write(organizations, to: defaults)
		if isActive { defaults.set(organization.id, forKey: Key.active) }
	}

	/// Drop every organization the user is no longer a member of, and return
	/// their ids so the caller can wipe their snapshots too.
	///
	/// **Only ever call this with a verified membership list.** Pruning against
	/// Clerk's partial client payload would delete live organizations' snapshots
	/// and leave those widgets empty until the next publish.
	@discardableResult
	public func prune(to memberIds: Set<String>) -> [String] {
		guard let defaults else { return [] }
		let organizations = load()
		let evicted = organizations.map(\.id).filter { !memberIds.contains($0) }
		guard !evicted.isEmpty else { return [] }

		write(organizations.filter { memberIds.contains($0.id) }, to: defaults)
		if let active = activeOrganizationId, !memberIds.contains(active) {
			defaults.removeObject(forKey: Key.active)
		}
		return evicted
	}

	/// Sign-out. Returns every id that was published, because the caller has a
	/// per-organization snapshot to remove for each — leaving those behind would
	/// keep one account's incidents readable to whoever holds the phone next.
	@discardableResult
	public func clear() -> [String] {
		guard let defaults else { return [] }
		let ids = load().map(\.id)
		defaults.removeObject(forKey: Key.organizations)
		defaults.removeObject(forKey: Key.active)
		return ids
	}

	private func write(_ organizations: [PublishedOrganization], to defaults: UserDefaults) {
		guard let data = try? Self.encoder.encode(organizations) else { return }
		defaults.set(data, forKey: Key.organizations)
	}

	// ISO-8601, matching `WidgetSnapshotStore`: read by another process, from
	// possibly another build.
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

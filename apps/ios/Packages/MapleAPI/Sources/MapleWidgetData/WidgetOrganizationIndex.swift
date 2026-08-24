import Foundation

/// An organization a widget may be pinned to.
public struct WidgetOrganization: Codable, Hashable, Sendable, Identifiable {
	public var id: String
	/// Display name, when the app knew one. The id is the stable identity —
	/// an organization can be renamed, and a widget pinned to it must survive
	/// that.
	public var name: String?
	/// When a snapshot was last published for it, or nil for an organization
	/// the user belongs to that has never been fetched. Nil is a real state,
	/// not a missing value: it is what a newly joined organization looks like
	/// until a round covers it, and the widget renders it as "Open Maple"
	/// rather than as "you are not a member".
	public var lastPublishedAt: Date?
	/// The deployment environments this organization reports telemetry in, for
	/// the widget's environment picker.
	///
	/// Written by the app, because the extension cannot ask: it holds no
	/// session and its one network call is fenced to `/v2/widget_summary`.
	/// Empty means "the app has not looked yet", which the picker renders as
	/// the whole-organization choice alone rather than as an empty list.
	public var environments: [String]
	/// Which environment the *app* is currently showing, so a newly placed
	/// widget lands on what the user was just looking at instead of on a
	/// question. Nil is the whole organization, and a real answer — not a
	/// missing one.
	public var activeEnvironment: String?

	public init(
		id: String,
		name: String?,
		lastPublishedAt: Date? = nil,
		environments: [String] = [],
		activeEnvironment: String? = nil
	) {
		self.id = id
		self.name = name
		self.lastPublishedAt = lastPublishedAt
		self.environments = environments
		self.activeEnvironment = activeEnvironment
	}

	private enum CodingKeys: String, CodingKey {
		case id, name, lastPublishedAt, environments, activeEnvironment
	}

	/// Hand-written so an entry written by a build before the environment
	/// picker still decodes. Synthesis would make `environments` a required key
	/// and drop the whole index — every widget on the Home Screen would fall
	/// back to "Open Maple" on upgrade.
	public init(from decoder: any Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		self.id = try container.decode(String.self, forKey: .id)
		self.name = try container.decodeIfPresent(String.self, forKey: .name)
		self.lastPublishedAt = try container.decodeIfPresent(Date.self, forKey: .lastPublishedAt)
		self.environments = try container.decodeIfPresent([String].self, forKey: .environments) ?? []
		self.activeEnvironment = try container.decodeIfPresent(String.self, forKey: .activeEnvironment)
	}
}

/// Which organizations the widget extension may show, and which one is active.
///
/// The extension has no session and cannot ask Clerk anything, so this is its
/// only source of truth for the organization picker and for resolving a widget
/// that was never configured.
///
/// It holds **every organization the user belongs to**, not only the ones the
/// app has published for. Publishing used to be the only writer, which made the
/// picker circular: an organization was listed only once it had been published,
/// and `WidgetPublisher` only publishes for the active organization and ones a
/// widget is already pinned to — so an organization could not be picked until
/// it had been picked. An account in five organizations saw two.
public struct WidgetOrganizationIndex: Sendable {
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

	/// Known organizations, **active first**, then alphabetically by name.
	///
	/// Alphabetical rather than by publish recency: this is the list the picker
	/// shows, and a picker whose rows reorder themselves between two openings —
	/// because a background round happened to touch one of them — is a list you
	/// cannot learn. Active-first stays, because `defaultResult()` and the
	/// header's "which organization" both rest on it.
	public func load() -> [WidgetOrganization] {
		guard let data = defaults?.data(forKey: Key.organizations),
			let decoded = try? Self.decoder.decode([WidgetOrganization].self, from: data)
		else { return [] }

		let active = activeOrganizationId
		return decoded.sorted { first, second in
			if (first.id == active) != (second.id == active) { return first.id == active }
			let left = first.name ?? first.id
			let right = second.name ?? second.id
			let order = left.localizedCaseInsensitiveCompare(right)
			if order != .orderedSame { return order == .orderedAscending }
			return first.id < second.id
		}
	}

	/// Record a publish. Replaces the existing entry rather than appending, so
	/// republishing does not grow the list.
	///
	/// A nil `name` never overwrites a name already on file: the round's name
	/// can be unknown (a headless bootstrap has only the index to go on), and
	/// blanking it would make the picker render a raw `org_…` id.
	public func record(_ organization: WidgetOrganization, isActive: Bool) {
		guard let defaults else { return }
		let existing = load()
		let previous = existing.first { $0.id == organization.id }
		var updated = organization
		if updated.name == nil { updated.name = previous?.name }
		// A publish round knows nothing about environments — same reason the
		// name is preserved rather than blanked. Losing them here would empty
		// the widget's environment picker on the next background fetch.
		if updated.environments.isEmpty { updated.environments = previous?.environments ?? [] }
		if updated.activeEnvironment == nil { updated.activeEnvironment = previous?.activeEnvironment }
		write(existing.filter { $0.id != organization.id } + [updated], to: defaults)
		if isActive { defaults.set(organization.id, forKey: Key.active) }
	}

	/// Take the user's whole membership list, so the picker can offer an
	/// organization before anything has ever been fetched for it.
	///
	/// Purely additive: it adds organizations and corrects names, and never
	/// removes. Removal is `prune`'s alone, because an entry has a snapshot
	/// behind it that has to be wiped in the same breath — dropping the entry
	/// here would leave that snapshot in the App Group with nothing left
	/// pointing at it. The two run back to back, `prune` second.
	///
	/// Returns whether anything a reader could see changed — a new
	/// organization, or a corrected name. The caller spends a widget reload on
	/// `true`, and iOS meters those, so a launch that learns nothing new must
	/// report `false`.
	@discardableResult
	public func record(memberships: [WidgetOrganization]) -> Bool {
		guard let defaults, !memberships.isEmpty else { return false }
		let existing = load()
		var byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

		for membership in memberships {
			// The membership list is authoritative for the name and knows
			// nothing about publishing; keep the timestamp we already recorded.
			byId[membership.id] = WidgetOrganization(
				id: membership.id,
				name: membership.name,
				lastPublishedAt: byId[membership.id]?.lastPublishedAt,
				// Same rule as the timestamp: the membership list is authoritative
				// for the name and silent about everything else.
				environments: byId[membership.id]?.environments ?? [],
				activeEnvironment: byId[membership.id]?.activeEnvironment
			)
		}

		let updated = Array(byId.values)
		let before = Dictionary(existing.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
		let after = Dictionary(updated.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
		guard before != after else { return false }

		write(updated, to: defaults)
		return true
	}

	/// Record what the app has learned about one organization's environments:
	/// which exist, and which the app is currently showing.
	///
	/// Separate from `record(memberships:)` because the two have different
	/// sources and different cadences — memberships come from Clerk on launch,
	/// environments from the warehouse whenever the organization changes — and
	/// folding them together would mean either fetching environments to correct
	/// a name or blanking them when a membership refresh arrives first.
	///
	/// Does nothing for an organization the index has never heard of: the entry
	/// would have no name and no snapshot, and would show up in the picker as a
	/// bare `org_…` id. Memberships are recorded first, on every launch.
	///
	/// Returns whether a reader could tell the difference, so the caller only
	/// spends a metered widget reload when there is something new to see.
	@discardableResult
	public func record(
		environments: [String],
		activeEnvironment: String?,
		for organizationId: String
	) -> Bool {
		guard let defaults else { return false }
		let existing = load()
		guard let previous = existing.first(where: { $0.id == organizationId }) else { return false }
		guard previous.environments != environments || previous.activeEnvironment != activeEnvironment
		else { return false }

		var updated = previous
		updated.environments = environments
		updated.activeEnvironment = activeEnvironment
		write(existing.filter { $0.id != organizationId } + [updated], to: defaults)
		return true
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

	/// Sign-out. Returns every id that was known, because the caller has a
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

	/// The name to record for an organization, from the sources in the order
	/// they can be trusted.
	///
	/// A pure function, and public, because the bug it exists to prevent is one
	/// the app target cannot test: `WidgetPublisher` used to take the id from
	/// the session's active-organization claim and the *name* from Clerk's
	/// separate `organization` object, which is fed by the client payload and
	/// can lag a `setActive`. When the two disagreed the index recorded
	/// organization B's id under organization A's name, and the picker showed
	/// two rows reading "A" while the widget put A's name over B's numbers.
	/// Names come from the membership list, which is keyed by id, or from what
	/// is already on file — never from anything that is merely "the current
	/// organization".
	public static func resolveName(
		id: String,
		memberships: [WidgetOrganization],
		existing: [WidgetOrganization]
	) -> String? {
		memberships.first { $0.id == id }?.name ?? existing.first { $0.id == id }?.name
	}

	private func write(_ organizations: [WidgetOrganization], to defaults: UserDefaults) {
		guard let data = try? Self.encoder.encode(organizations) else { return }
		defaults.set(data, forKey: Key.organizations)
	}

	// ISO-8601, matching `WidgetSnapshotStore`: read by another process, from
	// possibly another build — which is also why the decoder is the tolerant
	// one. See `WidgetJSON`.
	private static var encoder: JSONEncoder { WidgetJSON.encoder }
	private static var decoder: JSONDecoder { WidgetJSON.decoder }
}

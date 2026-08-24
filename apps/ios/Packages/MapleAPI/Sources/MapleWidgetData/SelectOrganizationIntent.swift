import AppIntents
import Foundation

/// The issues widget's configuration: which organization it shows.
///
/// Before this, every widget followed whichever organization happened to be
/// active in the app, so switching organizations silently re-pointed the Home
/// Screen. Pinning is the whole point: two widgets, two organizations, both
/// correct at once.
public struct SelectOrganizationIntent: WidgetConfigurationIntent {
	public static let title: LocalizedStringResource = "Select organization"
	public static let description = IntentDescription("Show one organization's ongoing issues.")

	@Parameter(title: "Organization")
	public var organization: OrganizationEntity?

	/// Which deployment environment's issues, or all of them when unset.
	///
	/// Added as a new optional parameter rather than as a new intent type: iOS
	/// persists the intent *type name* for every configured widget, so renaming
	/// or replacing this type would unconfigure every widget already on a Home
	/// Screen. Existing instances decode with this nil, which is the
	/// organization-wide behaviour they already had.
	@Parameter(title: "Environment")
	public var environment: EnvironmentEntity?

	public init() {}

	public init(organization: OrganizationEntity?, environment: EnvironmentEntity? = nil) {
		self.organization = organization
		self.environment = environment
	}
}

/// One row of the organization picker.
public struct OrganizationEntity: AppEntity {
	/// The `org_…` id, not the name: an organization can be renamed, and a
	/// widget pinned to it has to survive that.
	public var id: String
	public var name: String?

	public init(id: String, name: String?) {
		self.id = id
		self.name = name
	}

	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Organization")
	public static let defaultQuery = OrganizationEntityQuery()

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(name ?? id)")
	}
}

/// The options come from the App Group index, which carries every organization
/// the user belongs to. The extension has no session, so this is the only thing
/// here that knows an organization exists.
public struct OrganizationEntityQuery: EntityQuery {
	public init() {}

	private var known: [WidgetOrganization] { WidgetOrganizationIndex().load() }

	/// Resolving what a configured widget already holds. An organization the
	/// user has since left still resolves, by id — dropping it would silently
	/// re-point the widget at the active organization, which is the exact
	/// failure this configuration exists to prevent. The widget renders it as
	/// unavailable instead.
	public func entities(for identifiers: [String]) async throws -> [OrganizationEntity] {
		let organizations = known
		return identifiers.map { identifier in
			OrganizationEntity(id: identifier, name: organizations.first { $0.id == identifier }?.name)
		}
	}

	public func suggestedEntities() async throws -> [OrganizationEntity] {
		known.map { OrganizationEntity(id: $0.id, name: $0.name) }
	}

	/// A newly placed widget lands on the organization the user is already in,
	/// rather than on an empty picker they have to answer before the widget says
	/// anything. It is also what a widget migrated from the pre-configuration
	/// build resolves to.
	public func defaultResult() async -> OrganizationEntity? {
		let organizations = known
		guard let activeId = WidgetOrganizationIndex().activeOrganizationId else {
			return organizations.first.map { OrganizationEntity(id: $0.id, name: $0.name) }
		}
		return OrganizationEntity(id: activeId, name: organizations.first { $0.id == activeId }?.name)
	}
}

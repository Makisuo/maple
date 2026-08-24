import AppIntents
import Foundation

/// One row of the widget's environment picker.
///
/// The deployment environment name is the identifier: environments are named,
/// not numbered, and a widget pinned to "staging" should keep meaning staging
/// across every republish that reorders the list.
///
/// There is no "All environments" row. The parameter is optional on both
/// intents, so unset already means the whole organization — the same shape
/// `SelectServiceIntent.service` uses for "no service in particular". A
/// sentinel entity would give the same state two spellings, and a widget
/// configured with one of them would not match a widget configured with the
/// other.
public struct EnvironmentEntity: AppEntity {
	public var id: String

	public init(id: String) {
		self.id = id
	}

	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Environment")
	public static let defaultQuery = EnvironmentEntityQuery()

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(id)")
	}
}

/// The options come from the App Group index, which is the only thing in the
/// extension that knows an environment exists — it holds no session, and its
/// one network call is fenced to `/v2/widget_summary`.
///
/// Both widget intents carry an environment parameter, so this declares a
/// dependency on each. Exactly one resolves for any given configuration
/// screen; the other stays nil. A single shared query rather than two is what
/// keeps the two pickers from drifting apart about what an environment is.
public struct EnvironmentEntityQuery: EntityQuery {
	public init() {}

	@IntentParameterDependency<SelectOrganizationIntent>(\.$organization)
	public var issuesConfiguration

	@IntentParameterDependency<SelectServiceIntent>(\.$organization)
	public var throughputConfiguration

	/// The dependency is nil until the organization parameter resolves, and an
	/// empty picker on first open reads as broken — so fall back to the
	/// organization the app is in, exactly as `ServiceEntityQuery` does.
	private var organizationId: String? {
		issuesConfiguration?.organization.id
			?? throughputConfiguration?.organization.id
			?? WidgetOrganizationIndex().activeOrganizationId
	}

	private var organization: WidgetOrganization? {
		guard let organizationId else { return nil }
		return WidgetOrganizationIndex().load().first { $0.id == organizationId }
	}

	/// Resolving what a configured widget already holds. An environment that
	/// has since stopped reporting still resolves, by name — dropping it would
	/// silently re-point the widget at the whole organization, which reads as
	/// "your staging traffic recovered" rather than "staging went quiet". The
	/// widget renders it as an empty environment instead.
	public func entities(for identifiers: [String]) async throws -> [EnvironmentEntity] {
		identifiers.map(EnvironmentEntity.init(id:))
	}

	public func suggestedEntities() async throws -> [EnvironmentEntity] {
		(organization?.environments ?? []).map(EnvironmentEntity.init(id:))
	}

	/// A newly placed widget lands on whatever the app is currently showing,
	/// rather than on a question the user has to answer before the widget says
	/// anything. Nil — the whole organization — is a real answer here, which is
	/// why this may legitimately return nothing.
	public func defaultResult() async -> EnvironmentEntity? {
		organization?.activeEnvironment.map(EnvironmentEntity.init(id:))
	}
}

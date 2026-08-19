import AppIntents
import Foundation

/// The widget's own configuration: which service it shows.
///
/// Long-press → Edit Widget → Service. Leaving it unset means the whole
/// organization, which is the useful default — someone adding a throughput
/// widget without a service in mind wants "is traffic normal", not a picker
/// they have to answer before the widget says anything.
public struct SelectServiceIntent: WidgetConfigurationIntent {
	public static let title: LocalizedStringResource = "Select service"
	public static let description = IntentDescription("Show one service's throughput, or the whole organization's.")

	@Parameter(title: "Service")
	public var service: ServiceEntity?

	/// Added rather than split into a second intent: iOS persists the intent
	/// *type name* for every configured widget, so renaming or replacing this
	/// type unconfigures them all. A new optional parameter is safe — existing
	/// instances decode with it nil, which resolves to the active organization.
	@Parameter(title: "Organization")
	public var organization: OrganizationEntity?

	public init() {}

	public init(service: ServiceEntity?, organization: OrganizationEntity? = nil) {
		self.service = service
		self.organization = organization
	}
}

/// One row of the picker.
///
/// The options come from the snapshot the app published — the extension has no
/// session to list services with, and the app's own list is the right one
/// anyway: it is scoped to the signed-in organization and to services that
/// actually reported in the last hour.
public struct ServiceEntity: AppEntity {
	/// The service name is the identifier. Names are unique per organization,
	/// and using them means a configured widget survives a republish that
	/// reordered the list.
	public var id: String

	public var throughputPerSecond: Double?

	public init(id: String, throughputPerSecond: Double?) {
		self.id = id
		self.throughputPerSecond = throughputPerSecond
	}

	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Service")
	public static let defaultQuery = ServiceEntityQuery()

	public var displayRepresentation: DisplayRepresentation {
		guard let throughputPerSecond else { return DisplayRepresentation(title: "\(id)") }
		// The rate as a subtitle: with a dozen services, "which one is busy"
		// is most of what the choice depends on.
		return DisplayRepresentation(title: "\(id)", subtitle: "\(WidgetFormat.rate(throughputPerSecond))")
	}
}

public struct ServiceEntityQuery: EntityQuery {
	public init() {}

	/// Reads the organization parameter of the very intent being configured, so
	/// the service list belongs to the organization the user just picked.
	@IntentParameterDependency<SelectServiceIntent>(\.$organization)
	public var configuration

	/// The dependency is nil until the organization parameter resolves, and an
	/// empty service picker on first open reads as broken — so fall back to the
	/// organization the app is in.
	private var organizationId: String? {
		configuration?.organization.id ?? PublishedOrganizationIndex().activeOrganizationId
	}

	private var snapshot: ThroughputSnapshot? {
		organizationId.flatMap { WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: $0).load() }
	}

	/// Resolving what a configured widget already holds. A service that has
	/// since gone quiet still resolves — dropping it here would silently
	/// re-point the widget at the organization total, which reads as "your
	/// service is fine" rather than "your service stopped reporting".
	public func entities(for identifiers: [String]) async throws -> [ServiceEntity] {
		let services = snapshot?.services ?? []
		return identifiers.map { identifier in
			ServiceEntity(
				id: identifier,
				throughputPerSecond: services.first { $0.name == identifier }?.throughputPerSecond
			)
		}
	}

	/// The list iOS shows in the picker: busiest first, as published.
	public func suggestedEntities() async throws -> [ServiceEntity] {
		(snapshot?.services ?? []).compactMap { service in
			service.name.map { ServiceEntity(id: $0, throughputPerSecond: service.throughputPerSecond) }
		}
	}
}

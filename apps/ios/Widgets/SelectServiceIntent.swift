import AppIntents
import MapleWidgetData

/// The widget's own configuration: which service it shows.
///
/// Long-press → Edit Widget → Service. Leaving it unset means the whole
/// organization, which is the useful default — someone adding a throughput
/// widget without a service in mind wants "is traffic normal", not a picker
/// they have to answer before the widget says anything.
struct SelectServiceIntent: WidgetConfigurationIntent {
	static let title: LocalizedStringResource = "Select service"
	static let description = IntentDescription("Show one service's throughput, or the whole organization's.")

	@Parameter(title: "Service")
	var service: ServiceEntity?

	init() {}

	init(service: ServiceEntity?) {
		self.service = service
	}
}

/// One row of the picker.
///
/// The options come from the snapshot the app published — the extension has no
/// session to list services with, and the app's own list is the right one
/// anyway: it is scoped to the signed-in organization and to services that
/// actually reported in the last hour.
struct ServiceEntity: AppEntity {
	/// The service name is the identifier. Names are unique per organization,
	/// and using them means a configured widget survives a republish that
	/// reordered the list.
	var id: String

	var throughputPerSecond: Double?

	static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Service")
	static let defaultQuery = ServiceEntityQuery()

	var displayRepresentation: DisplayRepresentation {
		guard let throughputPerSecond else { return DisplayRepresentation(title: "\(id)") }
		// The rate as a subtitle: with a dozen services, "which one is busy"
		// is most of what the choice depends on.
		return DisplayRepresentation(title: "\(id)", subtitle: "\(WidgetFormat.rate(throughputPerSecond))")
	}
}

struct ServiceEntityQuery: EntityQuery {
	private var snapshot: ThroughputSnapshot? { WidgetSnapshotStore<ThroughputSnapshot>.throughput.load() }

	/// Resolving what a configured widget already holds. A service that has
	/// since gone quiet still resolves — dropping it here would silently
	/// re-point the widget at the organization total, which reads as "your
	/// service is fine" rather than "your service stopped reporting".
	func entities(for identifiers: [String]) async throws -> [ServiceEntity] {
		let services = snapshot?.services ?? []
		return identifiers.map { identifier in
			ServiceEntity(
				id: identifier,
				throughputPerSecond: services.first { $0.name == identifier }?.throughputPerSecond
			)
		}
	}

	/// The list iOS shows in the picker: busiest first, as published.
	func suggestedEntities() async throws -> [ServiceEntity] {
		(snapshot?.services ?? []).compactMap { service in
			service.name.map { ServiceEntity(id: $0, throughputPerSecond: service.throughputPerSecond) }
		}
	}
}

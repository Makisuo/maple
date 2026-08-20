import AppIntents
import MapleWidgetData
import SwiftUI
import WidgetKit

/// Throughput — the organization's, or one service's, picked in the widget's
/// own configuration rather than by adding a different widget per service.
///
/// Like the issues widget, this renders a snapshot the app published into the
/// shared App Group and makes no requests of its own. See `ThroughputSnapshot`.
struct ThroughputWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(
			kind: ThroughputWidgetKind.identifier,
			intent: SelectServiceIntent.self,
			provider: ThroughputProvider()
		) { entry in
			ThroughputWidgetView(entry: entry)
				.containerBackground(Token.background, for: .widget)
		}
		.configurationDisplayName("Throughput")
		.description("Traffic over the last hour — everything, or one service.")
		.supportedFamilies([
			.systemSmall,
			.systemMedium,
			.systemLarge,
			.accessoryRectangular,
			.accessoryInline,
		])
	}
}

struct ThroughputEntry: TimelineEntry {
	var date: Date
	var snapshot: ThroughputSnapshot?
	/// The service the widget is configured for; nil means the whole org.
	var serviceName: String?
	var isPlaceholder = false

	/// The row to draw, or nil when the configured service is not in the
	/// snapshot — it went quiet, or the org changed under the widget.
	var service: ServiceThroughput? { snapshot?.service(named: serviceName) }

	/// The organization whose numbers are on screen, carried into deep links.
	var organizationId: String?
	var organizationName: String?
	/// Only worth showing when the account has more than one.
	var showsOrganization = false
	/// Pinned to an organization the app no longer publishes.
	var isOrganizationUnavailable = false

	/// The organization to name in the header, or nil when naming it is noise.
	var headerOrganizationName: String? {
		guard showsOrganization else { return nil }
		return organizationName ?? organizationId
	}
}

struct ThroughputProvider: AppIntentTimelineProvider {
	private let index = WidgetOrganizationIndex()

	func placeholder(in context: Context) -> ThroughputEntry {
		ThroughputEntry(date: Date(), snapshot: .sample, serviceName: nil, isPlaceholder: true)
	}

	/// The gallery. Never the empty state: someone browsing widgets should see
	/// what this looks like with traffic in it.
	func snapshot(for configuration: SelectServiceIntent, in context: Context) async -> ThroughputEntry {
		var entry = makeEntry(for: configuration, at: Date())
		if context.isPreview, entry.snapshot == nil {
			entry.snapshot = .sample
			entry.isOrganizationUnavailable = false
		}
		return entry
	}

	/// Resolves the configured organization — nil meaning the active one, which
	/// is every widget configured before the organization parameter existed.
	private func makeEntry(for configuration: SelectServiceIntent, at date: Date) -> ThroughputEntry {
		let known = index.load()
		let configuredId = configuration.organization?.id
		let organizationId = configuredId ?? index.activeOrganizationId
		let serviceName = configuration.service?.id

		guard let organizationId else {
			return ThroughputEntry(date: date, snapshot: legacySnapshot(), serviceName: serviceName)
		}

		let stored = WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organizationId).load()
		// No fallback to another organization's snapshot — see `IssuesProvider`.
		let snapshot = stored ?? (configuredId == nil ? legacySnapshot() : nil)

		return ThroughputEntry(
			date: date,
			snapshot: snapshot,
			serviceName: serviceName,
			organizationId: organizationId,
			organizationName: known.first { $0.id == organizationId }?.name,
			showsOrganization: known.count > 1,
			// "Not a member any more", not "nothing fetched yet" — see
			// `IssuesProvider.makeEntry`.
			isOrganizationUnavailable: configuredId != nil
				&& !known.contains { $0.id == organizationId }
		)
	}

	/// The pre-per-organization key; see `IssuesProvider.legacySnapshot`.
	private func legacySnapshot() -> ThroughputSnapshot? {
		WidgetSnapshotStore<ThroughputSnapshot>.legacyThroughput.load()
	}

	/// One read, several entries — the numbers do not change between them,
	/// only how old they are. Same ladder as the issues widget, so the two
	/// widgets' footers never disagree about the time; see
	/// `WidgetTimelineSchedule`.
	func timeline(for configuration: SelectServiceIntent, in context: Context) async -> Timeline<ThroughputEntry> {
		let now = Date()
		let base = makeEntry(for: configuration, at: now)
		let entries = WidgetTimelineSchedule.entryDates(from: now).map { date -> ThroughputEntry in
			var entry = base
			entry.date = date
			return entry
		}
		return Timeline(entries: entries, policy: .after(WidgetTimelineSchedule.refreshDate(from: now)))
	}
}

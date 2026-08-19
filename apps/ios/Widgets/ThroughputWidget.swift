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
}

struct ThroughputProvider: AppIntentTimelineProvider {
	private let store = WidgetSnapshotStore<ThroughputSnapshot>.throughput

	func placeholder(in context: Context) -> ThroughputEntry {
		ThroughputEntry(date: Date(), snapshot: .sample, serviceName: nil, isPlaceholder: true)
	}

	/// The gallery. Never the empty state: someone browsing widgets should see
	/// what this looks like with traffic in it.
	func snapshot(for configuration: SelectServiceIntent, in context: Context) async -> ThroughputEntry {
		let stored = store.load()
		return ThroughputEntry(
			date: Date(),
			snapshot: context.isPreview ? (stored ?? .sample) : stored,
			serviceName: configuration.service?.id
		)
	}

	/// One read, several entries — the numbers do not change between them,
	/// only how old they are. The app's `reloadTimelines` is what actually
	/// keeps this current; the entries are the floor.
	func timeline(for configuration: SelectServiceIntent, in context: Context) async -> Timeline<ThroughputEntry> {
		let snapshot = store.load()
		let now = Date()
		let step: TimeInterval = 15 * 60
		let entries = (0..<8).map { index in
			ThroughputEntry(
				date: now.addingTimeInterval(Double(index) * step),
				snapshot: snapshot,
				serviceName: configuration.service?.id
			)
		}
		return Timeline(entries: entries, policy: .after(now.addingTimeInterval(8 * step)))
	}
}

import MapleWidgetData
import SwiftUI
import WidgetKit

/// Ongoing issues, on the Home Screen and the Lock Screen.
///
/// The extension holds no session and makes no requests: it renders the
/// snapshot the app publishes into the shared App Group. See `IssuesSnapshot`
/// for why, and `WidgetPublisher` for who writes it.
struct IssuesWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: IssuesWidgetKind.identifier, provider: IssuesProvider()) { entry in
			IssuesWidgetView(entry: entry)
				.containerBackground(Token.background, for: .widget)
		}
		.configurationDisplayName("Ongoing issues")
		.description("Error issues that still need attention, worst first.")
		.supportedFamilies([
			.systemSmall,
			.systemMedium,
			.systemLarge,
			.accessoryCircular,
			.accessoryRectangular,
			.accessoryInline,
		])
	}
}

/// One rendering. `date` is the moment the entry is for — not the moment the
/// data was fetched, which is `snapshot.generatedAt`. The gap between the two
/// is the staleness the widget shows.
struct IssuesEntry: TimelineEntry {
	var date: Date
	/// Nil until the app has published once: a fresh install, or the widget
	/// added before signing in.
	var snapshot: IssuesSnapshot?

	var isPlaceholder = false
}

struct IssuesProvider: TimelineProvider {
	private let store = WidgetSnapshotStore<IssuesSnapshot>.issues

	/// The redacted skeleton iOS shows while placing a widget. Real-shaped
	/// sample data, so the outline is the widget's own layout rather than a
	/// grey rectangle.
	func placeholder(in context: Context) -> IssuesEntry {
		IssuesEntry(date: Date(), snapshot: .sample, isPlaceholder: true)
	}

	/// The widget gallery. Never the empty state: a user browsing the gallery
	/// should see what the widget looks like when it has something to say.
	func getSnapshot(in context: Context, completion: @escaping (IssuesEntry) -> Void) {
		let stored = store.load()
		completion(IssuesEntry(date: Date(), snapshot: context.isPreview ? (stored ?? .sample) : stored))
	}

	/// Entries every quarter hour for the next two, from a single read.
	///
	/// The data does not change between them — only its age does, and the row
	/// times ("2m", "3h") are relative, so without these the widget would still
	/// claim "2m" an hour later. WidgetKit is told to come back after the last
	/// one; the app's own `reloadTimelines` is what actually keeps it current
	/// when something happens.
	func getTimeline(in context: Context, completion: @escaping (Timeline<IssuesEntry>) -> Void) {
		let snapshot = store.load()
		let now = Date()
		let step: TimeInterval = 15 * 60
		let entries = (0..<8).map { index in
			IssuesEntry(date: now.addingTimeInterval(Double(index) * step), snapshot: snapshot)
		}
		completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(8 * step))))
	}
}

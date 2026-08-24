import MapleWidgetData
import SwiftUI
import WidgetKit

/// Ongoing issues, on the Home Screen and the Lock Screen.
///
/// The extension holds no Clerk session. It fetches with a device credential
/// the app mints for it — read-only, expiring, and fenced by the server to
/// `/v2/widget_summary` alone — and falls back to whatever the app last
/// published into the shared App Group. See `WidgetSummaryFetcher` for the
/// fetch, `WidgetCredentialStore` for the credential, and `WidgetPublisher` for
/// the app's half.
struct IssuesWidget: Widget {
	var body: some WidgetConfiguration {
		// Configurable since the organization picker shipped. Widgets placed
		// before that are migrated by iOS rather than removed — the `kind` string
		// is the identity, so it must never change — and arrive with a
		// default-initialized intent, whose `defaultResult()` is the active
		// organization.
		AppIntentConfiguration(
			kind: IssuesWidgetKind.identifier,
			intent: SelectOrganizationIntent.self,
			provider: IssuesProvider()
		) { entry in
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

	/// The organization whose numbers are on screen. Deep links carry it so a tap
	/// resolves in that organization rather than in whichever one is active.
	var organizationId: String?
	var organizationName: String?
	/// The deployment environment on screen, or nil for the whole
	/// organization. Carried so the header can say which — a widget filtered to
	/// staging that looks identical to one that is not is a widget nobody can
	/// read.
	var environment: String?
	/// Shown only when the account publishes more than one organization — a
	/// single-organization Home Screen does not need its name repeated. Decided
	/// at timeline-build time so the view does no I/O.
	var showsOrganization = false
	/// The configured organization is not one the app publishes any more: the
	/// user left it, or was removed. A terminal state, not a loading one.
	var isOrganizationUnavailable = false

	/// The organization to name in the header, or nil when naming it would be
	/// noise.
	var headerOrganization: (name: String, id: String)? {
		guard showsOrganization, let organizationId else { return nil }
		return (organizationName ?? organizationId, organizationId)
	}
}

struct IssuesProvider: AppIntentTimelineProvider {
	private let index = WidgetOrganizationIndex()

	/// The redacted skeleton iOS shows while placing a widget. Real-shaped
	/// sample data, so the outline is the widget's own layout rather than a
	/// grey rectangle.
	func placeholder(in context: Context) -> IssuesEntry {
		IssuesEntry(date: Date(), snapshot: .sample, isPlaceholder: true)
	}

	/// The widget gallery. Never the empty state: a user browsing the gallery
	/// should see what the widget looks like when it has something to say.
	func snapshot(for configuration: SelectOrganizationIntent, in context: Context) async -> IssuesEntry {
		var entry = makeEntry(for: configuration, at: Date())
		if context.isPreview, entry.snapshot == nil {
			entry.snapshot = .sample
			entry.isOrganizationUnavailable = false
		}
		return entry
	}

	/// Resolves the configured organization to a snapshot.
	///
	/// A widget with no configuration — every instance migrated from before the
	/// picker — follows the active organization, which is also what
	/// `OrganizationEntityQuery.defaultResult()` gives a fresh one.
	private func makeEntry(for configuration: SelectOrganizationIntent, at date: Date) -> IssuesEntry {
		let known = index.load()
		let configuredId = configuration.organization?.id
		let organizationId = configuredId ?? index.activeOrganizationId

		guard let organizationId else {
			// Nothing known at all: a fresh install, or a widget added before
			// signing in.
			return IssuesEntry(date: date, snapshot: legacySnapshot())
		}

		// A widget with no environment configured reads the organization-wide
		// slot — the same key it read before the environment picker existed, so
		// a migrated instance keeps rendering what it always did.
		let environment = configuration.environment?.id
		let stored = WidgetSnapshotStore<IssuesSnapshot>
			.issues(organizationId: organizationId, environment: environment)
			.load()
		// Deliberately no fallback to another organization's snapshot. Rendering
		// one organization's counts under another's name is the same class of
		// error as opening the wrong organization from a notification.
		let snapshot = stored ?? (configuredId == nil ? legacySnapshot() : nil)
		// The index first: it is corrected the moment the membership list
		// loads, whereas a name inside a snapshot is only as current as the
		// round that wrote it.
		let name = known.first { $0.id == organizationId }?.name ?? snapshot?.organizationName

		return IssuesEntry(
			date: date,
			snapshot: snapshot,
			organizationId: organizationId,
			organizationName: name,
			environment: environment,
			showsOrganization: known.count > 1,
			// Configured, and not an organization the user belongs to: they
			// were removed from it. An organization that is known but has no
			// snapshot yet is a different statement — "Open Maple" — and the
			// index carrying every membership is what tells the two apart.
			isOrganizationUnavailable: configuredId != nil
				&& !known.contains { $0.id == organizationId }
		)
	}

	/// The pre-per-organization key. Keeps a widget placed before this shipped
	/// showing numbers until the next publish writes the new key; delete with
	/// the deprecated store accessors one release on.
	private func legacySnapshot() -> IssuesSnapshot? {
		WidgetSnapshotStore<IssuesSnapshot>.legacyIssues.load()
	}

	/// Fetch if it is worth it, then render the result at every point on
	/// `WidgetTimelineSchedule`'s ladder.
	///
	/// **The fetch enriches this timeline; it never gates it.** `makeEntry` runs
	/// first and would answer on its own, so a fetch that fails, times out, or
	/// never happens costs nothing but freshness — the widget renders the last
	/// snapshot with an honest age, which is what it did before it could fetch
	/// at all. Only a *successful* fetch sends us back to disk.
	///
	/// The ladder is still one read rendered many times: the data does not change
	/// between entries, only its age, and the row times ("2m", "3h") and the
	/// footer are relative — without them the widget would still claim "2m" an
	/// hour later.
	func timeline(for configuration: SelectOrganizationIntent, in context: Context) async -> Timeline<IssuesEntry> {
		let now = Date()
		var base = makeEntry(for: configuration, at: now)
		let outcome = await WidgetTimelineRefresh.run(
			organizationId: base.organizationId,
			organizationName: base.organizationName,
			environment: base.environment,
			storedGeneratedAt: base.snapshot?.generatedAt,
			now: now
		)
		// Re-read rather than take the payload back: the fetcher writes both
		// widgets' snapshots into the App Group, and going through the store
		// keeps this provider's one way of resolving an organization.
		if outcome.didFetch { base = makeEntry(for: configuration, at: now) }
		let entries = WidgetTimelineSchedule.entryDates(from: now).map { date -> IssuesEntry in
			var entry = base
			entry.date = date
			return entry
		}
		return Timeline(entries: entries, policy: .after(outcome.refreshDate))
	}
}

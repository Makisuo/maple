import Foundation
import MapleAPI
import MapleWidgetData
import WidgetKit

/// Keeps the Home Screen widget's snapshot current.
///
/// The widget cannot fetch for itself: every v2 request needs a Clerk session
/// token, Clerk mints those with a one-minute TTL, and an extension has no
/// interactive way to recover when refreshing one fails. So the app — the only
/// process that holds a session — fetches and writes; the widget only renders.
/// See `IssuesSnapshot`.
///
/// Refreshes are driven from four places, which between them cover every way a
/// phone is used:
///
/// - the tabs appearing, and every return to the foreground (`MainTabView`),
/// - an organization switch (`dataGeneration`, same place),
/// - `BGAppRefreshTask` while the app is not running (`WidgetRefreshScheduler`),
/// - a push arriving, silent or tapped (`AppDelegate`).
@MainActor
@Observable
final class IssuesWidgetPublisher {
	static let shared = IssuesWidgetPublisher()

	/// Ongoing means what the app's "Needs attention" filter means, over the
	/// same day Home considers recent: an issue nobody has actioned that is
	/// still happening. Without the window a months-dead issue in `triage`
	/// would sit on someone's Home Screen forever.
	private static let window = TimeWindow.last24Hours
	/// Enough to make `openCount` meaningful and to be sure the six rows shown
	/// are the six worst; beyond that the widget renders "20+".
	private static let fetchLimit = 20
	/// Foreground, push, and background refresh can all fire within a second
	/// of each other. One request per minute is plenty for a surface iOS
	/// redraws every fifteen.
	private static let minimumInterval: TimeInterval = 60

	private let store: IssuesSnapshotStore
	private var lastRefreshedAt: Date?
	/// Set once the app knows who is signed in, so the background task — which
	/// runs with no view tree — has something to fetch with.
	private var context: Context?

	struct Context {
		var api: any MapleAPI
		var organizationId: String
		var organizationName: String?
	}

	init(store: IssuesSnapshotStore = .shared) {
		self.store = store
	}

	/// Called whenever the signed-in organization is known or changes.
	func configure(api: any MapleAPI, organizationId: String, organizationName: String?) {
		let isNewOrganization = context?.organizationId != organizationId
		context = Context(api: api, organizationId: organizationId, organizationName: organizationName)
		// A switch invalidates both the throttle and whatever is on the Home
		// Screen: those counts belong to the org the user just left.
		if isNewOrganization { lastRefreshedAt = nil }
	}

	/// Fetch and publish. Silent by design — the widget is a side effect of
	/// using the app, and a failure here must never surface as an error on a
	/// screen the user did not ask to refresh. The last good snapshot stays,
	/// and the widget ages it honestly.
	func refresh(force: Bool = false) async {
		guard let context else { return }
		if !force, let lastRefreshedAt, Date().timeIntervalSince(lastRefreshedAt) < Self.minimumInterval { return }

		let resolved = Self.window.resolve()
		guard
			let page = try? await context.api.issues(
				query: IssueQuery(actionableOnly: true, sort: .severity),
				window: resolved,
				limit: Self.fetchLimit,
				cursor: nil
			)
		else { return }

		lastRefreshedAt = Date()
		publish(
			IssuesSnapshot.make(
				organizationId: context.organizationId,
				organizationName: context.organizationName,
				generatedAt: Date(),
				issues: page.items.map(WidgetIssue.init(issue:)),
				hasMore: page.hasMore
			)
		)
	}

	/// Sign-out. The widget outlives the session, so the previous account's
	/// failures must not stay legible on the lock screen.
	func clear() {
		context = nil
		lastRefreshedAt = nil
		store.clear()
		WidgetCenter.shared.reloadAllTimelines()
	}

	private func publish(_ snapshot: IssuesSnapshot) {
		guard store.save(snapshot) else { return }
		// Reload rather than wait for the next timeline entry: the whole point
		// of publishing from the app is that the Home Screen updates the moment
		// the app learns something.
		WidgetCenter.shared.reloadTimelines(ofKind: IssuesWidgetKind.identifier)
	}
}

extension WidgetIssue {
	/// The wire model, reduced to what a widget row can hold.
	///
	/// `last_seen_at` is the one field that can fail to parse. Falling back to
	/// `.distantPast` rather than dropping the row keeps the issue visible and
	/// sorts it last, which is the failure mode that loses the least.
	init(issue: ErrorIssue) {
		self.init(
			id: issue.id,
			title: issue.displayTitle,
			subtitle: issue.displaySubtitle,
			serviceName: issue.serviceName,
			// Unknown-to-this-build severities decode to nil and rank below
			// `low` rather than crashing a widget that cannot be updated
			// without an App Store release.
			severity: issue.severity.flatMap { WidgetIssueSeverity(rawValue: $0.rawValue) },
			occurrenceCount: issue.occurrenceCount,
			lastSeenAt: ResolvedTimeWindow.parse(issue.lastSeenAt) ?? .distantPast,
			isRegressed: issue.regressionCount > 0,
			hasOpenIncident: issue.hasOpenIncident
		)
	}
}

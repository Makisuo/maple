import Foundation
import MapleAPI
import MapleWidgetData
import WidgetKit

/// Keeps both Home Screen widgets' snapshots current: ongoing issues, and
/// throughput.
///
/// Neither widget can fetch for itself: every v2 request needs a Clerk session
/// token, Clerk mints those with a one-minute TTL, and an extension has no
/// interactive way to recover when refreshing one fails. So the app — the only
/// process that holds a session — fetches and writes; the widgets only render.
/// See `IssuesSnapshot` and `ThroughputSnapshot`.
///
/// Refreshes are driven from four places, which between them cover every way a
/// phone is used:
///
/// - the tabs appearing, and every return to the foreground (`MainTabView`),
/// - an organization switch (same place, keyed on the org),
/// - `BGAppRefreshTask` while the app is not running (`WidgetRefreshScheduler`),
/// - a push arriving, silent or tapped (`AppDelegate`).
@MainActor
@Observable
final class WidgetPublisher {
	static let shared = WidgetPublisher()

	/// Ongoing means what the app's "Needs attention" filter means, over the
	/// same day Home considers recent: an issue nobody has actioned that is
	/// still happening. Without the window a months-dead issue in `triage`
	/// would sit on someone's Home Screen forever.
	private static let issuesWindow = TimeWindow.last24Hours
	/// Throughput is a "right now" number, so it uses Home's rate window —
	/// same hour, same figures as the Services tab.
	private static let throughputWindow = TimeWindow.lastHour
	/// Enough to make `openCount` meaningful and to be sure the six rows shown
	/// are the six worst; beyond that the widget renders "20+".
	private static let issueFetchLimit = 20
	/// The picker shows at most `ThroughputSnapshot.maximumServices`, but the
	/// org total is summed from every service, so this is deliberately wider.
	private static let serviceFetchLimit = 50
	/// Foreground, push, and background refresh can all fire within a second
	/// of each other. One round per minute is plenty for a surface iOS redraws
	/// every fifteen.
	private static let minimumInterval: TimeInterval = 60

	private let issuesStore: WidgetSnapshotStore<IssuesSnapshot>
	private let throughputStore: WidgetSnapshotStore<ThroughputSnapshot>
	private var lastRefreshedAt: Date?
	/// Set once the app knows who is signed in, so the background task — which
	/// runs with no view tree — has something to fetch with.
	private var context: Context?

	struct Context {
		var api: any MapleAPI
		var organizationId: String
		var organizationName: String?
	}

	init(
		issuesStore: WidgetSnapshotStore<IssuesSnapshot> = .issues,
		throughputStore: WidgetSnapshotStore<ThroughputSnapshot> = .throughput
	) {
		self.issuesStore = issuesStore
		self.throughputStore = throughputStore
	}

	/// Called whenever the signed-in organization is known or changes.
	func configure(api: any MapleAPI, organizationId: String, organizationName: String?) {
		let isNewOrganization = context?.organizationId != organizationId
		context = Context(api: api, organizationId: organizationId, organizationName: organizationName)
		// A switch invalidates both the throttle and whatever is on the Home
		// Screen: those numbers belong to the org the user just left.
		if isNewOrganization { lastRefreshedAt = nil }
	}

	/// Fetch and publish both snapshots.
	///
	/// Silent by design — the widgets are a side effect of using the app, and a
	/// failure here must never surface as an error on a screen the user did not
	/// ask to refresh. The last good snapshot stays and the widget ages it
	/// honestly. The two halves are independent: throughput failing must not
	/// cost the Home Screen its issue list.
	func refresh(force: Bool = false) async {
		guard let context else { return }
		if !force, let lastRefreshedAt, Date().timeIntervalSince(lastRefreshedAt) < Self.minimumInterval { return }
		lastRefreshedAt = Date()

		async let issues: Void = refreshIssues(context)
		async let throughput: Void = refreshThroughput(context)
		_ = await (issues, throughput)
	}

	/// Sign-out. The widgets outlive the session, so the previous account's
	/// failures and traffic must not stay legible on the lock screen.
	func clear() {
		context = nil
		lastRefreshedAt = nil
		issuesStore.clear()
		throughputStore.clear()
		WidgetCenter.shared.reloadAllTimelines()
	}

	// MARK: Issues

	private func refreshIssues(_ context: Context) async {
		guard
			let page = try? await context.api.issues(
				query: IssueQuery(actionableOnly: true, sort: .severity),
				window: Self.issuesWindow.resolve(),
				limit: Self.issueFetchLimit,
				cursor: nil
			)
		else { return }

		let snapshot = IssuesSnapshot.make(
			organizationId: context.organizationId,
			organizationName: context.organizationName,
			generatedAt: Date(),
			issues: page.items.map(WidgetIssue.init(issue:)),
			hasMore: page.hasMore
		)
		guard issuesStore.save(snapshot) else { return }
		// Reload rather than wait for the next timeline entry: the whole point
		// of publishing from the app is that the Home Screen updates the moment
		// the app learns something.
		WidgetCenter.shared.reloadTimelines(ofKind: IssuesWidgetKind.identifier)
	}

	// MARK: Throughput

	private func refreshThroughput(_ context: Context) async {
		let window = Self.throughputWindow.resolve()

		// Three requests, not one per service: `group_by: service` returns
		// every service's shape at once, and the ungrouped total covers the
		// traffic of services past the series limit — summing only the grouped
		// series would quietly under-report a big org's throughput.
		async let servicesTask = context.api.services(window: window, limit: Self.serviceFetchLimit)
		async let groupedTask = context.api.traceTimeseries(
			TraceTimeseriesRequest(
				aggregation: .count,
				window: window,
				groupBy: .service,
				seriesLimit: ThroughputSnapshot.maximumServices
			)
		)
		async let totalTask = context.api.traceTimeseries(
			TraceTimeseriesRequest(aggregation: .count, window: window)
		)

		guard let services = try? await servicesTask.items else { return }
		let grouped = try? await groupedTask
		let total = try? await totalTask

		let rows = services.map { service in
			ServiceThroughput(
				name: service.name,
				throughputPerSecond: service.throughput,
				errorRate: service.errorRate,
				p95LatencyMs: service.p95LatencyMs,
				points: Self.perSecond(grouped?.valuesByGroup[service.name] ?? [], bucketSeconds: grouped?.bucketSeconds)
			)
		}

		// The total's *numbers* come from the service list (every service, not
		// just the charted ones); only its shape comes from the ungrouped
		// series, which is the one thing the list cannot provide.
		var overall = ServiceThroughput.total(of: rows)
		if let total {
			overall.points = Self.perSecond(total.values, bucketSeconds: total.bucketSeconds)
		}

		let snapshot = ThroughputSnapshot.make(
			organizationId: context.organizationId,
			generatedAt: Date(),
			windowMinutes: Int(Self.throughputWindow.duration / 60),
			services: rows,
			overall: overall
		)
		guard throughputStore.save(snapshot) else { return }
		WidgetCenter.shared.reloadTimelines(ofKind: ThroughputWidgetKind.identifier)
	}

	/// Spans per bucket → spans per second, so the sparkline carries the same
	/// unit as the headline. A missing or nonsensical bucket length leaves the
	/// series out rather than drawing counts as if they were rates.
	private static func perSecond(_ values: [Double], bucketSeconds: Int?) -> [Double] {
		guard let bucketSeconds, bucketSeconds > 0 else { return [] }
		return values.map { $0 / Double(bucketSeconds) }
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

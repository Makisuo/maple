import Foundation
import Maple
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

	/// How many organizations one round may publish.
	///
	/// One organization costs four requests. Publishing every membership would
	/// be 48 for an account in twelve — most of them for organizations nobody
	/// put on a Home Screen — and iOS answers that kind of appetite with less
	/// background time, so the widgets would end up *less* current. The set is
	/// driven by what is actually placed instead; see `organizationsToPublish`.
	private static let maximumOrganizations = 3
	/// Organizations in flight at once: three organizations means six sockets
	/// open, not twelve. Pairwise, so changing this means changing the loop in
	/// `refresh` too.
	private static let maximumConcurrentOrganizations = 2

	private let index: PublishedOrganizationIndex
	private var lastRefreshedAt: Date?
	/// Set once the app knows who is signed in, so the background task — which
	/// runs with no view tree — has something to fetch with.
	private var context: Context?

	struct Context {
		/// Unscoped. Each organization fetches through `api.scoped(to:)`; the
		/// client itself stays on the token's own claim.
		var api: any MapleAPI
		var active: PublishedOrganization
		/// Every organization the user belongs to, for widgets pinned to one
		/// that is not active.
		var memberships: [PublishedOrganization]
	}

	/// What asked for this refresh. Recorded on every `widget.refresh` span,
	/// because the interesting question about the Home Screen is which of the
	/// four paths actually keeps it current — and `background` answering rarely
	/// is exactly what iOS not granting background time looks like.
	enum Trigger: String {
		case foreground
		case organization
		case push
		case background
	}

	init(index: PublishedOrganizationIndex = PublishedOrganizationIndex()) {
		self.index = index
	}

	/// Called whenever the signed-in organization, or the set the user belongs
	/// to, is known or changes.
	func configure(
		api: any MapleAPI,
		organizationId: String,
		organizationName: String?,
		memberships: [PublishedOrganization] = []
	) {
		let isNewOrganization = context?.active.id != organizationId
		let active = PublishedOrganization(
			id: organizationId,
			name: organizationName,
			lastPublishedAt: .distantPast
		)
		context = Context(
			api: api,
			active: active,
			memberships: memberships.isEmpty ? [active] : memberships
		)
		// A switch invalidates the throttle: the numbers on the Home Screen
		// belong to the organization the user just left.
		if isNewOrganization { lastRefreshedAt = nil }
	}

	/// One `reloadAllTimelines` after an update that changed how widgets resolve
	/// their organization.
	///
	/// A widget migrated from the pre-picker build keeps rendering its last
	/// cached view until iOS decides to rebuild the timeline, which can be an
	/// hour. This makes it pick up an organization at once. Keyed on the build
	/// version so it happens once per install of a new build, not once per
	/// launch.
	func reloadIfNewBuild(version: String) {
		let defaults = UserDefaults.standard
		let key = "widgets.reloadedForBuild"
		guard defaults.string(forKey: key) != version else { return }
		defaults.set(version, forKey: key)
		WidgetCenter.shared.reloadAllTimelines()
	}

	/// Drop every organization the user is no longer a member of, snapshots and
	/// all.
	///
	/// **Verified lists only.** `SessionController.membershipsLoaded` is false
	/// when the list came from Clerk's client payload, which can be partial —
	/// pruning against that would wipe live organizations.
	func prune(to memberIds: Set<String>) {
		let evicted = index.prune(to: memberIds)
		// Nothing changed on the common path — this runs on every launch and every
		// organization switch, and `reloadAllTimelines` spends the widget refresh
		// budget iOS is metering.
		guard !evicted.isEmpty else { return }
		for organizationId in evicted {
			WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organizationId).clear()
			WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organizationId).clear()
		}
		WidgetCenter.shared.reloadAllTimelines()
	}

	/// Fetch and publish both snapshots.
	///
	/// Silent by design — the widgets are a side effect of using the app, and a
	/// failure here must never surface as an error on a screen the user did not
	/// ask to refresh. The last good snapshot stays and the widget ages it
	/// honestly. The two halves are independent: throughput failing must not
	/// cost the Home Screen its issue list.
	func refresh(trigger: Trigger, force: Bool = false) async {
		guard let context else { return }
		if !force, let lastRefreshedAt, Date().timeIntervalSince(lastRefreshedAt) < Self.minimumInterval { return }
		lastRefreshedAt = Date()

		let organizations = await organizationsToPublish(context, trigger: trigger)

		await Telemetry.span(
			Telemetry.Name.widgetRefresh,
			attributes: [
				Telemetry.Key.widgetTrigger: .string(trigger.rawValue),
				Telemetry.Key.organizationId: .string(context.active.id),
				Telemetry.Key.widgetOrganizationCount: .int(Int64(organizations.count)),
			]
		) { _ in
			let rounds = organizations.map { organization in
				PublishRound(
					organization: organization,
					api: context.api.scoped(to: organization.id),
					isActive: organization.id == context.active.id
				)
			}

			// Two organizations in flight, in pairs. Everything here is already
			// on the main actor and the concurrency that matters is the awaits
			// inside `publish`, so this is `async let` rather than a task group —
			// which also keeps the whole round on one actor rather than making
			// `Context` `Sendable` for no gain.
			var index = rounds.startIndex
			while index < rounds.endIndex {
				let first = rounds[index]
				let second = rounds.indices.contains(index + 1) ? rounds[index + 1] : nil
				index += Self.maximumConcurrentOrganizations

				async let firstDone: Void = self.publish(first)
				if let second {
					async let secondDone: Void = self.publish(second)
					_ = await (firstDone, secondDone)
				} else {
					await firstDone
				}
			}
		}
	}

	/// Everything one organization's round needs, and nothing that is not
	/// `Sendable` — `Context` holds the unscoped client and stays on the main
	/// actor.
	private struct PublishRound: Sendable {
		let organization: PublishedOrganization
		let api: any MapleAPI
		let isActive: Bool
	}

	/// One organization's round: both surfaces, then record it in the index the
	/// widget extension reads.
	private func publish(_ round: PublishRound) async {
		async let issues: Void = refreshIssues(round.organization, api: round.api)
		async let throughput: Void = refreshThroughput(round.organization, api: round.api)
		_ = await (issues, throughput)

		index.record(
			PublishedOrganization(
				id: round.organization.id,
				name: round.organization.name,
				lastPublishedAt: Date()
			),
			isActive: round.isActive
		)
	}

	/// Which organizations this round covers.
	///
	/// Driven by what is actually on a Home Screen, not by the membership list:
	/// fetching for an organization nobody pinned is battery spent to make iOS
	/// trust the app less. The active organization is always first and always
	/// included — `getCurrentConfigurations` returns nothing at all right after
	/// boot, and that must never be able to *shrink* the set below the
	/// organization the user is looking at.
	private func organizationsToPublish(
		_ context: Context,
		trigger: Trigger
	) async -> [PublishedOrganization] {
		let pinned = await pinnedOrganizationIds()
		// Read once. Inside the comparator this decoded the whole index from
		// UserDefaults on every comparison.
		let publishedAt = Dictionary(
			index.load().map { ($0.id, $0.lastPublishedAt) },
			uniquingKeysWith: { first, _ in first }
		)
		let others = context.memberships
			.filter { $0.id != context.active.id && pinned.contains($0.id) }
			// Oldest first, so a background round that can only afford one
			// extra organization round-robins rather than starving one.
			.sorted {
				publishedAt[$0.id] ?? .distantPast < publishedAt[$1.id] ?? .distantPast
			}

		// A `BGAppRefreshTask` gets tens of seconds; twelve requests inside one
		// is how the whole chain gets deprioritized.
		let budget = trigger == .background ? 1 : Self.maximumOrganizations - 1
		return [context.active] + others.prefix(budget)
	}

	/// The organizations the user actually pinned a widget to.
	private func pinnedOrganizationIds() async -> Set<String> {
		guard let configurations = try? await WidgetCenter.shared.currentConfigurations() else { return [] }
		var ids: Set<String> = []
		for info in configurations {
			if let intent = info.widgetConfigurationIntent(of: SelectOrganizationIntent.self),
				let id = intent.organization?.id
			{
				ids.insert(id)
			}
			if let intent = info.widgetConfigurationIntent(of: SelectServiceIntent.self),
				let id = intent.organization?.id
			{
				ids.insert(id)
			}
		}
		return ids
	}

	/// One surface's fetch-and-publish, as a child of the refresh.
	///
	/// Both halves are silent by design — a widget must never surface an error
	/// on a screen nobody asked to refresh — which before this made a widget
	/// stuck on yesterday's numbers completely undiagnosable. The span carries
	/// what the UI deliberately swallows.
	private func snapshot(_ surface: String, _ body: @MainActor @Sendable @escaping () async -> Bool) async {
		await Telemetry.span(
			Telemetry.Name.widgetSnapshot,
			attributes: [Telemetry.Key.widgetSurface: .string(surface)]
		) { span in
			let published = await body()
			span?.setStatus(published ? .ok : .error("snapshot not published"))
		}
	}

	/// Sign-out. The widgets outlive the session, so the previous account's
	/// failures and traffic must not stay legible on the lock screen.
	func clear() {
		context = nil
		lastRefreshedAt = nil
		// Every organization, not just the active one: anything left behind
		// stays readable on the Home Screen of a phone that has been signed out.
		for organizationId in index.clear() {
			WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organizationId).clear()
			WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organizationId).clear()
		}
		// The pre-per-organization keys too. They are not in the index — nothing
		// published them — so iterating it alone would leave a widget placed
		// before this shipped rendering the signed-out account's issues.
		WidgetSnapshotStore<IssuesSnapshot>.legacyIssues.clear()
		WidgetSnapshotStore<ThroughputSnapshot>.legacyThroughput.clear()
		WidgetCenter.shared.reloadAllTimelines()
	}

	// MARK: Issues

	private func refreshIssues(_ organization: PublishedOrganization, api: any MapleAPI) async {
		await snapshot("issues") { await self.publishIssues(organization, api: api) }
	}

	private func publishIssues(_ organization: PublishedOrganization, api: any MapleAPI) async -> Bool {
		guard
			let page = try? await api.issues(
				query: IssueQuery(actionableOnly: true, sort: .severity),
				window: Self.issuesWindow.resolve(),
				limit: Self.issueFetchLimit,
				cursor: nil
			)
		else { return false }

		let snapshot = IssuesSnapshot.make(
			organizationId: organization.id,
			organizationName: organization.name,
			generatedAt: Date(),
			issues: page.items.map(WidgetIssue.init(issue:)),
			hasMore: page.hasMore
		)
		guard WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organization.id).save(snapshot)
		else { return false }
		// Reload rather than wait for the next timeline entry: the whole point
		// of publishing from the app is that the Home Screen updates the moment
		// the app learns something.
		WidgetCenter.shared.reloadTimelines(ofKind: IssuesWidgetKind.identifier)
		return true
	}

	// MARK: Throughput

	private func refreshThroughput(_ organization: PublishedOrganization, api: any MapleAPI) async {
		await snapshot("throughput") { await self.publishThroughput(organization, api: api) }
	}

	private func publishThroughput(_ organization: PublishedOrganization, api: any MapleAPI) async -> Bool {
		let window = Self.throughputWindow.resolve()

		// Three requests, not one per service: `group_by: service` returns
		// every service's shape at once, and the ungrouped total covers the
		// traffic of services past the series limit — summing only the grouped
		// series would quietly under-report a big org's throughput.
		async let servicesTask = api.services(window: window, limit: Self.serviceFetchLimit)
		async let groupedTask = api.traceTimeseries(
			TraceTimeseriesRequest(
				aggregation: .count,
				window: window,
				groupBy: .service,
				seriesLimit: ThroughputSnapshot.maximumServices
			)
		)
		async let totalTask = api.traceTimeseries(
			TraceTimeseriesRequest(aggregation: .count, window: window)
		)

		guard let services = try? await servicesTask.items else { return false }
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
			organizationId: organization.id,
			generatedAt: Date(),
			windowMinutes: Int(Self.throughputWindow.duration / 60),
			services: rows,
			overall: overall
		)
		guard
			WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organization.id).save(snapshot)
		else { return false }
		WidgetCenter.shared.reloadTimelines(ofKind: ThroughputWidgetKind.identifier)
		return true
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

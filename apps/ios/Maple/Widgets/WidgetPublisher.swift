import ClerkKit
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
///
/// The last two are the ones that keep a Home Screen current on a phone in a
/// pocket, and they run with no view tree — so the session they fetch with comes
/// from `bootstrap`, not `configure`. See there for what that fixes.
///
/// Publishing is not the same as reloading. iOS meters `WidgetCenter` reloads,
/// and the widgets' own timelines are drawn from the same budget, so a round
/// only spends a reload on a kind whose numbers a reader could actually see
/// change — one per kind at most, however many organizations it covered. See
/// `WidgetReloadDecision`.
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

	private let index: WidgetOrganizationIndex
	private var lastRefreshedAt: Date?
	/// Something other than a snapshot's contents changed what the widgets
	/// would render — a corrected name, or a newly known organization. Set
	/// outside a round, consumed by the next one; see `refresh`.
	private var resolutionChanged = false
	/// Set once the app knows who is signed in — from the view tree by
	/// `configure`, or at launch by `bootstrap`, which is the only one of the
	/// two a background launch gets.
	private var context: Context?

	struct Context {
		/// Unscoped. Each organization fetches through `api.scoped(to:)`; the
		/// client itself stays on the token's own claim.
		var api: any MapleAPI
		var active: WidgetOrganization
		/// Every organization the user belongs to, for widgets pinned to one
		/// that is not active.
		var memberships: [WidgetOrganization]
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

	init(index: WidgetOrganizationIndex = WidgetOrganizationIndex()) {
		self.index = index
	}

	/// The context a launch with **no view tree** can assemble for itself.
	///
	/// This is the fix for the quietest bug the widgets had: `configure` is
	/// reached only from `MainTabView`, so when iOS woke the app for a
	/// `BGAppRefreshTask` or a silent push after it had been terminated, there
	/// was no view tree, no context, and `refresh` returned at its first guard.
	/// The two triggers that exist precisely to keep the Home Screen current
	/// while the app is closed only ever worked when the app happened to still
	/// be alive in memory — which is most of what "the widgets don't update"
	/// was.
	///
	/// Everything it needs is already on disk by the end of `MapleApp.init`:
	/// Clerk restores its session from the keychain synchronously during
	/// `configure(publishableKey:)`, and the App Group index carries the
	/// organizations the app has published before.
	///
	/// Sign-out needs no separate flag. `clear()` empties the index, so the
	/// `published.contains` check below fails and a signed-out install cannot
	/// resurrect a context on its next background wake.
	func bootstrap(api: any MapleAPI) {
		// The view tree always knows better — this only ever fills a gap.
		guard context == nil else { return }
		let published = index.load()
		guard
			let organizationId = Clerk.shared.session?.lastActiveOrganizationId,
			let organization = published.first(where: { $0.id == organizationId })
		else { return }
		// Memberships are the published set rather than Clerk's full list, which
		// costs nothing: `organizationsToPublish` intersects with what is
		// actually pinned anyway, and a background round's budget is one extra
		// organization.
		context = Context(api: api, active: organization, memberships: published)
	}

	/// Called whenever the signed-in organization, or the set the user belongs
	/// to, is known or changes.
	///
	/// There is deliberately no `organizationName` parameter. It used to take
	/// one, filled from `Clerk.shared.organization` while the id came from the
	/// session's active-organization claim — two sources that disagree while a
	/// `setActive` settles, or when the client payload is partial. The index
	/// then held organization B's id under organization A's name: the picker
	/// showed two rows reading "A", and the widget put A's name over B's
	/// numbers. Names come from `memberships`, which is keyed by id.
	///
	/// - Parameter membershipsVerified: false when the list came from Clerk's
	///   client payload, which can be partial. Only a verified list may be
	///   written to the index — the same rule `prune` documents.
	func configure(
		api: any MapleAPI,
		organizationId: String,
		memberships: [WidgetOrganization] = [],
		membershipsVerified: Bool = false
	) {
		let isNewOrganization = context?.active.id != organizationId
		let active = WidgetOrganization(
			id: organizationId,
			name: WidgetOrganizationIndex.resolveName(
				id: organizationId,
				memberships: memberships,
				existing: index.load()
			)
		)
		context = Context(
			api: api,
			active: active,
			memberships: memberships.isEmpty ? [active] : memberships
		)
		// Every membership goes into the index, not just the ones a round will
		// fetch for: the picker reads it, and an organization the app has never
		// published for still has to be pickable. Additive — `prune` runs next
		// and is what removes, because removal has snapshots to wipe with it.
		if membershipsVerified, index.record(memberships: memberships) {
			resolutionChanged = true
		}
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

		let plan = await organizationsToPublish(context, trigger: trigger)
		let organizations = plan.organizations
		// A widget with no configuration — every instance migrated from before
		// the picker — resolves through the index's active organization, so a
		// switch changes what it renders without changing any snapshot's
		// contents. The per-kind decision below compares one organization's new
		// snapshot against its own stored one, and cannot see that.
		let previousActiveId = index.activeOrganizationId
		// Read once. Every read decodes the whole index out of `UserDefaults`.
		let known = index.load()

		await Telemetry.span(
			Telemetry.Name.widgetRefresh,
			attributes: [
				Telemetry.Key.widgetTrigger: .string(trigger.rawValue),
				Telemetry.Key.organizationId: .string(context.active.id),
				Telemetry.Key.widgetOrganizationCount: .int(Int64(organizations.count)),
				// How many widgets are actually placed, and how many
				// organizations the picker can offer. `currentConfigurations()`
				// failing is indistinguishable from "nothing pinned" at the
				// call site, and both silently narrow a round.
				Telemetry.Key.widgetPinnedCount: .int(Int64(plan.pinnedCount)),
				Telemetry.Key.widgetKnownOrganizationCount: .int(Int64(known.count)),
			]
		) { span in
			let rounds = organizations.map { organization in
				PublishRound(
					// Resolved again here, not taken as assembled: this name is
					// baked into `IssuesSnapshot.organizationName`, and a
					// snapshot that carries the wrong organization's name
					// outlives every correction until the next round.
					organization: WidgetOrganization(
						id: organization.id,
						name: WidgetOrganizationIndex.resolveName(
							id: organization.id,
							memberships: context.memberships,
							existing: known
						),
						lastPublishedAt: organization.lastPublishedAt
					),
					api: context.api.scoped(to: organization.id),
					isActive: organization.id == context.active.id
				)
			}

			// Two organizations in flight, in pairs. Everything here is already
			// on the main actor and the concurrency that matters is the awaits
			// inside `publish`, so this is `async let` rather than a task group —
			// which also keeps the whole round on one actor rather than making
			// `Context` `Sendable` for no gain.
			var outcome = RoundOutcome()
			// `cursor`, not `index`: `self.index` is the organization index and
			// is read again below, and a shadow here would resolve to an `Int`.
			var cursor = rounds.startIndex
			while cursor < rounds.endIndex {
				let first = rounds[cursor]
				let second = rounds.indices.contains(cursor + 1) ? rounds[cursor + 1] : nil
				cursor += Self.maximumConcurrentOrganizations

				async let firstDone = self.publish(first)
				if let second {
					async let secondDone = self.publish(second)
					let (left, right) = await (firstDone, secondDone)
					outcome.merge(left)
					outcome.merge(right)
				} else {
					outcome.merge(await firstDone)
				}
			}

			// **One reload per kind, per round, and only when something a reader
			// could see has changed.**
			//
			// This used to fire inside each surface's publish, so a three-organization
			// round spent six — and `reloadTimelines(ofKind:)` rebuilds *every*
			// instance of that kind, so publishing organization B was also
			// dragging organization A's pinned widget through a rebuild with no
			// new data for it. iOS meters reloads, that budget is shared with the
			// timeline rebuilds that keep the widget alive while the app is
			// closed, and spending it on identical redraws is what left the Home
			// Screen looking frozen for the rest of the day.
			// Not only "did the numbers move". If the widgets would now resolve
			// a different organization, or render a name that has just been
			// corrected, every instance is wrong until it rebuilds — and both
			// are things the user just did, which is when a reload is most
			// worth its budget. Both are guarded on an actual change, so a
			// quiet launch still spends nothing.
			let resolutionMoved = self.resolutionChanged || self.index.activeOrganizationId != previousActiveId
			self.resolutionChanged = false
			outcome.issuesChanged = outcome.issuesChanged || resolutionMoved
			outcome.throughputChanged = outcome.throughputChanged || resolutionMoved

			var reloads = 0
			if outcome.issuesChanged {
				WidgetCenter.shared.reloadTimelines(ofKind: IssuesWidgetKind.identifier)
				reloads += 1
			}
			if outcome.throughputChanged {
				WidgetCenter.shared.reloadTimelines(ofKind: ThroughputWidgetKind.identifier)
				reloads += 1
			}
			span?.setAttribute(Telemetry.Key.widgetReloadCount, reloads)
			span?.setAttribute(Telemetry.Key.widgetResolutionChanged, resolutionMoved)
		}
	}

	/// What a whole round decided, folded across its organizations: if any one
	/// of them has news, that kind reloads once for all of them.
	private struct RoundOutcome {
		var issuesChanged = false
		var throughputChanged = false

		mutating func merge(_ other: (issues: PublishOutcome, throughput: PublishOutcome)) {
			issuesChanged = issuesChanged || other.issues == .changed
			throughputChanged = throughputChanged || other.throughput == .changed
		}
	}

	/// One surface's result. `unchanged` is a success that deliberately costs no
	/// reload; `failed` is the fetch or the save going wrong.
	private enum PublishOutcome: Sendable {
		case failed
		case unchanged
		case changed
	}

	/// Everything one organization's round needs, and nothing that is not
	/// `Sendable` — `Context` holds the unscoped client and stays on the main
	/// actor.
	private struct PublishRound: Sendable {
		let organization: WidgetOrganization
		let api: any MapleAPI
		let isActive: Bool
	}

	/// One organization's round: both surfaces, then record it in the index the
	/// widget extension reads.
	private func publish(_ round: PublishRound) async -> (issues: PublishOutcome, throughput: PublishOutcome) {
		async let issues = refreshIssues(round.organization, api: round.api)
		async let throughput = refreshThroughput(round.organization, api: round.api)
		let outcome = await (issues: issues, throughput: throughput)

		// Only a round that actually published stamps the time. It used to
		// stamp unconditionally, which made a repeatedly failing organization
		// look freshly published to the oldest-first ordering in
		// `organizationsToPublish` — so the one organization that needed
		// another attempt was the one that stopped getting them.
		let published = outcome.issues != .failed || outcome.throughput != .failed
		index.record(
			WidgetOrganization(
				id: round.organization.id,
				name: round.organization.name,
				lastPublishedAt: published ? Date() : round.organization.lastPublishedAt
			),
			isActive: round.isActive
		)
		return outcome
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
	) async -> (organizations: [WidgetOrganization], pinnedCount: Int) {
		let pinned = await pinnedOrganizationIds()
		// Read once. Inside the comparator this decoded the whole index from
		// UserDefaults on every comparison.
		// Never-published organizations are simply absent, so they fall to
		// `.distantPast` below and sort first — which is what a newly pinned
		// organization with an empty widget needs.
		let publishedAt = Dictionary(
			index.load().compactMap { organization in
				organization.lastPublishedAt.map { (organization.id, $0) }
			},
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
		return ([context.active] + others.prefix(budget), pinned.count)
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
	private func snapshot(
		_ surface: String,
		_ body: @MainActor @Sendable @escaping () async -> PublishOutcome
	) async -> PublishOutcome {
		await Telemetry.span(
			Telemetry.Name.widgetSnapshot,
			attributes: [Telemetry.Key.widgetSurface: .string(surface)]
		) { span in
			let outcome = await body()
			span?.setStatus(outcome == .failed ? .error("snapshot not published") : .ok)
			// The other half of the reload-budget story: a round of all-`false`
			// here is the widget correctly staying put, not the publisher
			// failing, and the two are indistinguishable without this.
			span?.setAttribute(Telemetry.Key.widgetChanged, outcome == .changed)
			return outcome
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

	private func refreshIssues(_ organization: WidgetOrganization, api: any MapleAPI) async -> PublishOutcome {
		await snapshot("issues") { await self.publishIssues(organization, api: api) }
	}

	private func publishIssues(_ organization: WidgetOrganization, api: any MapleAPI) async -> PublishOutcome {
		guard
			let page = try? await api.issues(
				query: IssueQuery(actionableOnly: true, sort: .severity),
				window: Self.issuesWindow.resolve(),
				limit: Self.issueFetchLimit,
				cursor: nil
			)
		else { return .failed }

		let now = Date()
		let snapshot = IssuesSnapshot.make(
			organizationId: organization.id,
			organizationName: organization.name,
			generatedAt: now,
			issues: page.items.map(WidgetIssue.init(issue:)),
			hasMore: page.hasMore
		)
		let store = WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organization.id)
		// Read before writing: the reload decision is "does this differ from
		// what is on screen", and after the save there is nothing to compare to.
		let stored = store.load()
		// Saved unconditionally even when nothing changed, so `generatedAt`
		// advances and the widget's footer is honest the next time it is built
		// for any reason.
		guard store.save(snapshot) else { return .failed }
		return WidgetReloadDecision.shouldReload(
			stored: stored,
			incoming: snapshot,
			storedIsStale: stored?.isStale(at: now) ?? false
		) ? .changed : .unchanged
	}

	// MARK: Throughput

	private func refreshThroughput(_ organization: WidgetOrganization, api: any MapleAPI) async -> PublishOutcome {
		await snapshot("throughput") { await self.publishThroughput(organization, api: api) }
	}

	private func publishThroughput(_ organization: WidgetOrganization, api: any MapleAPI) async -> PublishOutcome {
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

		guard let services = try? await servicesTask.items else { return .failed }
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

		let now = Date()
		let snapshot = ThroughputSnapshot.make(
			organizationId: organization.id,
			generatedAt: now,
			windowMinutes: Int(Self.throughputWindow.duration / 60),
			services: rows,
			overall: overall
		)
		let store = WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organization.id)
		let stored = store.load()
		guard store.save(snapshot) else { return .failed }
		// Throughput is the surface where suppression earns the most: its floats
		// differ on every fetch, but `contentFingerprint` compares the rendered
		// strings, so a rate that still reads "12.5/s" costs nothing.
		return WidgetReloadDecision.shouldReload(
			stored: stored,
			incoming: snapshot,
			storedIsStale: stored?.isStale(at: now) ?? false
		) ? .changed : .unchanged
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

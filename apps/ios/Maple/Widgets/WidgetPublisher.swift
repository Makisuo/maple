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
/// One organization costs **one request**, `GET /v2/widget_summary`. It used to
/// cost four, composed here, and the composition was the problem: a
/// `BGAppRefreshTask` gets tens of seconds, and four round-trips per
/// organization is how a background round runs out of them having written
/// nothing. The shape that comes back — `WidgetSummaryPayload` — is the same
/// one the widgets will decode for themselves, so the app and the Home Screen
/// cannot drift apart about what a row says.
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

	/// The windows, the page sizes, and the ranking all belong to
	/// `/v2/widget_summary` now. They used to live here as five constants that
	/// had to agree with what the widgets rendered — "ongoing" and "right now"
	/// are product definitions, and two App Store builds holding different
	/// opinions about them is exactly the drift the endpoint removes.
	///
	/// Foreground, push, and background refresh can all fire within a second
	/// of each other. One round per minute is plenty for a surface iOS redraws
	/// every fifteen.
	private static let minimumInterval: TimeInterval = 60

	/// How many organizations one round may publish.
	///
	/// Publishing every membership would fetch for a dozen organizations nobody
	/// put on a Home Screen, and iOS answers that kind of appetite with less
	/// background time — so the widgets would end up *less* current. The set is
	/// driven by what is actually placed instead; see `organizationsToPublish`.
	/// It also bounds the credentials a round mints, which is the more important
	/// ceiling now: each one is a bearer token that then has to be revoked.
	private static let maximumOrganizations = 3

	private let index: WidgetOrganizationIndex
	/// Where the widgets' own credential lives — a file in the shared App Group
	/// container, written here and read by the extension.
	private let credentials = WidgetCredentialStore()
	/// What the extension records about its own fetches — the only way to see a
	/// path that has no telemetry of its own. Read on the way past; written by
	/// the widget.
	private let fetchStates = WidgetFetchStateStore()
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
		let api = context?.api
		let installationId = AppInstallation.identifier
		for organizationId in evicted {
			WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organizationId).clear()
			WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organizationId).clear()
			credentials.clear(organizationId: organizationId)
			fetchStates.clear(organizationId: organizationId)
			// Server-side too, and not only locally: deleting the file stops this
			// phone using the credential, but the credential itself would stay live
			// until it expired. Best effort — it is bound to an organization the
			// user has just left, so a failure here is a token that outlives its
			// usefulness by up to a month, not one that outlives the membership.
			if let api {
				Task { try? await api.scoped(to: organizationId).revokeWidgetCredential(installationId: installationId) }
			}
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

			// Sequential, which it did not used to be.
			//
			// A round was two organizations in flight at a time, in pairs, because
			// one organization cost four requests and three of them cost twelve.
			// One organization is now one request, so the whole round is at most
			// three — and a plain loop is worth more than the overlap: it keeps
			// everything on the main actor, which is where `Context` and the
			// organization index already live.
			var outcome = RoundOutcome()
			for round in rounds {
				outcome.merge(await self.publish(round))
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

			await self.ensureCredentials(for: organizations, context: context)
			self.drainFetchState(for: context.active.id, onto: span)

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

	/// One organization's round: one request covering both surfaces, then record
	/// it in the index the widget extension reads.
	private func publish(_ round: PublishRound) async -> (issues: PublishOutcome, throughput: PublishOutcome) {
		let outcome = await publishSummary(round.organization, api: round.api)

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

	/// Put the widget extension's own last fetch on this round's span.
	///
	/// The extension is otherwise invisible: it links `MapleWidgetData` and
	/// nothing else, so it has no tracer, and a fetch that fails there fails in
	/// complete silence — which is precisely the shape of the bug that left the
	/// Home Screen frozen before any of this. The app is the only process here
	/// that can reach a collector, so it reads what the widget wrote and says it
	/// out loud.
	///
	/// The active organization only: a round already carries one organization id,
	/// and fanning these attributes across three would make them unreadable.
	private func drainFetchState(for organizationId: String, onto span: Span?) {
		let state = fetchStates.load(organizationId: organizationId)
		guard let outcome = state.lastOutcome else { return }
		span?.setAttribute(Telemetry.Key.widgetFetchOutcome, outcome.rawValue)
		span?.setAttribute(Telemetry.Key.widgetFetchFailures, state.consecutiveFailures)
		span?.setAttribute(Telemetry.Key.widgetFetchCredentialRejected, state.isCredentialRejected)
		// Absent rather than zero when the extension has never succeeded: "it has
		// not managed one yet" and "the last one was just now" must not read the
		// same.
		if let lastSuccessAt = state.lastSuccessAt {
			span?.setAttribute(
				Telemetry.Key.widgetFetchAgeSeconds,
				Int(Date().timeIntervalSince(lastSuccessAt))
			)
		}
	}

	/// Make sure every organization this round covered has a live credential for
	/// its widgets to fetch with.
	///
	/// Lazy, and only for organizations a round actually covered — which is to
	/// say the active one plus what is pinned. Minting for every membership
	/// would scatter bearer tokens across organizations nobody put on a Home
	/// Screen, each of which then has to be revoked.
	///
	/// Renewal is the app's job and only the app's: a widget credential does not
	/// carry the scope to mint, so it cannot extend its own life. That is why the
	/// renewal window is a week — a phone opened at weekends must not be one bad
	/// Monday from a Home Screen that has gone quiet with no way back.
	private func ensureCredentials(for organizations: [WidgetOrganization], context: Context) async {
		let now = Date()
		let installationId = AppInstallation.identifier
		for organization in organizations {
			let stored = credentials.load(organizationId: organization.id)
			guard stored == nil || stored?.needsRenewal(at: now) == true else { continue }
			await Telemetry.span(
				Telemetry.Name.widgetCredential,
				attributes: [Telemetry.Key.organizationId: .string(organization.id)]
			) { span in
				do {
					let credential = try await context.api
						.scoped(to: organization.id)
						.mintWidgetCredential(installationId: installationId)
					// The server binds a credential to the organization it was minted
					// in and cannot be asked for another. A disagreement here would
					// file one organization's key under another's name, which stays
					// invisible until a widget renders the wrong numbers.
					guard credential.organizationId == organization.id else {
						span?.setStatus(.error("credential organization mismatch"))
						return
					}
					guard self.credentials.save(credential) else {
						span?.setStatus(.error("credential not stored"))
						return
					}
					// A widget that met a 401 stopped fetching on purpose — a
					// rolled credential answers 401 forever, and retrying would
					// spend the whole refresh budget on failures. This is the only
					// thing that can lift that, so it has to happen here and be
					// followed by a reload: otherwise the widget sits on its
					// backoff for hours with a perfectly good credential beside it.
					self.fetchStates.clearCredentialRejection(organizationId: organization.id)
					span?.setAttribute(Telemetry.Key.widgetChanged, true)
					WidgetCenter.shared.reloadAllTimelines()
				} catch is CancellationError {
				} catch {
					// Silent, like everything else here. A failed mint leaves the
					// previous credential in place until it expires, and the widgets
					// keep rendering what the app published — which is what they did
					// before they could fetch at all.
					span?.setStatus(.error("credential not minted"))
				}
			}
		}
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
		let others = context.memberships.filter {
			$0.id != context.active.id && pinned.contains($0.id)
		}

		// There used to be an oldest-first ordering here, so a background round
		// that could only afford one extra organization round-robined rather than
		// starving one. It has been removed rather than kept: `lastPublishedAt` is
		// stamped by this file alone, and the widget extension now refreshes an
		// organization without touching it — so the ordering would rank an
		// organization the widget has been keeping perfectly current as the most
		// starved one in the list. A stale sort key is worse than none.
		//
		// The budget survives for a different reason than it was written for. One
		// organization is one request now, not four, so this is no longer about a
		// `BGAppRefreshTask` running out of time; it is that a warm publish for an
		// organization nobody pinned is battery spent to make iOS trust the app
		// less.
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
		_ body: @MainActor @Sendable @escaping () async -> (issues: PublishOutcome, throughput: PublishOutcome)
	) async -> (issues: PublishOutcome, throughput: PublishOutcome) {
		await Telemetry.span(
			Telemetry.Name.widgetSnapshot,
			attributes: [Telemetry.Key.widgetSurface: .string(surface)]
		) { span in
			let outcome = await body()
			let failed = outcome.issues == .failed && outcome.throughput == .failed
			span?.setStatus(failed ? .error("snapshot not published") : .ok)
			// The other half of the reload-budget story: a round of all-`false`
			// here is the widget correctly staying put, not the publisher
			// failing, and the two are indistinguishable without this.
			span?.setAttribute(
				Telemetry.Key.widgetChanged,
				outcome.issues == .changed || outcome.throughput == .changed
			)
			return outcome
		}
	}

	/// Sign-out. The widgets outlive the session, so the previous account's
	/// failures and traffic must not stay legible on the lock screen.
	func clear() {
		// Captured before the context goes: revoking needs the session that is
		// about to end, and a credential is the one thing here that stays usable
		// after sign-out if nobody tells the server.
		let api = context?.api
		let installationId = AppInstallation.identifier
		context = nil
		lastRefreshedAt = nil
		// The local copies go first and unconditionally. Whatever the network
		// does, this phone must stop being able to fetch as the previous account.
		credentials.clearAll()
		// Every organization, not just the active one: anything left behind
		// stays readable on the Home Screen of a phone that has been signed out.
		for organizationId in index.clear() {
			fetchStates.clear(organizationId: organizationId)
			if let api {
				Task { try? await api.scoped(to: organizationId).revokeWidgetCredential(installationId: installationId) }
			}
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

	// MARK: Publishing

	/// One organization's round: one request, then both snapshots.
	///
	/// The two surfaces are no longer independent — one response means an issues
	/// failure costs throughput too. That is the trade the single request buys,
	/// and it is a small one: a failed round leaves both stored snapshots in
	/// place and the widgets age them honestly, which is what they did for
	/// whichever half failed before.
	private func publishSummary(
		_ organization: WidgetOrganization,
		api: any MapleAPI
	) async -> (issues: PublishOutcome, throughput: PublishOutcome) {
		await snapshot("summary") {
			let failed = (issues: PublishOutcome.failed, throughput: PublishOutcome.failed)
			guard let payload = try? await api.widgetSummary() else { return failed }
			// A payload from a newer server may have changed what an existing
			// field *means*, which is the one thing a tolerant decoder cannot
			// absorb. Keep the last good snapshots rather than render it.
			guard payload.isSupported else { return failed }
			// The scoped client names the organization in a header and the server
			// echoes back the one it resolved. A disagreement means this payload
			// would be written under the wrong organization's key — the same
			// class of error as opening the wrong organization from a
			// notification, and just as invisible once it has happened.
			guard payload.organizationId == organization.id else { return failed }
			return await self.store(payload, for: organization)
		}
	}

	/// Both snapshots from one payload. Returns per-surface outcomes so the
	/// reload budget is still spent per widget kind.
	private func store(
		_ payload: WidgetSummaryPayload,
		for organization: WidgetOrganization
	) async -> (issues: PublishOutcome, throughput: PublishOutcome) {
		// The name comes from the caller (resolved against the membership index),
		// never from the payload — see the endpoint's own note on why it carries
		// no name.
		let issues = payload.issuesSnapshot(organizationName: organization.name)
		let throughput = payload.throughputSnapshot()

		let issuesStore = WidgetSnapshotStore<IssuesSnapshot>.issues(organizationId: organization.id)
		let throughputStore = WidgetSnapshotStore<ThroughputSnapshot>.throughput(organizationId: organization.id)
		// Read before writing: the reload decision is "does this differ from what
		// is on screen", and after the save there is nothing to compare to.
		let storedIssues = issuesStore.load()
		let storedThroughput = throughputStore.load()

		// Saved unconditionally even when nothing changed, so `generatedAt`
		// advances and the footers are honest the next time a widget is built
		// for any reason.
		let issuesSaved = issuesStore.save(issues)
		let throughputSaved = throughputStore.save(throughput)

		let now = payload.generatedAt
		return (
			issues: issuesSaved
				? (WidgetReloadDecision.shouldReload(
					stored: storedIssues,
					incoming: issues,
					storedIsStale: storedIssues?.isStale(at: now) ?? false
				) ? .changed : .unchanged)
				: .failed,
			// Throughput is the surface where suppression earns the most: its
			// floats differ on every fetch, but `contentFingerprint` compares the
			// rendered strings, so a rate that still reads "12.5/s" costs nothing.
			throughput: throughputSaved
				? (WidgetReloadDecision.shouldReload(
					stored: storedThroughput,
					incoming: throughput,
					storedIsStale: storedThroughput?.isStale(at: now) ?? false
				) ? .changed : .unchanged)
				: .failed
		)
	}
}

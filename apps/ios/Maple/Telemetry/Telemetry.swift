import Maple
import MapleAPI
import SwiftUI

/// This app's own instrumentation, in one place.
///
/// Maple's iOS SDK auto-instruments two things: `URLSession` requests, and
/// `UIViewController` appearances. In a SwiftUI app the second one finds
/// nothing — every screen is a `UIHostingController`, which the SDK skips as
/// framework scaffolding — and the first one produces a *root* span per
/// request. So a dashboard load that fans out thirteen calls arrived as
/// thirteen unrelated traces, and a recording had no timeline beside the video.
///
/// Everything below exists to fix that: a name for each screen, a parent span
/// for each load, and spans over the work that happens between screens (launch,
/// auth, a tapped notification, a background widget refresh).
///
/// Conventions, in the order they win:
///
///  1. An OTel semantic-convention key if one exists (`error.type`).
///  2. The SDK's own spelling if it already emits the concept (`screen.name`).
///  3. `maple.app.*` for anything that is only meaningful inside this app —
///     the vendor namespace the rest of the platform uses (`maple.ingest.*` in
///     the Rust gateway, `maple.dashboard.*` in the API).
///
/// Span status is Title Case (`Ok` / `Error`) because that is the literal string
/// the warehouse filters on; the SDK renders `SpanStatus` for us, so nothing
/// here spells it by hand.
enum Telemetry {
	/// Span names. Dotted, lowercase, `<area>.<operation>` — the same shape the
	/// API and the ingest gateway use, so a trace that crosses from the phone
	/// into the backend reads as one vocabulary.
	enum Name {
		/// Process start → first frame.
		static let appLaunch = "app.launch"
		/// The two launch steps that can actually be slow.
		static let clerkConfigure = "auth.clerk_configure"
		static let apiClientInit = "api.client_init"
		/// One screen's data load, and the parent of every request it makes.
		static let screenLoad = "screen.load"
		/// The second pass of a load: decoration fetched after the first paint,
		/// so `screen.load` measures time-to-content and this measures the rest.
		static let screenDecorate = "screen.decorate"
		/// A Clerk session token, cached or freshly minted.
		static let authToken = "auth.token"
		static let authMemberships = "auth.memberships"
		static let authSetActive = "auth.set_active"
		/// A tapped notification, ending when the screen it asked for is loaded.
		static let pushOpen = "push.open"
		static let pushSync = "push.sync"
		static let widgetRefresh = "widget.refresh"
		/// One of the two Home Screen surfaces, inside a refresh.
		static let widgetSnapshot = "widget.snapshot"
		/// Minting or rolling the credential the widget extension fetches with.
		static let widgetCredential = "widget.credential"
		static let liveActivitySubmit = "live_activity.submit"
		static let liveActivityEnd = "live_activity.end"
	}

	enum Key {
		/// The SDK's own key, set on its `ui.screen` spans. Reused rather than
		/// paralleled so one filter answers "everything about the Issue screen".
		static let screenName = "screen.name"
		static let loadReason = "load.reason"
		static let loadOutcome = "load.outcome"
		/// OTel semconv. On a failed load this is the `MapleAPIError` case, not
		/// the message — a message with an id in it is not groupable.
		static let errorType = "error.type"

		static let organizationId = "maple.app.organization_id"
		static let launchPhase = "maple.app.launch.phase"
		static let authSkipCache = "maple.app.auth.skip_cache"
		static let authHasToken = "maple.app.auth.has_token"
		static let membershipCount = "maple.app.auth.membership_count"
		static let pushKind = "maple.app.push.kind"
		static let pushColdStart = "maple.app.push.cold_start"
		static let widgetTrigger = "maple.app.widget.trigger"
		static let widgetOrganizationCount = "maple.app.widget.organization_count"
		static let pushAbandonReason = "maple.app.push.abandon_reason"
		static let pushOrganizationSwitched = "maple.app.push.org_switched"
		static let widgetSurface = "maple.app.widget.surface"
		/// Whether this surface's fetch found anything the widget would draw
		/// differently. False means the round deliberately spent no reload.
		static let widgetChanged = "maple.app.widget.changed"
		/// `WidgetCenter` reloads this round actually spent. iOS meters these,
		/// so a widget that stopped updating is usually this number being too
		/// high on the rounds where nothing happened.
		static let widgetReloadCount = "maple.app.widget.reload_count"
		/// Organizations a placed widget is pinned to. `currentConfigurations()`
		/// failing is indistinguishable from "nothing is pinned" at the call
		/// site, and both silently shrink a round to the active organization.
		static let widgetPinnedCount = "maple.app.widget.pinned_count"
		/// Organizations the picker can offer. Below the account's membership
		/// count means the index write is not reaching it — the bug where an
		/// organization could not be picked until it had been picked.
		static let widgetKnownOrganizationCount = "maple.app.widget.known_organization_count"
		/// The round reloaded because the widgets would resolve a *different*
		/// organization or name, not because any snapshot's numbers moved.
		static let widgetResolutionChanged = "maple.app.widget.resolution_changed"

		// What the widget extension recorded about its *own* fetches. The
		// extension links no telemetry — it carries MapleWidgetData and nothing
		// else — so without these the path that actually keeps the Home Screen
		// current is completely unobservable, which is the failure this whole
		// change exists to fix. Drained by WidgetPublisher on the next round.
		/// How the extension's last fetch ended: success, unauthorized, …
		static let widgetFetchOutcome = "maple.app.widget.fetch.outcome"
		/// Seconds since the extension last fetched successfully. Absent when it
		/// never has, which is a different statement from "a long time ago".
		static let widgetFetchAgeSeconds = "maple.app.widget.fetch.age_seconds"
		static let widgetFetchFailures = "maple.app.widget.fetch.consecutive_failures"
		/// The extension has stopped fetching until the app mints again.
		static let widgetFetchCredentialRejected = "maple.app.widget.fetch.credential_rejected"
		/// How the publisher got its session: the view tree, or a headless
		/// bootstrap in a background launch.
		static let widgetContextSource = "maple.app.widget.context_source"
		static let liveActivityAction = "maple.app.live_activity.action"
	}

	/// Product events. They land inline in the session transcript next to the
	/// replay, which is what turns a video into something readable.
	enum Event {
		static let organizationSwitched = "organization.switched"
		static let timeWindowChanged = "time_window.changed"
		static let environmentChanged = "environment.changed"
		static let screenRefreshed = "screen.refreshed"
		static let issuesFiltered = "issues.filtered"
		static let notificationsPrompted = "notifications.prompted"
		static let pushOpened = "push.opened"
		static let widgetOpened = "widget.opened"
		static let apiFailed = "api.failed"
	}

	static func track(_ event: String, _ properties: [String: String] = [:]) {
		Maple.track(event, properties: properties)
	}

	/// `Maple.span` for this app's `@MainActor` code — which is all of it except
	/// the token provider.
	///
	/// The SDK's own `span` is `nonisolated` and takes a plain closure, so under
	/// `SWIFT_STRICT_CONCURRENCY: complete` a `@MainActor` caller cannot hand it
	/// a body that touches `self`. Spelling the body `@MainActor @Sendable` fixes
	/// that from this side: the closure *value* is then Sendable (so it may be
	/// passed to a nonisolated function) while the closure *body* keeps its
	/// isolation (so it may touch the model it was written next to), and the
	/// compiler inserts the hops.
	///
	/// The one property that has to survive the hop does: the SDK reads the
	/// ambient span from a `TaskLocal` at `URLSessionTask.resume()`, and that is
	/// inherited by everything `body` starts — which is what makes the requests
	/// inside a screen load children of it.
	@discardableResult
	static func span<T: Sendable>(
		_ name: String,
		kind: SpanKind = .internal,
		attributes: [String: AttributeValue] = [:],
		_ body: @MainActor @Sendable @escaping (Span?) async throws -> T
	) async rethrows -> T {
		try await Maple.span(name, kind: kind, attributes: attributes) { span in
			try await body(span)
		}
	}
}

// MARK: - Screen tracking

/// The screen names, spelled once.
///
/// A `String` at each call site drifts — "Issue", "Issue Detail" and "issue"
/// become three screens in the analytics, and nothing tells you they are one.
enum Screen {
	static let home = "Home"
	static let services = "Services"
	static let serviceDetail = "Service"
	static let incidents = "Incidents"
	static let incidentDetail = "Incident"
	static let issues = "Issues"
	static let issueDetail = "Issue"
	static let anomalies = "Anomalies"
	static let anomalyDetail = "Anomaly"
	static let notificationSettings = "Notification Settings"
	static let organizationPicker = "Organization Picker"
}

private struct ScreenSpanModifier: ViewModifier {
	let name: String
	@State private var span: Span?
	@Environment(\.scenePhase) private var scenePhase

	func body(content: Content) -> some View {
		content
			.onAppear {
				// `trackScreen` does two things: opens a `ui.screen` span whose
				// duration is time-on-screen, and emits a `navigation` session
				// event stamped with that span's trace. The event is the wider
				// win — it is what the session transcript is built from.
				span?.end()
				span = Maple.trackScreen(name)
				Telemetry.Visit.began(name, span: span)
			}
			.onDisappear {
				Telemetry.Visit.ended(name, span: span)
				span?.end()
				span = nil
			}
			.onChange(of: scenePhase) { _, phase in
				// The SDK closes every open screen span when the app backgrounds,
				// because neither `onDisappear` nor `viewDidDisappear` fires on the
				// way out — a screen left open overnight used to report one span
				// covering the whole night. Nothing re-opens it from that side: the
				// SDK cannot hand a replacement to a `@State` it cannot see. So the
				// second sitting is opened here.
				//
				// Guarded on `hasEnded` rather than on the phase alone: `.inactive`
				// arrives for the app switcher and Control Center too, and those
				// never reach `didEnterBackground`, so the span is still running and
				// must not be replaced.
				guard phase == .active, let current = span, current.hasEnded else { return }
				Telemetry.Visit.ended(name, span: current)
				span = Maple.trackScreen(name)
				Telemetry.Visit.began(name, span: span)
			}
	}
}

extension View {
	/// Name this screen for tracing and for the session transcript.
	///
	/// Apply it to the screen's outermost view *inside* its `NavigationStack`,
	/// not to the stack: a pushed detail must count as its own appearance, and
	/// a tab's stack never disappears.
	func mapleScreen(_ name: String) -> some View {
		modifier(ScreenSpanModifier(name: name))
	}
}

// MARK: - Cold launch

extension Telemetry {
	/// Process start → first frame.
	///
	/// Deliberately *not* time-to-first-byte or time-to-data: this is the part
	/// the app alone is responsible for, and the screen load that follows is
	/// already its own span. The steps inside it are the two things that can
	/// make a launch slow — reading Clerk's keychain session, and building the
	/// API client — so a regression names itself.
	@MainActor
	enum Launch {
		private static var span: Span?

		static func begin() {
			span = MapleTracing.shared.startSpan(Name.appLaunch)
		}

		/// True until the first frame. A notification tapped while this holds
		/// was tapped on a phone that had to launch the app to answer it, which
		/// is a different number from a tap into an app already running.
		static var isColdStart: Bool { span != nil }

		/// Run a launch step as a child of the launch span.
		///
		/// The span cannot be ambient across `init` — it outlives the call that
		/// started it — so each step re-enters its scope explicitly. Nothing
		/// else on the phone is running yet, so the thread-local write inside
		/// `withSpan` has nobody to race with.
		@discardableResult
		static func step<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
			guard let span else { return try body() }
			return try TraceContext.withSpan(span) {
				try Maple.span(name) { _ in try body() }
			}
		}

		/// The first frame is on screen. Idempotent: `onAppear` on the root view
		/// is once per process today, but a future sheet or scene must not
		/// reopen a launch that already ended.
		static func firstFrame(phase: String) {
			guard let span else { return }
			span.setAttribute(Key.launchPhase, phase)
			span.end()
			self.span = nil
		}
	}
}

// MARK: - A tapped notification

extension Telemetry {
	/// The span from a notification tap to the screen it asked for being loaded.
	///
	/// This is the one number nobody could answer before: an alert fires, a
	/// phone buzzes, someone taps — how long until they can actually read the
	/// incident? The tap happens on the app delegate, outside the view tree,
	/// and the answer only arrives when a screen three layers away finishes
	/// loading, so the span is parked here in between.
	///
	/// While it is parked it is also the *parent* of that screen's load, which
	/// is what makes the trace a single story: tap → screen load → the requests
	/// it made → the API spans they reached.
	@MainActor
	enum PushOpen {
		private struct Pending {
			let span: Span
			let screen: String
			let expiry: Task<Void, Never>
		}

		private static var pending: Pending?

		static func begin(kind: String, screen: String, coldStart: Bool) {
			// A second tap before the first landed: the older one is abandoned,
			// not left open beside it.
			abandon(reason: "superseded")
			let span = MapleTracing.shared.startSpan(
				Name.pushOpen,
				attributes: [
					Key.pushKind: .string(kind),
					Key.screenName: .string(screen),
					Key.pushColdStart: .bool(coldStart),
				]
			)
			guard let span else { return }
			// A tap that never reaches its screen — the incident was deleted, or
			// the user swiped away mid-launch — must not leave a span open for
			// the life of the process, holding a trace id the session keeps
			// pointing at. Thirty seconds is far past any real cold start.
			let expiry = Task {
				try? await Task.sleep(for: .seconds(30))
				guard !Task.isCancelled else { return }
				abandon(reason: "expired")
			}
			pending = Pending(span: span, screen: screen, expiry: expiry)
		}

		/// The span a screen's load should hang under, if this screen is the one
		/// a notification asked for.
		static func parent(for screen: String) -> Span? {
			pending?.screen == screen ? pending?.span : nil
		}

		/// That screen finished loading — the tap is answered.
		static func settled(_ screen: String) {
			guard let pending, pending.screen == screen else { return }
			pending.expiry.cancel()
			pending.span.end()
			self.pending = nil
		}

		/// The tap will never reach its screen. `reason` distinguishes the ways
		/// that happens — a refused organization is a product problem worth
		/// counting; a superseded tap is not.
		static func abandon(reason: String) {
			guard let pending else { return }
			pending.expiry.cancel()
			// Not an error: an abandoned open is a user changing their mind, and
			// marking it `Error` would put it in the error dashboards.
			pending.span.setAttribute("maple.app.push.abandoned", true)
			pending.span.setAttribute(Key.pushAbandonReason, reason)
			pending.span.end()
			self.pending = nil
		}

		/// The tap landed in a different organization than the one on screen, so
		/// answering it cost a `setActive` plus a forced token round-trip. That is
		/// real latency on the alert-to-eyes number and is invisible otherwise.
		static func recordOrganizationSwitch() {
			pending?.span.setAttribute(Key.pushOrganizationSwitched, true)
		}
	}

	/// The open `ui.screen` span for a screen, so a load can hang under the visit
	/// that caused it.
	///
	/// `trackScreen` hands the span back but nothing carries it: the SDK starts it
	/// without making it ambient, and rightly so — a span that lives for the whole
	/// visit is not a scope anything can nest inside. The result was that every
	/// `ui.screen` arrived as a childless root while the load it caused sat in a
	/// trace of its own. Registering by name is the same shape `PushOpen` already
	/// uses to parent a load to the tap that asked for it.
	@MainActor
	enum Visit {
		private static var spans: [String: Span] = [:]

		static func began(_ screen: String, span: Span?) {
			guard let span else { return }
			spans[screen] = span
		}

		static func ended(_ screen: String, span: Span?) {
			guard let span, spans[screen] === span else { return }
			spans.removeValue(forKey: screen)
		}

		/// A span the SDK closed behind our back — backgrounding closes every open
		/// screen span — is not a parent: a child that starts after its parent ended
		/// draws as a bar hanging outside the one above it.
		static func parent(for screen: String) -> Span? {
			guard let span = spans[screen] else { return nil }
			guard !span.hasEnded else {
				spans.removeValue(forKey: screen)
				return nil
			}
			return span
		}
	}
}

// MARK: - Screen loads

extension Telemetry {
	/// Wrap a screen's data load in the span every request it makes hangs under.
	///
	/// This is the whole reason the app traces at all. `HomeModel.fetch` fans
	/// out five concurrent requests and up to eight more for the sparklines;
	/// without a parent those arrive as thirteen unrelated traces and the
	/// question "what did opening Home cost" has no answer. The SDK captures
	/// whatever span is ambient at `URLSessionTask.resume()`, so opening one
	/// here is all it takes — and because `traceparent` goes to `api.maple.dev`,
	/// the API's own server spans join the same trace on the other side.
	@MainActor
	static func screenLoad<Value: Sendable>(
		screen: String,
		reason: LoadReason,
		organizationId: String?,
		_ body: @MainActor @Sendable @escaping () async -> LoadState<Value>?
	) async -> LoadState<Value>? {
		var attributes: [String: AttributeValue] = [
			Key.screenName: .string(screen),
			Key.loadReason: .string(reason.telemetryName),
		]
		if let organizationId { attributes[Key.organizationId] = .string(organizationId) }

		// A tapped notification owns the story when there is one — tap → load →
		// requests. Otherwise the visit does.
		let parent = PushOpen.parent(for: screen) ?? Visit.parent(for: screen)
		let state = await withParent(parent) {
			await Telemetry.span(Name.screenLoad, attributes: attributes) { span in
				let state = await body()
				record(state, on: span)
				return state
			}
		}
		// The screen a tapped notification asked for is now on screen with its
		// data — which is the moment the tap was actually answered.
		PushOpen.settled(screen)
		return state
	}

	/// Wrap a screen's post-paint decoration fetches — Home's issue counts and
	/// sparklines — in their own span.
	///
	/// `screen.load` ends at the first paint now, so these requests need a
	/// parent of their own: hanging them under a span that already ended draws
	/// as bars outside the box above them. Parented to the visit span like a
	/// load is, so the trace still reads as one screen's story.
	@MainActor
	static func screenDecorations<T: Sendable>(
		screen: String,
		organizationId: String?,
		_ body: @MainActor @Sendable @escaping () async -> T
	) async -> T {
		var attributes: [String: AttributeValue] = [Key.screenName: .string(screen)]
		if let organizationId { attributes[Key.organizationId] = .string(organizationId) }
		return await withParent(Visit.parent(for: screen)) {
			await Telemetry.span(Name.screenDecorate, attributes: attributes) { _ in await body() }
		}
	}

	/// Run `body` with `parent` ambient, so spans started inside it hang under
	/// it. A `nil` parent means "start a new trace", which is the normal case.
	@MainActor
	private static func withParent<T: Sendable>(
		_ parent: Span?,
		_ body: @MainActor @Sendable @escaping () async -> T
	) async -> T {
		guard let parent else { return await body() }
		// `@Sendable` so the closure does not inherit this function's `@MainActor`
		// isolation — `TraceContext.withSpan` is nonisolated, and `body` carries
		// its own isolation with it.
		return await TraceContext.withSpan(parent) { @Sendable in await body() }
	}

	private static func record<Value>(_ state: LoadState<Value>?, on span: Span?) {
		guard let span else { return }
		switch state {
		case nil:
			// Cancelled or superseded — an org switch, a window change, a
			// second pull. Left `Unset`: it neither succeeded nor failed, and
			// counting it either way skews the screen's success rate.
			span.setAttribute(Key.loadOutcome, "superseded")
		case .loading:
			span.setAttribute(Key.loadOutcome, "loading")
		case .empty:
			span.setAttribute(Key.loadOutcome, "empty")
			span.setStatus(.ok)
		case .loaded:
			span.setAttribute(Key.loadOutcome, "loaded")
			span.setStatus(.ok)
		case .failed(let error):
			span.setAttribute(Key.loadOutcome, "failed")
			span.setAttribute(Key.errorType, error.telemetryType)
			if let status = error.telemetryStatusCode {
				span.setAttribute("http.response.status_code", status)
			}
			span.setStatus(.error(error.message))
			track(
				Event.apiFailed,
				["error.type": error.telemetryType, "screen": span.name]
			)
		}
	}
}

extension SessionController.Phase {
	var telemetryName: String {
		switch self {
		case .loading: "loading"
		case .signedOut: "signed_out"
		case .needsOrganization: "needs_organization"
		case .ready: "ready"
		}
	}
}

extension LoadReason {
	var telemetryName: String {
		switch self {
		case .initial: "initial"
		case .refresh: "refresh"
		case .replace: "replace"
		}
	}
}

extension MapleAPIError {
	/// A stable, low-cardinality label for `error.type`.
	///
	/// For an API failure that is the server's own `_tag` — the key it
	/// documents as the stable integration handle, and the same string the
	/// backend groups on, so a mobile failure and its server-side cause line up
	/// without a translation table. The message is never used: it carries ids.
	var telemetryType: String {
		switch self {
		case .notAuthenticated: "not_authenticated"
		case .api(_, let body): body.tag
		case .unexpectedStatus(let status, _): "unexpected_status_\(status)"
		case .transport: "transport"
		case .decoding: "decoding"
		}
	}

	var telemetryStatusCode: Int? {
		switch self {
		case .api(let status, _), .unexpectedStatus(let status, _): status
		case .notAuthenticated, .transport, .decoding: nil
		}
	}
}

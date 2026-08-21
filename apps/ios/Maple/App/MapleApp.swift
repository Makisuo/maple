import ClerkKit
import Maple
import MapleAPI
import SwiftUI

@main
struct MapleApp: App {
	@UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
	@State private var clerk: Clerk
	@State private var session: SessionController
	@State private var navigation: AppNavigation
	@State private var opener: DestinationOpener

	init() {
		// `Clerk.shared` traps until `configure` has run, and Swift evaluates
		// stored-property default values *before* this body — so `clerk` must be
		// assigned here rather than inline, or the app crashes on launch.
		//
		// Fixture mode (`MAPLE_FIXTURES=1` in the scheme environment) skips
		// Clerk and the network entirely: a well-formed but dead key keeps the
		// SDK quiet, and the session is pinned to `.ready`. Used for previews,
		// screenshots, and working on screens without a signed-in org.
		let tokens = ClerkTokenProvider()
		let navigation = AppNavigation()
		_navigation = State(initialValue: navigation)
		let opener = DestinationOpener(navigation: navigation)
		_opener = State(initialValue: opener)
		// Notification taps arrive on the app delegate, outside the view tree.
		PushRegistrar.shared.opener = opener
		// Before Clerk and the API client, so a cold launch is inside a session.
		Self.startTelemetry()
		// And before anything it should measure. Ends at the first frame, in
		// `RootView.onAppear`.
		Telemetry.Launch.begin()
		if FixtureAPI.isEnabled {
			_clerk = State(initialValue: Clerk.configure(publishableKey: FixtureSession.publishableKey))
			let fixtureAPI = FixtureAPI()
			let session = SessionController.fixture(api: fixtureAPI, tokens: tokens)
			_session = State(initialValue: session)
			opener.session = session
			// `configure`, not `bootstrap`: fixture mode has no Clerk session and
			// nothing in the App Group, so the headless path would correctly bail
			// and screenshots would have no widgets to take.
			WidgetPublisher.shared.configure(
				api: fixtureAPI,
				organizationId: FixtureSession.organizationId
			)
			return
		}

		// Restores the session from the keychain, so it is the one launch step
		// that reaches disk — and the first suspect when a cold start drags.
		let clerk = Telemetry.Launch.step(Telemetry.Name.clerkConfigure) {
			Clerk.configure(publishableKey: AppConfig.clerkPublishableKey)
		}
		_clerk = State(initialValue: clerk)

		// The client is constructed once: it holds no per-org state, because the
		// organization travels in the token rather than in a header.
		let api: any MapleAPI
		do {
			api = try Telemetry.Launch.step(Telemetry.Name.apiClientInit) {
				try MapleClient(tokens: tokens, baseURL: AppConfig.apiBaseURL)
			}
		} catch {
			fatalError("Invalid API base URL: \(error)")
		}
		let session = SessionController(api: api, tokens: tokens)
		_session = State(initialValue: session)
		// After `Clerk.configure` above, which is what restores the session this
		// reads. A launch into the background for a `BGAppRefreshTask` or a
		// silent push builds no view tree, so this is the *only* place those
		// wakes get a client and an organization; without it they woke up, found
		// no context, and did nothing at all. `MainTabView` still calls
		// `configure` with the verified membership list and overrides this.
		WidgetPublisher.shared.bootstrap(api: api)
		// Assigned here rather than in `body`: a tap that launched the app can
		// reach the delegate before the first frame, and an opener with no
		// session parks every destination it is handed.
		opener.session = session
	}

	/// Session replay and tracing, configured entirely from Info.plist — see the
	/// `Maple` dictionary in project.yml. With no ingest key set the SDK logs once
	/// and records nothing, which is what keeps an unsigned CI build and a fresh
	/// checkout quiet.
	///
	/// Called from `App.init` rather than `didFinishLaunchingWithOptions` because
	/// it runs earlier, and the spans worth having most are the cold-launch ones.
	@MainActor
	private static func startTelemetry() {
		// Fixture mode is the screenshot and preview path and makes no network
		// calls at all. Recording it would bill sessions for a simulator driving
		// canned data, and every trace would be of a request that never happened.
		guard !FixtureAPI.isEnabled else { return }

		var options = MapleOptions()
		// Only our own API carries `traceparent`. Clerk is a third party and has
		// no use for our trace ids; the default would send the header everywhere.
		options.tracing.tracePropagationTargets = ["api.maple.dev", "api-staging.maple.dev", "localhost"]
		// Masking off: a fully masked replay of this app is a screen of grey
		// rectangles and tells us nothing about how the dashboard is used.
		// Set explicitly rather than inherited so the trade-off stays visible —
		// recorded frames of this app do contain customers' telemetry.
		options.replay.maskAllText = false
		options.replay.maskAllImages = false
		Maple.start(options: options)
	}

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(clerk)
				.environment(session)
				.environment(navigation)
				.environment(opener)
		}
	}
}

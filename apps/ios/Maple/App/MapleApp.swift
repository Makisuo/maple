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
		// Notification taps arrive on the app delegate, outside the view tree.
		PushRegistrar.shared.navigation = navigation
		// Before Clerk and the API client, so a cold launch is inside a session.
		Self.startTelemetry()
		if FixtureAPI.isEnabled {
			_clerk = State(initialValue: Clerk.configure(publishableKey: FixtureSession.publishableKey))
			_session = State(initialValue: SessionController.fixture(api: FixtureAPI(), tokens: tokens))
			return
		}

		let clerk = Clerk.configure(publishableKey: AppConfig.clerkPublishableKey)
		_clerk = State(initialValue: clerk)

		// The client is constructed once: it holds no per-org state, because the
		// organization travels in the token rather than in a header.
		let api: any MapleAPI
		do {
			api = try MapleClient(tokens: tokens, baseURL: AppConfig.apiBaseURL)
		} catch {
			fatalError("Invalid API base URL: \(error)")
		}
		_session = State(initialValue: SessionController(api: api, tokens: tokens))
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
		// The dashboard renders customers' telemetry, so every masking default
		// stays on. Set explicitly rather than inherited: this is the one app
		// where a future default flip would leak someone else's data.
		options.replay.maskAllText = true
		options.replay.maskAllImages = true
		Maple.start(options: options)
	}

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(clerk)
				.environment(session)
				.environment(navigation)
		}
	}
}

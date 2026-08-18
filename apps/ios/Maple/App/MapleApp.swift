import ClerkKit
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

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(clerk)
				.environment(session)
				.environment(navigation)
		}
	}
}

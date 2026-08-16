import ClerkKit
import MapleAPI
import SwiftUI

@main
struct MapleApp: App {
	@State private var clerk: Clerk
	@State private var session: SessionController

	init() {
		// `Clerk.shared` traps until `configure` has run, and Swift evaluates
		// stored-property default values *before* this body — so `clerk` must be
		// assigned here rather than inline, or the app crashes on launch.
		let clerk = Clerk.configure(publishableKey: AppConfig.clerkPublishableKey)
		_clerk = State(initialValue: clerk)

		let tokens = ClerkTokenProvider()
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
		}
	}
}

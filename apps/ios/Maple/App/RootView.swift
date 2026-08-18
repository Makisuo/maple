import ClerkKit
import ClerkKitUI
import SwiftUI

/// The auth gate.
///
/// The tabs exist **only** in `.ready`. Building them and hiding them would let
/// their `.task` modifiers fire requests with an org-less token, which the API
/// answers with a 401 — so the gate is structural, not cosmetic.
struct RootView: View {
	@Environment(Clerk.self) private var clerk
	@Environment(SessionController.self) private var session

	var body: some View {
		Group {
			switch session.phase {
			case .loading:
				// A bare canvas rather than a spinner while Clerk restores the
				// session — DESIGN.md bans default spinners, and this resolves in
				// milliseconds from the keychain.
				Token.background.ignoresSafeArea()

			case .signedOut:
				AuthView()

			case .needsOrganization:
				OrganizationPickerView(mode: .gate)

			case .ready:
				MainTabView()
			}
		}
		// `Clerk` is @Observable, so touching these identities here means the
		// task re-runs when the user signs in or the active org changes —
		// no manual subscription needed.
		.task(id: clerkStateKey) {
			await session.refresh()
		}
		.background(Token.background)
		.tint(Token.primary)
		.animation(.default, value: session.phase)
		.onAppear { Typo.assertAvailable() }
	}

	/// Everything about Clerk's state that should re-derive the phase.
	private var clerkStateKey: String {
		[
			clerk.user?.id ?? "anonymous",
			clerk.session?.lastActiveOrganizationId ?? "no-org",
		].joined(separator: "|")
	}
}

/// Three tabs, in the order the questions get asked: is anything wrong
/// (Home), which service (Services), why (Alerts). Everything the web app does
/// beyond those stays on the web.
struct MainTabView: View {
	@Environment(AppNavigation.self) private var navigation
	@Environment(SessionController.self) private var session
	private let push = PushRegistrar.shared

	var body: some View {
		@Bindable var navigation = navigation
		TabView(selection: $navigation.tab) {
			Tab("Home", systemImage: "waveform.path.ecg", value: AppTab.home) {
				HomeView()
			}
			Tab("Services", systemImage: "square.stack.3d.up", value: AppTab.services) {
				ServicesListView()
			}
			Tab("Alerts", systemImage: "bell", value: AppTab.alerts) {
				AlertsHubView()
			}
		}
		// One PUT per change in (token, org, permission, preferences): the key
		// folds all four, so a token arriving after launch or an org switch
		// re-registers exactly once.
		.task(id: push.syncKey(orgId: session.currentOrganizationId)) {
			await push.refreshAuthorization()
			guard let orgId = session.currentOrganizationId else { return }
			await push.sync(api: session.api, orgId: orgId)
		}
	}
}

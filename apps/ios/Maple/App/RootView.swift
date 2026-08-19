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
	@Environment(AppNavigation.self) private var navigation

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
		// Clerk draws `AuthView` itself; this is what stops sign-in from being
		// the one screen in system colours and San Francisco.
		.environment(\.clerkTheme, .maple)
		.animation(.default, value: session.phase)
		// A widget tap arrives here whatever the phase is; the tabs may not
		// exist yet, and `AppNavigation` holds the destination until they do.
		.onOpenURL { navigation.open($0) }
		.onAppear {
			Typo.assertAvailable()
			// After the font check, so a missing face is reported as a missing
			// face rather than as a silently system-font navigation bar.
			NavigationAppearance.apply()
		}
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
	@Environment(\.scenePhase) private var scenePhase
	private let push = PushRegistrar.shared
	private let widgets = WidgetPublisher.shared

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
		// The Home Screen widget's data. Keyed on the org so a switch republishes
		// immediately rather than leaving the previous org's counts on the Home
		// Screen until the next background refresh.
		.task(id: session.currentOrganizationId) {
			guard let orgId = session.currentOrganizationId else { return }
			widgets.configure(
				api: session.api,
				organizationId: orgId,
				organizationName: session.activeOrganization?.name
			)
			await widgets.refresh()
		}
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active:
				// Coming back to the app is the cheapest fresh data there is —
				// the throttle inside `refresh` keeps this from being a request
				// per app switch.
				Task { await widgets.refresh() }
			case .background:
				// Queue the next opportunistic refresh on the way out, which is
				// the only moment iOS accepts one.
				WidgetRefreshScheduler.schedule()
			default:
				break
			}
		}
	}
}

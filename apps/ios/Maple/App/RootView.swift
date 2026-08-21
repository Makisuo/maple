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
	@Environment(DestinationOpener.self) private var opener

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
			// A destination that arrived before the session could place it — a
			// cold launch from a notification tap — is answered here, now that
			// the memberships are known.
			await opener.sessionDidSettle()
		}
		.background(Token.background)
		.tint(Token.primary)
		// Clerk draws `AuthView` itself; this is what stops sign-in from being
		// the one screen in system colours and San Francisco.
		.environment(\.clerkTheme, .maple)
		.animation(.default, value: session.phase)
		// A widget tap arrives here whatever the phase is; the tabs may not
		// exist yet, and `AppNavigation` holds the destination until they do.
		.onOpenURL { url in
			Task { await opener.open(url, source: .widget) }
		}
		.onAppear {
			// The first frame — the end of `app.launch`. The phase rides along
			// because "slow launch" means something different when it ended on
			// the sign-in screen than when it ended on a loaded Home.
			Telemetry.Launch.firstFrame(phase: session.phase.telemetryName)
			// Widgets migrated by an update resolve their organization on the
			// next timeline build; this makes that build happen now.
			WidgetPublisher.shared.reloadIfNewBuild(
				version: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
			)
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
	@Environment(DestinationOpener.self) private var opener
	@Environment(\.scenePhase) private var scenePhase
	private let push = PushRegistrar.shared
	private let widgets = WidgetPublisher.shared
	private let liveActivities = LiveActivityController.shared

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
		// Live Activities: the observation tasks have to be running before a push
		// can start one, and the push-to-start token only reaches the server
		// through the registration above — hence both, keyed on the org.
		.task(id: session.currentOrganizationId) {
			guard let orgId = session.currentOrganizationId else { return }
			liveActivities.configure(api: session.api, organizationId: orgId)
		}
		.task(id: session.widgetPublishKey) {
			guard let orgId = session.currentOrganizationId else { return }
			widgets.configure(
				api: session.api,
				organizationId: orgId,
				memberships: session.widgetOrganizations,
				membershipsVerified: session.membershipsLoaded
			)
			// Only a verified list may prune: `membershipsLoaded` is false when
			// Clerk's client payload was the source, and that list can be partial —
			// pruning against it would wipe live organizations' snapshots.
			if session.membershipsLoaded {
				widgets.prune(to: session.memberIds)
			}
			await widgets.refresh(trigger: .organization)
		}
		// Above the tabs, because answering a cross-organization tap changes the
		// tab and the stack in the same frame.
		.overlay(alignment: .top) {
			if let notice = opener.notice {
				OrganizationNoticeView(notice: notice) { opener.dismissNotice() }
					.transition(.move(edge: .top).combined(with: .opacity))
			}
		}
		.animation(.snappy, value: opener.notice)
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active:
				// Coming back to the app is the cheapest fresh data there is —
				// the throttle inside `refresh` keeps this from being a request
				// per app switch.
				Task { await widgets.refresh(trigger: .foreground) }
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

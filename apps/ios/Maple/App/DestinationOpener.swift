import MapleWidgetData
import Observation
import SwiftUI

/// The one way anything outside the view tree opens a screen: a tapped
/// notification, a tapped widget, a tapped Live Activity.
///
/// It exists because all three can name an organization that is not the active
/// one, and the app has exactly one active organization at a time. Before this,
/// a tap on an alert for another org pushed the incident straight onto the
/// Alerts stack, where the request went out under the current org's token and
/// came back 404 — the app said the incident did not exist.
///
/// `AppNavigation` is left as what it was always good at: putting a route on
/// screen. The decision of *which organization that route belongs in* is here,
/// and the decision itself is `DestinationResolver`, in a package that has
/// tests.
@MainActor
@Observable
final class DestinationOpener {
	enum Source: String {
		case push
		case widget
		case liveActivity
	}

	/// The one line of feedback a switch is allowed. Silently changing which
	/// organization the whole app is showing is not acceptable; a modal question
	/// in front of someone who tapped an alert to read it is not either.
	struct Notice: Equatable, Identifiable {
		enum Kind: Equatable {
			case switched(organizationId: String, name: String?)
			case notAMember
		}

		let id = UUID()
		var kind: Kind
	}

	private(set) var notice: Notice?

	private let navigation: AppNavigation
	/// Assigned at launch. Weak because the session outlives nothing here and
	/// this object is reachable from the app delegate.
	weak var session: SessionController?

	/// A destination waiting for the session to be able to answer. One slot: a
	/// newer tap replaces an older one, the same way `Telemetry.PushOpen` treats
	/// a second tap.
	private var parked: (link: WidgetDeepLink, source: Source)?
	private var parkExpiry: Task<Void, Never>?
	/// Matches `Telemetry.PushOpen`'s own abandon window, so a parked
	/// destination and the open span measuring it cannot outlive each other.
	private static let parkTimeout: Duration = .seconds(30)

	init(navigation: AppNavigation) {
		self.navigation = navigation
	}

	func open(_ url: URL, source: Source) async {
		guard let link = WidgetDeepLink(url: url) else { return }
		await open(link, source: source)
	}

	func open(_ link: WidgetDeepLink, source: Source) async {
		switch DestinationResolver.decide(organizationId: link.organizationId, session: snapshot) {
		case .navigate:
			navigation.go(link.target)

		case .switchThenNavigate(let organizationId):
			await switchThenNavigate(to: organizationId, link: link)

		case .park:
			park(link, source: source)

		case .refuseNotAMember:
			show(.notAMember)
			// The tap will never reach its screen, so close the span with a
			// reason rather than letting it time out anonymously.
			Telemetry.PushOpen.abandon(reason: "not_a_member")
		}
	}

	/// The session can now answer a question it could not before — called from
	/// `RootView` right after `SessionController.refresh()`.
	func sessionDidSettle() async {
		guard let parked else { return }
		self.parked = nil
		parkExpiry?.cancel()
		parkExpiry = nil
		await open(parked.link, source: parked.source)
	}

	func dismissNotice() {
		notice = nil
	}

	// MARK: Private

	private var snapshot: SessionSnapshot {
		guard let session else { return .loading }
		switch session.phase {
		case .loading:
			return .loading
		case .signedOut:
			return .signedOut
		case .needsOrganization:
			// Signed in with nothing active. There is no organization to compare
			// against, and switching into the one the link names is exactly what
			// the picker would otherwise ask the user to do by hand — so treat it
			// as "active organization: none" and let the resolver switch.
			return .ready(
				activeOrganizationId: "",
				memberIds: session.memberIds,
				membershipsLoaded: session.membershipsLoaded
			)
		case .ready(let organizationId):
			return .ready(
				activeOrganizationId: organizationId,
				memberIds: session.memberIds,
				membershipsLoaded: session.membershipsLoaded
			)
		}
	}

	/// Switch **then** navigate, never the other way round.
	///
	/// `select` bumps `dataGeneration`, and every detail screen keys its load on
	/// it. Pushing the route first would build the screen under the old
	/// generation, fire the request with the old organization's token, take the
	/// 404 — the exact failure this type exists to remove — and only then
	/// re-run.
	private func switchThenNavigate(to organizationId: String, link: WidgetDeepLink) async {
		guard let session else { return park(link, source: .push) }

		Telemetry.PushOpen.recordOrganizationSwitch()
		await session.select(organizationId: organizationId)

		guard session.currentOrganizationId == organizationId else {
			// Clerk refused the switch — revoked membership, or an expired
			// session. Landing on the incident anyway reproduces the 404.
			show(.notAMember)
			Telemetry.PushOpen.abandon(reason: "switch_failed")
			return
		}

		show(.switched(organizationId: organizationId, name: session.name(of: organizationId)))
		navigation.go(link.target)
	}

	private func park(_ link: WidgetDeepLink, source: Source) {
		parked = (link, source)
		parkExpiry?.cancel()
		parkExpiry = Task { [weak self] in
			try? await Task.sleep(for: Self.parkTimeout)
			guard !Task.isCancelled else { return }
			self?.parked = nil
		}
	}

	private func show(_ kind: Notice.Kind) {
		notice = Notice(kind: kind)
	}
}

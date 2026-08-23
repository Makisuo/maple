import Foundation
import Testing

@testable import MapleWidgetData

/// One test per rule, because the *order* of the rules is the whole content of
/// `DestinationResolver` and every wrong order produces a plausible-looking app
/// that fails on exactly one path.
@Suite("DestinationResolver")
struct DestinationResolverTests {
	private let ready = SessionSnapshot.ready(
		activeOrganizationId: "org_a",
		memberIds: ["org_a", "org_b"],
		membershipsLoaded: true
	)

	@Test("A link with no organization never moves the user")
	func organizationLessLinkNavigates() {
		#expect(DestinationResolver.decide(organizationId: nil, session: ready) == .navigate)
		#expect(DestinationResolver.decide(organizationId: "", session: ready) == .navigate)
	}

	@Test("The organization already active is a plain navigation")
	func sameOrganizationNavigates() {
		#expect(DestinationResolver.decide(organizationId: "org_a", session: ready) == .navigate)
	}

	@Test("Another organization the user belongs to switches first")
	func memberOrganizationSwitches() {
		#expect(
			DestinationResolver.decide(organizationId: "org_b", session: ready)
				== .switchThenNavigate(organizationId: "org_b")
		)
	}

	@Test("An organization the user has left is refused, not opened")
	func nonMemberIsRefused() {
		#expect(
			DestinationResolver.decide(organizationId: "org_z", session: ready)
				== .refuseNotAMember(organizationId: "org_z")
		)
	}

	/// The cold-start case. A notification tap launches the app and fires
	/// `didReceive` before `RootView`'s task has run `session.refresh()`, so the
	/// membership set is empty — *unknown*, not "you are not a member". Checking
	/// membership before this would refuse every cold cross-org tap.
	@Test("A session still loading parks rather than refusing")
	func loadingParks() {
		#expect(DestinationResolver.decide(organizationId: "org_b", session: .loading) == .park)
	}

	@Test("A signed-out session parks — the user may be about to sign in")
	func signedOutParks() {
		#expect(DestinationResolver.decide(organizationId: "org_b", session: .signedOut) == .park)
	}

	/// `membershipsLoaded == false` means the list came from Clerk's client
	/// payload, which `SessionController` documents as possibly partial. Refusing
	/// on that would lock a user out of an org they are in.
	@Test("An unverified membership list parks rather than refusing")
	func partialMembershipsPark() {
		let partial = SessionSnapshot.ready(
			activeOrganizationId: "org_a",
			memberIds: ["org_a"],
			membershipsLoaded: false
		)
		#expect(DestinationResolver.decide(organizationId: "org_b", session: partial) == .park)
		// …but the active org still resolves, because that needs no list at all.
		#expect(DestinationResolver.decide(organizationId: "org_a", session: partial) == .navigate)
	}
}

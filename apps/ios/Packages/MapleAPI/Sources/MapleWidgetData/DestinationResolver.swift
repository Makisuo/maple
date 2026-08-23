import Foundation

/// What the app knows about the session at the moment a destination arrives.
///
/// A snapshot rather than the `SessionController` itself, so the decision below
/// is a pure function the package can test — the app target has no test bundle.
public enum SessionSnapshot: Sendable, Equatable {
	/// Clerk is still restoring. Memberships are not merely empty, they are
	/// **unknown**, which is a different thing from "you are not a member".
	case loading
	case signedOut
	case ready(activeOrganizationId: String, memberIds: Set<String>, membershipsLoaded: Bool)
}

public enum DestinationDecision: Sendable, Equatable {
	/// Go straight there: either the link named no organization, or it named the
	/// one already active.
	case navigate
	/// Switch first, then go. Never the other way round.
	case switchThenNavigate(organizationId: String)
	/// The session cannot answer yet. Hold the destination and ask again once it
	/// settles.
	case park
	/// The user is not in that organization. Say so; do not navigate.
	case refuseNotAMember(organizationId: String)
}

/// Decides what to do with a destination that names an organization.
///
/// The ordering of the rules is the whole content of this type. In particular
/// **the "still loading" checks come before the membership check**: a tap on a
/// notification launches the app cold, and `didReceive` fires before
/// `RootView`'s task has run `SessionController.refresh()`. At that moment the
/// membership set is empty, so a membership-first ordering would tell every
/// cold-start cross-organization tap that the user is not a member — which is a
/// worse bug than the one being fixed.
public enum DestinationResolver {
	public static func decide(
		organizationId: String?,
		session: SessionSnapshot
	) -> DestinationDecision {
		// No organization named. This is every link built before multi-org, and
		// `maple://issues` still means "the issues of whichever org I am in".
		// Switching here would move the user for a link that never asked.
		guard let organizationId, !organizationId.isEmpty else { return .navigate }

		switch session {
		case .loading:
			return .park
		case .signedOut:
			// The user may be about to sign in — `sessionDidSettle()` re-asks.
			return .park
		case .ready(let activeOrganizationId, let memberIds, let membershipsLoaded):
			if activeOrganizationId == organizationId { return .navigate }
			// `membershipsLoaded == false` means the list came from Clerk's client
			// payload, which `SessionController` documents as possibly partial.
			// Refusing on a partial list would lock a user out of their own org.
			guard membershipsLoaded else { return .park }
			guard memberIds.contains(organizationId) else {
				return .refuseNotAMember(organizationId: organizationId)
			}
			return .switchThenNavigate(organizationId: organizationId)
		}
	}
}

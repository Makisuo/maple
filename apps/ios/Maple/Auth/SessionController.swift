import ClerkKit
import Foundation
import MapleAPI
import Observation

/// Owns "who is signed in, to which organization, and is the API usable yet".
///
/// The organization matters more here than in a typical Clerk app: the Maple v2
/// API has **no org header**. It reads the organization from the session
/// token's active-organization claim and rejects a token without one
/// (`"Active organization is required"`, `packages/auth/src/index.ts`). So the
/// app cannot make a single useful request until an organization is active.
@MainActor
@Observable
final class SessionController {
	enum Phase: Equatable {
		case loading
		case signedOut
		/// Signed in, but no organization is active — the API would 401.
		case needsOrganization
		case ready(organizationId: String)
	}

	private(set) var phase: Phase = .loading

	/// Bumped whenever the data underneath every screen becomes invalid: a
	/// different organization, or a fresh sign-in.
	///
	/// Screens observe it with `.task(id:)`, which cancels in-flight work and
	/// restarts — so org A's services never linger on screen while org B loads.
	private(set) var dataGeneration = 0

	/// The user's organizations, fetched from Clerk rather than read off the
	/// user object.
	///
	/// `User.organizationMemberships` is an `Optional` array populated from the
	/// client payload; it can be absent or partial. Trusting it meant a user
	/// with several organizations could be auto-selected into whichever one
	/// happened to be in that payload and never offered the choice — and a user
	/// whose payload carried none would be told they belong to no organization
	/// at all.
	private(set) var memberships: [OrganizationMembership] = []
	private(set) var membershipsLoaded = false
	private(set) var organizationError: String?

	let api: any MapleAPI
	private let tokens: ClerkTokenProvider

	init(api: any MapleAPI, tokens: ClerkTokenProvider) {
		self.api = api
		self.tokens = tokens
	}

	var activeOrganization: Organization? {
		Clerk.shared.organization
	}

	var activeOrganizationId: String? {
		Clerk.shared.session?.lastActiveOrganizationId
	}

	/// True once switching is actually possible — used to decide whether the
	/// switcher is worth showing.
	var canSwitchOrganization: Bool {
		memberships.count > 1
	}

	/// Recompute the phase from Clerk's current state.
	///
	/// Called on launch and whenever Clerk's observable state changes — `Clerk`
	/// is `@Observable`, so SwiftUI re-runs the enclosing `.task(id:)` for us
	/// rather than needing a subscription.
	func refresh() async {
		guard Clerk.shared.user != nil else {
			phase = .signedOut
			memberships = []
			membershipsLoaded = false
			return
		}

		// Always load the real list, even when an org is already active: the
		// switcher needs it, and it is what makes the auto-select decision safe.
		await loadMemberships()

		if let organizationId = activeOrganizationId {
			if case .ready(let current) = phase, current == organizationId { return }
			phase = .ready(organizationId: organizationId)
			return
		}

		// No active organization. One membership is not a choice, so make it and
		// skip a pointless picker — but only when we know it is genuinely the
		// only one.
		if membershipsLoaded, memberships.count == 1, let only = memberships.first {
			await select(organizationId: only.organization.id)
			return
		}

		phase = .needsOrganization
	}

	/// Fetch every membership, paging until the reported total is reached.
	func loadMemberships() async {
		guard let user = Clerk.shared.user else { return }

		var collected: [OrganizationMembership] = []
		var page = 1
		let pageSize = 50

		do {
			while true {
				let response = try await user.getOrganizationMemberships(page: page, pageSize: pageSize)
				collected.append(contentsOf: response.data)
				if collected.count >= response.totalCount || response.data.isEmpty { break }
				page += 1
				// A defensive stop: a server that never reports completion must not
				// spin here forever.
				if page > 20 { break }
			}
			memberships = collected
			membershipsLoaded = true
			organizationError = nil
		} catch {
			// Fall back to whatever the client payload carried. Partial is better
			// than nothing for the switcher, but `membershipsLoaded` stays false so
			// the auto-select path — the one that can silently pick wrong — is not
			// taken on unverified data.
			memberships = user.organizationMemberships ?? []
			organizationError = "Couldn't load your organizations. \(error.localizedDescription)"
		}
	}

	/// Switch the active organization and make every screen reload against it.
	func select(organizationId: String) async {
		guard let sessionId = Clerk.shared.session?.id else {
			phase = .signedOut
			return
		}
		if activeOrganizationId == organizationId, case .ready = phase { return }

		organizationError = nil
		do {
			try await Clerk.shared.auth.setActive(sessionId: sessionId, organizationId: organizationId)

			// Order matters. Drop the old-org token *before* anything can use it;
			// only then let screens start fetching.
			await tokens.invalidate()
			dataGeneration += 1
			phase = .ready(organizationId: organizationId)
		} catch {
			organizationError = "Couldn't switch organization. \(error.localizedDescription)"
		}
	}

	/// React to an API failure that the session is responsible for.
	///
	/// Returns true when the caller should retry once — a 401 is most often a
	/// token that expired mid-flight, and re-minting fixes it without bothering
	/// the user.
	func handle(_ error: MapleAPIError) async -> Bool {
		if error.requiresOrganization {
			// Still authenticated — the token just lost its org claim (e.g. the
			// user was removed from the org elsewhere). Ask for an org, do not
			// sign out.
			phase = .needsOrganization
			return false
		}

		guard error.requiresReauthentication else { return false }
		await tokens.invalidate()
		return true
	}

	/// Give up on the current credentials and show the sign-in screen.
	func signOutLocally() async {
		await tokens.invalidate()
		phase = .signedOut
	}

	func signOut() async {
		try? await Clerk.shared.auth.signOut()
		memberships = []
		membershipsLoaded = false
		await signOutLocally()
	}
}

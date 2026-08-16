import ClerkKit
import Foundation
import MapleAPI

/// Supplies the Clerk session JWT that every v2 request carries.
///
/// Deliberately thin. The web client (`apps/web/src/lib/services/common/auth-headers.ts`)
/// hand-rolls an expiry cache with a generation counter because the Clerk JS
/// SDK does not cache for you. The Swift SDK does: `getToken` keeps a token
/// with a one-minute TTL and an `expirationBuffer`, and `skipCache` forces a
/// round-trip. Re-implementing that here would be duplicated state with its own
/// bugs, so this type owns only the one thing Clerk cannot know about:
///
/// **after an organization switch the cached token still carries the old `org`
/// claim**, and v2 reads the organization from that claim alone. So the next
/// fetch after `setActive` must bypass the cache exactly once.
actor ClerkTokenProvider: MapleTokenProvider {
	/// Set by `SessionController` immediately after `setActive`, consumed by the
	/// next `token(forceRefresh:)`.
	private var needsFreshToken = false

	func invalidate() {
		needsFreshToken = true
	}

	func token(forceRefresh: Bool = false) async throws -> String? {
		let skipCache = forceRefresh || needsFreshToken
		let options = Session.GetTokenOptions(skipCache: skipCache)

		// No JWT template: the API verifies the raw Clerk session token, matching
		// what apps/web sends.
		let token = try await Clerk.shared.auth.getToken(options)

		// Only clear the flag once a fetch actually succeeded — a thrown error
		// must not leave a stale-org token as the next thing we hand out.
		if skipCache { needsFreshToken = false }
		return token
	}
}

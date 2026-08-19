import ClerkKit
import Foundation
import Maple
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

	/// Traced because it sits on the critical path of **every** request while
	/// belonging to someone else's SDK. A cache hit is microseconds; a miss is a
	/// round-trip to Clerk that, untraced, presents as a slow Maple API call and
	/// sends you looking at the wrong service. Clerk uses `URLSession`, so the
	/// round-trip shows up as a child client span for free — and `traceparent`
	/// is not sent to it, because `tracePropagationTargets` names only our API.
	func token(forceRefresh: Bool = false) async throws -> String? {
		let skipCache = forceRefresh || needsFreshToken
		let token = try await Maple.span(
			Telemetry.Name.authToken,
			attributes: [Telemetry.Key.authSkipCache: .bool(skipCache)]
		) { span in
			let options = Session.GetTokenOptions(skipCache: skipCache)

			// No JWT template: the API verifies the raw Clerk session token, matching
			// what apps/web sends.
			let token = try await Clerk.shared.auth.getToken(options)
			span?.setAttribute(Telemetry.Key.authHasToken, token != nil)
			return token
		}

		// Outside the span, and only once a fetch actually succeeded — a thrown
		// error must not leave a stale-org token as the next thing we hand out.
		// (The span body is `sending`, so it is nonisolated and cannot touch
		// this actor's state itself.)
		if skipCache { needsFreshToken = false }
		return token
	}
}

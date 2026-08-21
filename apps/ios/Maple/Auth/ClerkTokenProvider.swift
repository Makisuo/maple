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
/// bugs, so this type owns only Clerk glue.
///
/// The two things Clerk's cache cannot do for us live in
/// `CoalescingTokenProvider`, which this wraps:
///
///  1. **After an organization switch the cached token still carries the old
///     `org` claim**, and v2 reads the organization from that claim alone. So
///     the next fetch after `setActive` must bypass the cache exactly once —
///     `invalidate()`.
///  2. **A screen load asks for a token once per request**, five to thirteen
///     times at once. Clerk's cache is per-call, not per-fan-out, so a shared
///     expiry made all of them miss together.
///
/// That logic is in the package rather than here because here it cannot be
/// tested: it would need Clerk, a simulator, and a signed-in user. See
/// `CoalescingTokenProviderTests`.
final class ClerkTokenProvider: MapleTokenProvider {
	private let coalescing: CoalescingTokenProvider

	init() {
		self.coalescing = CoalescingTokenProvider { skipCache in
			// Traced because it sits on the critical path of **every** request
			// while belonging to someone else's SDK. A cache hit is
			// microseconds; a miss is a round-trip to Clerk that, untraced,
			// presents as a slow Maple API call and sends you looking at the
			// wrong service. Clerk uses `URLSession`, so the round-trip shows up
			// as a child client span for free — and `traceparent` is not sent to
			// it, because `tracePropagationTargets` names only our API.
			//
			// One span per *mint*, not per caller: eight requests sharing one
			// mint should read as one round-trip, because that is what happened.
			try await Maple.span(
				Telemetry.Name.authToken,
				attributes: [Telemetry.Key.authSkipCache: .bool(skipCache)]
			) { span in
				let options = Session.GetTokenOptions(skipCache: skipCache)

				// No JWT template: the API verifies the raw Clerk session token,
				// matching what apps/web sends.
				let token = try await Clerk.shared.auth.getToken(options)
				span?.setAttribute(Telemetry.Key.authHasToken, token != nil)
				return token
			}
		}
	}

	/// The next mint must bypass Clerk's cache. Called by `SessionController`
	/// immediately after `setActive`, and after any 401.
	func invalidate() async {
		await coalescing.invalidate()
	}

	func token(forceRefresh: Bool = false) async throws -> String? {
		try await coalescing.token(forceRefresh: forceRefresh)
	}
}

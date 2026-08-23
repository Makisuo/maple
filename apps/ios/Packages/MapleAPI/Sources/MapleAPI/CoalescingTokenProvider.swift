import Foundation

/// Mints session tokens, coalescing concurrent callers onto one round-trip.
///
/// Every request carries a bearer token, so `token(forceRefresh:)` runs once
/// per request — and a screen load fans out five to thirteen of them at once.
/// The obvious implementation, an actor that awaits the SDK's own cache, is
/// wrong in a way that only shows up under that fan-out: **Swift actors are
/// reentrant**. At the `await` for a token, the actor suspends and every other
/// caller walks straight in, so N concurrent requests make N independent token
/// calls rather than sharing one.
///
/// Production traces showed exactly that — five `auth.token` spans opening
/// within 4ms of each other, and a cache whose p50 is 1.7ms carrying a p95 of
/// 812ms because those five raced the same expiry.
///
/// The organization flag made it worse. `invalidate()` sets `needsFreshToken`,
/// and each of the five read it as `true` before any of them wrote it back, so
/// an organization switch cost five forced round-trips (~1.2s each) where it
/// needed one.
///
/// This type owns that coordination and nothing else: the actual minting is a
/// closure, so the whole thing tests without Clerk, a simulator, or a signed-in
/// user. See `ClerkTokenProvider` for the ten lines that supply the closure.
public actor CoalescingTokenProvider: MapleTokenProvider {
	/// Mints a token. `skipCache` bypasses the underlying SDK's own cache.
	public typealias Mint = @Sendable (_ skipCache: Bool) async throws -> String?

	private struct Flight {
		let task: Task<String?, any Error>
		/// Whether this mint bypassed the cache. A fresh mint satisfies every
		/// waiter; a cached one only satisfies waiters that did not ask for
		/// freshness.
		let skipCache: Bool
	}

	private let mint: Mint
	private var inFlight: Flight?

	/// Set by `SessionController` immediately after `setActive`, consumed by the
	/// next mint. See `invalidate()`.
	private var needsFreshToken = false

	public init(mint: @escaping Mint) {
		self.mint = mint
	}

	/// The next token must bypass the cache exactly once.
	///
	/// After an organization switch the cached token still carries the old `org`
	/// claim, and v2 reads the organization from that claim alone — so the next
	/// fetch has to round-trip even though the cached token has not expired.
	public func invalidate() {
		needsFreshToken = true
	}

	public func token(forceRefresh: Bool = false) async throws -> String? {
		let skipCache = forceRefresh || needsFreshToken

		// Join an in-flight mint when it will produce a token good enough for
		// this caller. A `skipCache` mint is good enough for everyone.
		if let inFlight, inFlight.skipCache || !skipCache {
			return try await inFlight.task.value
		}

		// Consume the flag *before* the suspension point below. Clearing it
		// afterwards is what let five reentrant callers each read `true` and
		// each force their own round-trip.
		needsFreshToken = false

		let mint = self.mint
		let task = Task { try await mint(skipCache) }
		inFlight = Flight(task: task, skipCache: skipCache)

		do {
			let token = try await task.value
			clear(task)
			return token
		} catch {
			clear(task)
			// A thrown mint must not leave a stale-organization token as the
			// next thing we hand out: put the flag back so the next caller
			// tries again rather than reusing the old claim.
			if skipCache { needsFreshToken = true }
			throw error
		}
	}

	/// Only the caller that started a flight retires it — a later caller may
	/// already have installed its own.
	private func clear(_ task: Task<String?, any Error>) {
		if inFlight?.task == task { inFlight = nil }
	}
}

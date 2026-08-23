import Foundation
import Testing

@testable import MapleAPI

/// Counts mints and parks them until released, so a test can hold every caller
/// at the suspension point at once — which is the only state in which the
/// reentrancy bug is visible. No sleeps: the gate opens when the expected
/// number of callers have actually arrived.
private actor MintGate {
	private(set) var started = 0
	private(set) var skipCacheMints = 0
	private var waiters: [CheckedContinuation<Void, Never>] = []
	private var arrivals: [CheckedContinuation<Void, Never>] = []
	private var isOpen = false
	private var failure: (any Error)?

	func failEveryMint(with error: any Error) {
		failure = error
	}

	/// The closure handed to `CoalescingTokenProvider`.
	func mint(skipCache: Bool) async throws -> String? {
		started += 1
		if skipCache { skipCacheMints += 1 }
		resumeArrivals()
		if !isOpen {
			await withCheckedContinuation { waiters.append($0) }
		}
		if let failure { throw failure }
		return skipCache ? "fresh-token" : "cached-token"
	}

	/// Suspends until `count` mints have started.
	func waitForArrivals(_ count: Int) async {
		while started < count {
			await withCheckedContinuation { arrivals.append($0) }
		}
	}

	func open() {
		isOpen = true
		for waiter in waiters { waiter.resume() }
		waiters.removeAll()
	}

	func close() {
		isOpen = false
	}

	private func resumeArrivals() {
		for arrival in arrivals { arrival.resume() }
		arrivals.removeAll()
	}
}

private struct MintFailure: Error {}

@Suite("Token coalescing")
struct CoalescingTokenProviderTests {
	/// The fan-out case: a screen load asks for a token once per request, and
	/// all of those land inside the same suspension. Before coalescing this
	/// produced one mint per caller.
	@Test func concurrentCallersShareOneMint() async throws {
		let gate = MintGate()
		let provider = CoalescingTokenProvider { skipCache in
			try await gate.mint(skipCache: skipCache)
		}

		let tokens = try await withThrowingTaskGroup(of: String?.self) { group in
			for _ in 0 ..< 8 {
				group.addTask { try await provider.token() }
			}
			// Let every caller reach the mint before releasing any of them.
			await gate.waitForArrivals(1)
			await gate.open()
			return try await group.reduce(into: [String?]()) { $0.append($1) }
		}

		#expect(tokens.count == 8)
		#expect(tokens.allSatisfy { $0 == "cached-token" })
		#expect(await gate.started == 1)
	}

	/// The organization-switch case. `invalidate()` sets one flag; every
	/// concurrent caller used to read it as `true` before any wrote it back, so
	/// a switch cost one forced round-trip per in-flight request.
	@Test func forcedRefreshIsConsumedExactlyOnce() async throws {
		let gate = MintGate()
		let provider = CoalescingTokenProvider { skipCache in
			try await gate.mint(skipCache: skipCache)
		}
		await provider.invalidate()

		let tokens = try await withThrowingTaskGroup(of: String?.self) { group in
			for _ in 0 ..< 6 {
				group.addTask { try await provider.token() }
			}
			await gate.waitForArrivals(1)
			await gate.open()
			return try await group.reduce(into: [String?]()) { $0.append($1) }
		}

		#expect(await gate.started == 1)
		#expect(await gate.skipCacheMints == 1)
		// Everyone gets the fresh token, not just the caller that triggered it —
		// a stale-organization token handed to any of the six is a 401.
		#expect(tokens.allSatisfy { $0 == "fresh-token" })
	}

	/// A cached mint must not satisfy a caller that asked for freshness, or an
	/// organization switch racing an ordinary request would keep the old claim.
	@Test func aCachedFlightDoesNotSatisfyAForcedCaller() async throws {
		let gate = MintGate()
		let provider = CoalescingTokenProvider { skipCache in
			try await gate.mint(skipCache: skipCache)
		}

		async let cached = provider.token()
		await gate.waitForArrivals(1)

		async let forced = provider.token(forceRefresh: true)
		await gate.waitForArrivals(2)
		await gate.open()

		#expect(try await cached == "cached-token")
		#expect(try await forced == "fresh-token")
		#expect(await gate.started == 2)
	}

	/// A failed mint must leave the provider usable, and must put the
	/// invalidation flag back — otherwise a transient failure during an
	/// organization switch permanently strands the app on the old claim.
	@Test func aFailedRefreshIsRetriedFresh() async throws {
		let gate = MintGate()
		let provider = CoalescingTokenProvider { skipCache in
			try await gate.mint(skipCache: skipCache)
		}
		await provider.invalidate()
		await gate.failEveryMint(with: MintFailure())
		await gate.open()

		await #expect(throws: MintFailure.self) { try await provider.token() }

		// Second attempt succeeds, and still skips the cache.
		let recovered = MintGate()
		let retry = CoalescingTokenProvider { skipCache in
			try await recovered.mint(skipCache: skipCache)
		}
		await retry.invalidate()
		await recovered.open()
		#expect(try await retry.token() == "fresh-token")
		#expect(await recovered.skipCacheMints == 1)
	}

	/// Coalescing is in-flight only: once a mint completes, the next caller
	/// mints again rather than being handed a token of unknown age.
	@Test func aCompletedFlightIsNotReused() async throws {
		let gate = MintGate()
		let provider = CoalescingTokenProvider { skipCache in
			try await gate.mint(skipCache: skipCache)
		}
		await gate.open()

		_ = try await provider.token()
		_ = try await provider.token()

		#expect(await gate.started == 2)
	}
}

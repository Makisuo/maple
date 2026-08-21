import Foundation
import Testing

@testable import MapleAPI

/// Lets a test hold a load at a known point and release it deliberately, so
/// "was it cancelled" is answered by the task's own state rather than by timing.
private actor Latch {
	private var waiters: [CheckedContinuation<Void, Never>] = []
	private var isOpen = false

	func wait() async {
		if isOpen { return }
		await withCheckedContinuation { waiters.append($0) }
	}

	func open() {
		isOpen = true
		for waiter in waiters { waiter.resume() }
		waiters.removeAll()
	}
}

@Suite("Load arbitration")
@MainActor
struct LoadRegistryTests {
	/// A load started by one model instance must be cancellable by another.
	///
	/// This is the bug the registry exists for: `.task(id: dataGeneration)`
	/// rebuilds the model on an organization switch, and the new instance's
	/// `ScreenLoader` has an empty `current` — so before this, both loads ran.
	@Test func aLaterInstanceSupersedesAnEarlierOnesLoad() async {
		let registry = LoadRegistry()
		let latch = Latch()
		var firstFinished = false

		// The load the previous model instance started.
		let first = Task { await latch.wait(); firstFinished = !Task.isCancelled }
		registry.register("Home", first)

		// A new instance takes over the screen.
		registry.supersede("Home")
		await latch.open()
		await first.value

		#expect(first.isCancelled)
		#expect(firstFinished == false)
		#expect(registry.activeCount == 0)
	}

	/// A refresh joins the running load rather than stacking a second one — a
	/// pull during Home's tick, or two quick pulls, is one request.
	@Test func aRefreshJoinsTheRunningLoad() async {
		let registry = LoadRegistry()
		let latch = Latch()
		var runs = 0

		let running = Task { await latch.wait(); runs += 1 }
		registry.register("Home", running)

		let joined = registry.inFlightTask(for: "Home")
		#expect(joined != nil)

		await latch.open()
		await joined?.value

		#expect(runs == 1)
	}

	/// Screens arbitrate independently: loading Home must not cancel Services.
	@Test func screensDoNotInterfere() async {
		let registry = LoadRegistry()
		let latch = Latch()

		let home = Task { await latch.wait() }
		let services = Task { await latch.wait() }
		registry.register("Home", home)
		registry.register("Services", services)

		registry.supersede("Home")

		#expect(home.isCancelled)
		#expect(services.isCancelled == false)
		#expect(registry.activeCount == 1)

		await latch.open()
		await services.value
	}

	/// A superseded load finishing late must not retire the entry belonging to
	/// the load that replaced it — otherwise the replacement becomes invisible
	/// to the next caller and a third load starts alongside it.
	@Test func aSupersededLoadDoesNotRetireItsReplacement() async {
		let registry = LoadRegistry()
		let latch = Latch()

		let first = Task { await latch.wait() }
		registry.register("Home", first)
		registry.supersede("Home")

		let second = Task { await latch.wait() }
		registry.register("Home", second)

		// The superseded load now finishes and tries to clean up after itself.
		registry.retire("Home", first)

		#expect(registry.inFlightTask(for: "Home") != nil)
		#expect(registry.activeCount == 1)

		await latch.open()
		await second.value
		registry.retire("Home", second)
		#expect(registry.activeCount == 0)
	}

	/// Superseding a screen nothing is loading is a no-op.
	@Test func supersedingAnIdleScreenIsHarmless() {
		let registry = LoadRegistry()
		registry.supersede("Home")
		#expect(registry.activeCount == 0)
	}
}

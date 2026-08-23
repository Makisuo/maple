import Foundation
import MapleAPI
import Observation

/// Why a load was asked for. The reason decides what the screen shows while it
/// runs and what it shows if it fails — which is the whole difference between
/// a pull-to-refresh that quietly fails and one that wipes the list.
enum LoadReason {
	/// First load, org switch, or the error state's "Try again": show the
	/// skeleton and supersede anything in flight.
	case initial
	/// Pull-to-refresh, Home's tick, a return from the background: keep what
	/// is on screen. If a load is already running, join it rather than racing
	/// it. If it fails, keep the content and surface `refreshError`.
	case refresh
	/// A time-window or filter change: the rows on screen no longer answer the
	/// question, so keep them dimmed while the replacement loads and supersede
	/// anything in flight. A failure here is a real failure.
	case replace
}

/// One load pipeline for every screen.
///
/// Every model used to carry its own `load(showPlaceholder:)`, and each copy
/// had the same three problems: concurrent loads (pull, tick, filter change,
/// org switch, retry) raced and the slowest wrote last; a failed refresh
/// replaced a full screen with the error panel; and pagination appended to a
/// snapshot a refresh had already replaced. This class owns the ordering
/// (`generation`), the failure policy (`LoadReason`), and the 401 handling
/// (via `SessionController.perform`), and the models keep only their fetch.
@MainActor
@Observable
final class ScreenLoader<Value: Sendable> {
	private(set) var state: LoadState<Value> = .loading
	/// A load is running. Drives the dimmed content of a `.replace` load.
	private(set) var isLoading = false
	/// True while a `.replace` load is running over existing content.
	private(set) var isReplacing = false
	/// The last `.refresh` failed while content stayed on screen. Cleared by
	/// the next successful load.
	private(set) var refreshError: MapleAPIError?
	/// Bumped by every superseding load. Pagination captures it before a page
	/// request and drops the page if it moved.
	private(set) var generation = 0

	private let session: SessionController
	/// This screen's name, for `screen.load` and the session transcript. Passed
	/// in rather than derived from `Value`: `ScreenLoader<[ErrorIssue]>` is both
	/// the Issues tab and a service's issue list.
	let screen: String
	private let isEmpty: @MainActor (Value) -> Bool
	private let fetch: @MainActor () async throws -> Value
	private var current: Task<Void, Never>?

	/// - Parameters:
	///   - isEmpty: maps a loaded value to `.empty`, so "no services in the
	///     last hour" is a sentence rather than a blank list.
	///   - fetch: the screen's request(s). Throws `MapleAPIError` or
	///     `CancellationError`.
	init(
		session: SessionController,
		screen: String,
		isEmpty: @escaping @MainActor (Value) -> Bool = { _ in false },
		fetch: @escaping @MainActor () async throws -> Value
	) {
		self.session = session
		self.screen = screen
		self.isEmpty = isEmpty
		self.fetch = fetch
	}

	func load(_ reason: LoadReason) async {
		switch reason {
		case .refresh:
			// Join an in-flight load instead of stacking a second one behind
			// it — a pull during the tick, or two quick pulls, is one request.
			//
			// Asked of the registry rather than of `current`, because the load
			// worth joining may belong to a previous instance of this model.
			if let running = session.loads.inFlightTask(for: screen) {
				await running.value
				return
			}
		case .initial, .replace:
			// Supersede whatever is loading this screen — including a load a
			// previous model instance started. `current?.cancel()` alone could
			// not reach that one: `.task(id: dataGeneration)` rebuilds the model
			// on an organization switch, so the new instance's `current` is nil
			// and the old instance's load ran to completion beside it.
			session.loads.supersede(screen)
			current = nil
		}

		generation += 1
		let mine = generation
		switch reason {
		case .initial:
			state = .loading
			refreshError = nil
		case .replace:
			isReplacing = state.hasContent
			if !state.hasContent { state = .loading }
			refreshError = nil
		case .refresh:
			break
		}
		isLoading = true

		let task = Task { [session, fetch, screen] in
			// The span opened here is the parent of every request `fetch` makes
			// — including the retry `perform` runs after a 401, which is the
			// only place that retry is visible at all.
			let next = await Telemetry.screenLoad(
				screen: screen,
				reason: reason,
				organizationId: session.currentOrganizationId
			) {
				await session.perform { try await fetch() }
			}
			// A superseded load, or a cancelled one (`nil`), writes nothing:
			// the load that replaced it owns the screen now.
			guard mine == self.generation else { return }
			self.finish(next, reason: reason)
		}
		current = task
		session.loads.register(screen, task)
		await task.value
		// Retire only if this load is still the registered one — a superseded
		// load finishing late must not clear the entry belonging to the load
		// that replaced it.
		session.loads.retire(screen, task)
		if mine == generation { current = nil }
	}

	/// The screen appeared (or re-appeared): start the first load unless one
	/// already ran or is running. Re-appearing while the first load is still
	/// in flight must not restart it.
	func loadIfNeeded() async {
		guard !state.hasContent, !isLoading else { return }
		await load(.initial)
	}

	/// The error state's button and the refresh strip's button.
	func retry() {
		Task { await load(state.hasContent ? .refresh : .initial) }
	}

	private func finish(_ next: LoadState<Value>?, reason: LoadReason) {
		isLoading = false
		isReplacing = false
		guard let next else { return }
		switch next {
		case .loaded(let value):
			state = isEmpty(value) ? .empty : .loaded(value)
			refreshError = nil
		case .failed(let error):
			if reason == .refresh, state.hasContent {
				refreshError = error
			} else {
				state = .failed(error)
			}
		case .loading, .empty:
			state = next
		}
	}

	/// Replace the loaded value in place — used by pagination to append a
	/// page. Ignored if a newer load has taken over since `generation` was
	/// read, or if the screen is no longer showing content.
	func update(ifGeneration expected: Int, _ transform: (Value) -> Value) {
		guard expected == generation, case .loaded(let value) = state else { return }
		state = .loaded(transform(value))
	}
}

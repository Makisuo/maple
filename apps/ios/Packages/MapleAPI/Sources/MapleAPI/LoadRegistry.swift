import Foundation

/// Which load is currently running for each screen, across every model instance.
///
/// `ScreenLoader` already cancels a running load when a superseding one starts —
/// but it cancels `current`, its *own* in-flight task, and that is not the same
/// thing. `HomeView` observes `session.dataGeneration` with `.task(id:)`, so an
/// organization switch builds a whole new `HomeModel` with a whole new
/// `ScreenLoader`, whose `current` is nil. It has nothing to cancel, and the
/// previous instance's load runs to completion beside it.
///
/// Production traces caught exactly that:
///
///     07:46:31  Home       refresh   12616ms
///     07:46:33  Incidents  initial   10737ms
///     07:46:40  Home       initial    5307ms   ← starts while the refresh runs
///
/// Three loads overlapping in one session, two of them for the same screen, with
/// the slow one holding a twelve-second span open.
///
/// Keying by screen name rather than by instance is what fixes it: the registry
/// outlives any one model, so "supersede whatever is loading Home" means the same
/// thing no matter which instance says it.
@MainActor
public final class LoadRegistry {
	private var inFlight: [String: Task<Void, Never>] = [:]

	public init() {}

	/// The load currently running for this screen, if any — whoever started it.
	public func inFlightTask(for screen: String) -> Task<Void, Never>? {
		inFlight[screen]
	}

	/// Cancel whatever is loading this screen. For `initial` and `replace`, where
	/// the rows on screen no longer answer the question being asked.
	public func supersede(_ screen: String) {
		inFlight.removeValue(forKey: screen)?.cancel()
	}

	public func register(_ screen: String, _ task: Task<Void, Never>) {
		inFlight[screen] = task
	}

	/// Retire a finished load — but only if it is still the registered one. A
	/// load that was superseded must not clear the entry belonging to the load
	/// that replaced it.
	public func retire(_ screen: String, _ task: Task<Void, Never>) {
		if inFlight[screen] == task { inFlight.removeValue(forKey: screen) }
	}

	/// Loads currently registered. For tests.
	public var activeCount: Int { inFlight.count }
}

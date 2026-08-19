import BackgroundTasks
import Foundation
import os

/// Keeps the widget moving while the app is closed.
///
/// `BGAppRefreshTask` is opportunistic: iOS decides when — and whether — to run
/// it, from how often the app is actually used. So this is the floor, not the
/// mechanism. Foreground refreshes and pushes are what make the widget feel
/// live; this is what stops it going a whole workday stale on a phone in a
/// pocket, and it is why the widget renders its own age rather than implying
/// the numbers are current.
enum WidgetRefreshScheduler {
	/// Must also appear in `BGTaskSchedulerPermittedIdentifiers` in
	/// Info.plist. iOS raises `NSInternalInconsistencyException` at
	/// registration if it does not — a launch crash, not a silent no-op.
	static let taskIdentifier = "com.maple.mobile.refresh-issues"

	/// Fifteen minutes is the shortest interval the system will honour, and it
	/// matches the widget's own timeline cadence. Asking for less does not make
	/// it happen sooner.
	private static let earliestInterval: TimeInterval = 15 * 60

	private static let log = Logger(subsystem: "com.maple.mobile", category: "widget-refresh")

	/// Register at launch, before the app finishes `didFinishLaunching` —
	/// registering later throws.
	static func register() {
		// `.main` rather than the default background queue: the work is one
		// request and a `UserDefaults` write, and running the handler where the
		// publisher already lives means `BGTask` — which is not `Sendable` —
		// never crosses an isolation boundary.
		BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: .main) { task in
			guard let task = task as? BGAppRefreshTask else { return }
			handle(task)
		}
	}

	/// Ask for the next run. Called on every background transition: a request
	/// is only pending until it runs, so re-submitting is how the chain keeps
	/// going.
	static func schedule() {
		let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
		request.earliestBeginDate = Date(timeIntervalSinceNow: earliestInterval)
		do {
			try BGTaskScheduler.shared.submit(request)
		} catch {
			// Expected on the simulator (`BGTaskSchedulerErrorCodeUnavailable`)
			// and when the user has turned Background App Refresh off. Neither
			// is worth a user-visible anything — the widget still updates every
			// time the app is opened.
			log.debug("Background refresh not scheduled: \(error.localizedDescription, privacy: .public)")
		}
	}

	private static func handle(_ task: BGAppRefreshTask) {
		// Chain the next one first: if the refresh below hangs and the system
		// kills us, a request is already queued rather than the chain quietly
		// ending here.
		schedule()

		// `BGTask` is not `Sendable` and cannot become so: the system hands one
		// object to one handler and expects that object back. The unsafe part
		// is therefore not exercised — the task is registered with `.main`, and
		// both touches below happen there.
		nonisolated(unsafe) let task = task
		let work = Task { @MainActor in
			await WidgetPublisher.shared.refresh(trigger: .background, force: true)
			task.setTaskCompleted(success: true)
		}

		// The system's warning that our slice is up. Not obeying it costs the
		// app future background time.
		task.expirationHandler = { work.cancel() }
	}
}

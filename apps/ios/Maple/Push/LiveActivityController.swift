import ActivityKit
import Foundation
import Maple
import MapleAPI
import MapleWidgetData
import Observation

/// Lock Screen Live Activities for critical incidents.
///
/// A Live Activity needs two APNs tokens that the ordinary notification token
/// cannot stand in for:
///
/// - the **push-to-start token**, one per install, which lets the server create
///   an activity on a locked phone that has not opened the app. It rides along
///   on the device registration (`PushRegistrar.sync`).
/// - the **update token**, one per running activity, which only exists once the
///   activity is running and is handed to the app rather than to the server —
///   so the app posts it back. Without it the activity would start and then
///   freeze on the numbers it started with.
///
/// Both are observed here, for the lifetime of the app, and both are best
/// effort: a phone that cannot run activities still gets every notification.
@MainActor
@Observable
final class LiveActivityController {
	static let shared = LiveActivityController()

	/// False when the user has turned Live Activities off for Maple, or the OS
	/// cannot run them. Shown in the notification settings sheet, because
	/// otherwise the feature is simply missing with no explanation.
	private(set) var areActivitiesEnabled = false
	/// Hex, once iOS has issued one. Nil on the simulator and before the first
	/// activity subscription settles.
	private(set) var pushToStartToken: String?
	/// Last failure posting a token, for the settings sheet.
	private(set) var lastError: String?

	private var context: Context?
	private var observers: [Task<Void, Never>] = []
	/// One pair of observation tasks per activity id, cancelled when it ends.
	private var activityObservers: [String: [Task<Void, Never>]] = [:]

	struct Context {
		var api: any MapleAPI
		var organizationId: String
	}

	private init() {}

	/// Called once the app knows who is signed in. The observation tasks are
	/// started on the first call and left running: activities outlive any one
	/// screen, and iOS delivers a push-to-start token whether or not anything is
	/// on screen to receive it.
	func configure(api: any MapleAPI, organizationId: String) {
		context = Context(api: api, organizationId: organizationId)
		refreshAuthorization()
		startObserving()
		// An org switch changes which org's incidents this phone should be told
		// about; the tokens are the same, but the server keys them per org.
		Task { await resubmitRunningActivities() }
	}

	func refreshAuthorization() {
		areActivitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
	}

	/// Sign-out: stop watching, and end anything still on the Lock Screen. A
	/// resolved-looking incident from an org the user just left is worse than an
	/// empty Lock Screen.
	func stop() async {
		observers.forEach { $0.cancel() }
		observers.removeAll()
		activityObservers.values.flatMap { $0 }.forEach { $0.cancel() }
		activityObservers.removeAll()
		for activity in Activity<IncidentActivityAttributes>.activities {
			await activity.end(nil, dismissalPolicy: .immediate)
		}
		context = nil
		pushToStartToken = nil
	}

	// MARK: Observation

	private func startObserving() {
		guard observers.isEmpty else { return }

		// The push-to-start token. iOS may reissue it at any time; the last one
		// wins and re-registers the device.
		observers.append(
			Task { [weak self] in
				for await data in Activity<IncidentActivityAttributes>.pushToStartTokenUpdates {
					guard let self else { return }
					await MainActor.run { self.pushToStartToken = Self.hex(data) }
				}
			}
		)

		// Activities started by a push arrive here, as do ones started locally.
		observers.append(
			Task { [weak self] in
				for await activity in Activity<IncidentActivityAttributes>.activityUpdates {
					guard let self else { return }
					await MainActor.run { self.observe(activity) }
				}
			}
		)

		// Anything already running from before this launch — the app was killed
		// while an incident was open, which is the normal case for a phone in a
		// pocket.
		for activity in Activity<IncidentActivityAttributes>.activities {
			observe(activity)
		}
	}

	private func observe(_ activity: Activity<IncidentActivityAttributes>) {
		guard activityObservers[activity.id] == nil else { return }
		let incidentId = activity.attributes.incidentId

		let tokens = Task { [weak self] in
			for await data in activity.pushTokenUpdates {
				guard let self else { return }
				await self.submit(
					activityId: activity.id,
					incidentId: incidentId,
					pushToken: Self.hex(data)
				)
			}
		}

		let states = Task { [weak self] in
			for await state in activity.activityStateUpdates {
				guard let self else { return }
				switch state {
				case .dismissed, .ended:
					await self.forget(activityId: activity.id, incidentId: incidentId)
				// `stale` is still on screen — the content is old, not gone, and
				// the next push is what fixes it.
				case .active, .stale:
					break
				@unknown default:
					break
				}
			}
		}

		activityObservers[activity.id] = [tokens, states]
	}

	/// After an org switch: the tokens are unchanged, but the new org's server
	/// rows know nothing about them.
	private func resubmitRunningActivities() async {
		for activity in Activity<IncidentActivityAttributes>.activities {
			guard let data = activity.pushToken else { continue }
			await submit(
				activityId: activity.id,
				incidentId: activity.attributes.incidentId,
				pushToken: Self.hex(data)
			)
		}
	}

	// MARK: Fixtures

	/// Starts an activity locally, with sample content, for fixture mode.
	///
	/// The real path is push-to-start, which the simulator cannot receive — so
	/// without this the Lock Screen card can only be looked at on a device with
	/// a live incident, which is not a way to design one. Never reachable in a
	/// real session: the button that calls it is behind `FixtureAPI.isEnabled`.
	func startPreviewActivity() {
		guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
		_ = try? Activity.request(
			attributes: IncidentActivityAttributes.sample,
			content: ActivityContent(
				state: .sample,
				staleDate: Date().addingTimeInterval(20 * 60)
			),
			// No push token: this one is driven by nothing and simply sits there.
			pushType: nil
		)
	}

	// MARK: Server

	/// Posting an activity's update token is what stops a Lock Screen card
	/// freezing on the numbers it started with. It fails silently by design, so
	/// the span is the only place that failure is ever recorded.
	private func submit(activityId: String, incidentId: String, pushToken: String) async {
		guard let context, let deviceToken = PushRegistrar.shared.deviceToken else { return }
		await Telemetry.span(
			Telemetry.Name.liveActivitySubmit,
			attributes: [Telemetry.Key.liveActivityAction: .string("register")]
		) { span in
			await self.submit(
				context: context,
				deviceToken: deviceToken,
				activityId: activityId,
				incidentId: incidentId,
				pushToken: pushToken,
				span: span
			)
		}
	}

	private func submit(
		context: Context,
		deviceToken: String,
		activityId: String,
		incidentId: String,
		pushToken: String,
		span: Span?
	) async {
		do {
			try await context.api.registerLiveActivity(
				deviceToken: deviceToken,
				incidentId: incidentId,
				activityId: activityId,
				pushToken: pushToken
			)
			lastError = nil
		} catch is CancellationError {
		} catch {
			// The activity keeps whatever content it started with rather than
			// updating — degraded, not broken, so nothing is torn down here.
			let apiError = error as? MapleAPIError
			lastError = apiError?.message ?? error.localizedDescription
			span?.setAttribute(Telemetry.Key.errorType, apiError?.telemetryType ?? "transport")
			span?.setStatus(.error(lastError ?? "live activity registration failed"))
		}
	}

	private func forget(activityId: String, incidentId: String) async {
		if let context, let deviceToken = PushRegistrar.shared.deviceToken {
			await Telemetry.span(
				Telemetry.Name.liveActivityEnd,
				attributes: [Telemetry.Key.liveActivityAction: .string("end")]
			) { _ in
				try? await context.api.endLiveActivity(deviceToken: deviceToken, incidentId: incidentId)
			}
		}
		// After the request, not before: this cancels the task that is running
		// this very function, and a cancelled task cannot make a network call.
		activityObservers.removeValue(forKey: activityId)?.forEach { $0.cancel() }
	}

	private static func hex(_ data: Data) -> String {
		data.map { String(format: "%02x", $0) }.joined()
	}
}

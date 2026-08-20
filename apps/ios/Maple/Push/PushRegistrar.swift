import Foundation
import Maple
import MapleAPI
import MapleWidgetData
import Observation
import UIKit
import UserNotifications

/// Owns everything push: the permission, the APNs token, keeping the server's
/// registration in step with (token, organization, preferences), and turning a
/// tapped notification into navigation.
///
/// Registration is **per organization**: the server keys a device on
/// (org, token), so an account in two orgs registers twice and receives both.
/// The set of orgs this phone has registered with is remembered so sign-out
/// can unregister all of them — a token left behind in an org the user no
/// longer opens would keep buzzing them.
@MainActor
@Observable
final class PushRegistrar: NSObject {
	static let shared = PushRegistrar()

	enum Authorization: Equatable {
		case unknown
		case notDetermined
		case denied
		case authorized
	}

	private(set) var authorization: Authorization = .unknown
	/// The APNs token, hex, once the system has handed it over. Nil on the
	/// simulator and before the first `registerForRemoteNotifications()`.
	private(set) var deviceToken: String?
	/// Last registration failure, for the settings sheet. Cleared on success.
	private(set) var lastError: String?
	/// True while a sync is in flight; the settings sheet dims its toggles.
	private(set) var isSyncing = false

	/// Set by the app at launch so a notification tap can be routed — including
	/// into the organization the alert actually fired in.
	var opener: DestinationOpener?

	private let defaults = UserDefaults.standard
	private let center = UNUserNotificationCenter.current()

	private enum Key {
		static let prompted = "push.promptedOnce"
		static func preferences(_ orgId: String) -> String { "push.preferences.\(orgId)" }
	}

	override private init() {
		super.init()
	}

	// MARK: Permission

	func refreshAuthorization() async {
		let settings = await center.notificationSettings()
		switch settings.authorizationStatus {
		case .notDetermined: authorization = .notDetermined
		case .denied: authorization = .denied
		case .authorized, .provisional, .ephemeral: authorization = .authorized
		@unknown default: authorization = .unknown
		}
		if authorization == .authorized {
			UIApplication.shared.registerForRemoteNotifications()
		}
	}

	/// Ask once, at a moment that explains itself: the first incident the user
	/// opens, or the settings sheet. Never at launch.
	func promptIfNeeded() async {
		guard !defaults.bool(forKey: Key.prompted) else { return }
		await refreshAuthorization()
		guard authorization == .notDetermined else { return }
		defaults.set(true, forKey: Key.prompted)
		await requestAuthorization()
	}

	@discardableResult
	func requestAuthorization() async -> Bool {
		defaults.set(true, forKey: Key.prompted)
		let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
		// The system prompt is shown once per install and never again — so the
		// answer to it is a fact about this device that no later state records.
		Telemetry.track(Telemetry.Event.notificationsPrompted, ["granted": String(granted)])
		await refreshAuthorization()
		return granted
	}

	// MARK: Token (from the app delegate)

	func didRegister(deviceToken data: Data) {
		deviceToken = data.map { String(format: "%02x", $0) }.joined()
	}

	func didFailToRegister(_ error: any Error) {
		lastError = error.localizedDescription
	}

	// MARK: Preferences

	func preferences(for orgId: String) -> PushPreferences {
		guard let data = defaults.data(forKey: Key.preferences(orgId)),
			let stored = try? JSONDecoder().decode(PushPreferences.self, from: data)
		else { return .default }
		return stored
	}

	func setPreferences(_ preferences: PushPreferences, for orgId: String) {
		if let data = try? JSONEncoder().encode(preferences) {
			defaults.set(data, forKey: Key.preferences(orgId))
		}
	}

	// MARK: Sync

	/// Everything a registration depends on. Screens key a `.task(id:)` on this
	/// so a token arriving, an org switch, or a toggle each trigger exactly one
	/// PUT.
	func syncKey(orgId: String?) -> String {
		[
			deviceToken ?? "-",
			// A push-to-start token arriving after launch has to re-register the
			// device, or the Lock Screen stays dark for every incident until the
			// next org switch.
			LiveActivityController.shared.pushToStartToken ?? "-",
			orgId ?? "-",
			String(describing: authorization),
			orgId.map { preferences(for: $0) }.map { "\($0.hashValue)" } ?? "-",
		].joined(separator: "|")
	}

	/// Register (or refresh) this phone for the active organization.
	func sync(api: any MapleAPI, orgId: String) async {
		guard authorization == .authorized, let deviceToken else { return }
		isSyncing = true
		defer { isSyncing = false }
		await Telemetry.span(
			Telemetry.Name.pushSync,
			attributes: [Telemetry.Key.organizationId: .string(orgId)]
		) { span in
			await self.sync(api: api, orgId: orgId, deviceToken: deviceToken, span: span)
		}
	}

	private func sync(api: any MapleAPI, orgId: String, deviceToken: String, span: Span?) async {
		do {
			_ = try await api.registerDevice(
				DeviceRegistration(
					token: deviceToken,
					environment: PushEnvironmentDetector.current,
					bundleId: Bundle.main.bundleIdentifier ?? "com.maple.mobile",
					appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
					deviceName: UIDevice.current.model,
					preferences: preferences(for: orgId),
					liveActivityStartToken: LiveActivityController.shared.pushToStartToken
				)
			)
			lastError = nil
		} catch is CancellationError {
		} catch {
			// A phone that failed to register is a phone that will not be told
			// about the next incident — the one push failure worth an alert.
			let apiError = error as? MapleAPIError
			lastError = apiError?.message ?? error.localizedDescription
			span?.setAttribute(Telemetry.Key.errorType, apiError?.telemetryType ?? "transport")
			span?.setStatus(.error(lastError ?? "registration failed"))
		}
	}

	/// Sign-out: remove this phone from every org it registered with. Best
	/// effort — the token is dead to the server once the user is gone anyway,
	/// but leaving rows behind means stray pushes until APNs reports it.
	func unregisterAll(api: any MapleAPI) async {
		guard let deviceToken else { return }
		// The token is what matters; the org travels in the session, so a
		// sign-out can only unregister the org whose token we still hold.
		// Other orgs' rows are removed the next time this token registers
		// there and the user signs out from it, or when APNs reports it dead.
		try? await api.unregisterDevice(token: deviceToken)
	}
}

/// Which APNs host the token belongs to. Getting this wrong is not a degraded
/// mode: Apple answers a token sent to the other host with `BadDeviceToken`
/// and the server disables the device, so the phone goes silent.
///
/// Xcode-installed (and ad-hoc) builds carry `aps-environment = development`
/// or `production` in the embedded provisioning profile. **TestFlight and App
/// Store installs have no embedded profile at all** — anything uploaded through
/// App Store Connect is re-signed by Apple, which strips it — and their tokens
/// are production, so "no profile" must mean production. (Observed 2026-08-18:
/// a TestFlight build read as sandbox here, its token went to the sandbox host,
/// Apple answered `BadDeviceToken`, and the server disabled the phone.) The simulator also has no profile, but a simulator token
/// is undeliverable from a server on either host, so nothing is lost by
/// treating it the same way.
enum PushEnvironmentDetector {
	static let current: PushEnvironment = {
		guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
			let data = FileManager.default.contents(atPath: path),
			let text = String(data: data, encoding: .isoLatin1)
		else {
			return .production
		}
		return parse(profile: text)
	}()

	/// The profile is CMS-wrapped XML; the entitlements plist is readable in
	/// the clear. Only a profile that positively says `development` is a
	/// sandbox token — anything else (`production`, or a profile without the
	/// key) is treated as production, the direction that at worst costs a
	/// dev-build push rather than every real user's.
	static func parse(profile text: String) -> PushEnvironment {
		guard let keyRange = text.range(of: "<key>aps-environment</key>") else { return .production }
		let tail = text[keyRange.upperBound...]
		guard let open = tail.range(of: "<string>"),
			let close = tail[open.upperBound...].range(of: "</string>")
		else { return .production }
		let value = tail[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
		return value == "development" ? .sandbox : .production
	}
}

/// APNs and notification callbacks arrive on UIKit's app delegate; this
/// forwards them to the registrar and to `DestinationOpener`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
	func application(
		_ application: UIApplication,
		didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
	) -> Bool {
		UNUserNotificationCenter.current().delegate = self
		// Must happen before `didFinishLaunching` returns — registering a
		// BGTaskScheduler handler later throws.
		WidgetRefreshScheduler.register()
		// The only other caller lives inside `MainTabView`, which exists only in
		// the `.ready` phase — so a user sitting on the sign-in screen, or one
		// who launches and immediately force-quits, never queued a background
		// refresh at all.
		Task { await WidgetRefreshScheduler.scheduleIfNeeded() }
		return true
	}

	/// A push arrived. Whatever it was about, the org's issues just changed —
	/// this is the freshest the widget ever gets without the app being opened.
	///
	/// Runs for a silent (`content-available`) push and for a visible one
	/// delivered while the app has background time; iOS ignores the completion
	/// result beyond deciding how generous to be next time.
	func application(
		_ application: UIApplication,
		didReceiveRemoteNotification userInfo: [AnyHashable: Any],
		fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
	) {
		Task { @MainActor in
			await WidgetPublisher.shared.refresh(trigger: .push, force: true)
			completionHandler(.newData)
		}
	}

	func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		Task { @MainActor in PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
	}

	func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
		Task { @MainActor in PushRegistrar.shared.didFailToRegister(error) }
	}

	/// A push while the app is open still shows as a banner — the user asked
	/// to be told, and the Home screen may be showing something else.
	///
	/// An all-clear arrives without a sound: it is delivered silently by APNs,
	/// and playing one here would put the noise back for exactly the people
	/// already looking at the app.
	///
	/// `nonisolated`: `UIApplicationDelegate` puts the class on the main actor,
	/// but the notification centre calls these off it with non-Sendable
	/// arguments. Everything read from them is reduced to strings before
	/// hopping back.
	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		let event = notification.request.content.userInfo["maple_event"] as? String
		completionHandler(event == "resolve" ? [.banner, .list] : [.banner, .sound, .list])
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let userInfo = response.notification.request.content.userInfo
		let kind = userInfo["maple_kind"] as? String
		let incidentId = userInfo["maple_incident_id"] as? String
		// The organization the alert fired in. Every push has carried it since
		// `MobilePushService` was written; until `DestinationOpener` existed
		// nothing on the device read it, so a tap on another org's alert opened
		// an incident id the active token could not fetch.
		let organizationId = userInfo["maple_org_id"] as? String
		Task { @MainActor in
			switch kind {
			case "alert_incident":
				guard let incidentId else { break }
				// Opens the span that stays live until the incident screen has
				// its data — the alert-to-eyes number. `Telemetry.PushOpen` also
				// makes it the parent of that screen's load, so one trace runs
				// from the tap through to the API spans it caused.
				Telemetry.PushOpen.begin(
					kind: "alert_incident",
					screen: Screen.incidentDetail,
					coldStart: Telemetry.Launch.isColdStart
				)
				Telemetry.track(Telemetry.Event.pushOpened, ["kind": "alert_incident"])
				await PushRegistrar.shared.opener?.open(
					WidgetDeepLink(target: .incident(id: incidentId), organizationId: organizationId),
					source: .push
				)
			case "alert_rule_digest":
				// The stand-in for a storm: one card for the incidents a rule opened
				// past its share of a tick. There is no single incident to open, so
				// it lands on the list they are all in.
				Telemetry.PushOpen.begin(
					kind: "alert_rule_digest",
					screen: Screen.incidents,
					coldStart: Telemetry.Launch.isColdStart
				)
				Telemetry.track(Telemetry.Event.pushOpened, ["kind": "alert_rule_digest"])
				await PushRegistrar.shared.opener?.open(
					WidgetDeepLink(target: .incidentsList, organizationId: organizationId),
					source: .push
				)
			default:
				break
			}
		}
		completionHandler()
	}
}

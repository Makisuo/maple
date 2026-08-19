import Foundation
import OpenAPIRuntime

/// Which alert events a phone wants. Mirrors `MobileDevicePreferences` on the
/// wire; every field is sent so the server's merge is total.
public struct PushPreferences: Hashable, Sendable, Codable {
	public var criticalIncidents: Bool
	public var warningIncidents: Bool
	public var resolvedIncidents: Bool
	public var newErrorIssues: Bool
	public var anomalies: Bool

	public init(
		criticalIncidents: Bool = true,
		warningIncidents: Bool = true,
		resolvedIncidents: Bool = true,
		newErrorIssues: Bool = false,
		anomalies: Bool = false
	) {
		self.criticalIncidents = criticalIncidents
		self.warningIncidents = warningIncidents
		self.resolvedIncidents = resolvedIncidents
		self.newErrorIssues = newErrorIssues
		self.anomalies = anomalies
	}

	/// The server's defaults — what a device gets before it has said anything.
	public static let `default` = PushPreferences()

	public init(_ wire: MobileDevice.PreferencesPayload) {
		self.init(
			criticalIncidents: wire.criticalIncidents,
			warningIncidents: wire.warningIncidents,
			resolvedIncidents: wire.resolvedIncidents,
			newErrorIssues: wire.newErrorIssues,
			anomalies: wire.anomalies
		)
	}

	var wire: Components.Schemas._MapleMobileDevicePreferences {
		.init(
			anomalies: anomalies,
			criticalIncidents: criticalIncidents,
			newErrorIssues: newErrorIssues,
			resolvedIncidents: resolvedIncidents,
			warningIncidents: warningIncidents
		)
	}
}

public struct DeviceRegistration: Hashable, Sendable {
	public var token: String
	public var environment: PushEnvironment
	public var bundleId: String
	public var appVersion: String?
	public var deviceName: String?
	public var preferences: PushPreferences?
	/// ActivityKit's push-to-start token, when the OS has issued one. Nil leaves
	/// whatever the server already has — an app build that cannot produce one
	/// must not erase the token a previous build registered.
	public var liveActivityStartToken: String?

	public init(
		token: String,
		environment: PushEnvironment,
		bundleId: String,
		appVersion: String? = nil,
		deviceName: String? = nil,
		preferences: PushPreferences? = nil,
		liveActivityStartToken: String? = nil
	) {
		self.token = token
		self.environment = environment
		self.bundleId = bundleId
		self.appVersion = appVersion
		self.deviceName = deviceName
		self.preferences = preferences
		self.liveActivityStartToken = liveActivityStartToken
	}
}

extension MapleClient {
	public func registerDevice(_ registration: DeviceRegistration) async throws -> MobileDevice {
		try await mapping {
			let output = try await client.registerMobileDevice(
				.init(
					path: .init(token: registration.token),
					body: .json(
						.init(
							appVersion: registration.appVersion,
							bundleId: registration.bundleId,
							deviceName: registration.deviceName,
							environment: registration.environment,
							liveActivityStartToken: registration.liveActivityStartToken,
							platform: .ios,
							preferences: registration.preferences?.wire
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	public func unregisterDevice(token: String) async throws {
		try await mapping {
			_ = try await client.unregisterMobileDevice(.init(path: .init(token: token))).ok
		}
	}

	/// Hands the server the update token for an activity this phone just
	/// started, so incident updates and the final "resolved" can reach it.
	public func registerLiveActivity(
		deviceToken: String,
		incidentId: String,
		activityId: String,
		pushToken: String
	) async throws {
		try await mapping {
			_ = try await client.registerLiveActivity(
				.init(
					path: .init(token: deviceToken, incidentId: incidentId),
					body: .json(.init(activityId: activityId, pushToken: pushToken))
				)
			).ok
		}
	}

	/// The activity is gone from this phone — dismissed, or ended locally.
	public func endLiveActivity(deviceToken: String, incidentId: String) async throws {
		try await mapping {
			_ = try await client.endLiveActivity(
				.init(path: .init(token: deviceToken, incidentId: incidentId))
			).ok
		}
	}

	public func myDevices() async throws -> [MobileDevice] {
		try await mapping {
			try await client.listMobileDevices(.init()).ok.body.json.data
		}
	}
}

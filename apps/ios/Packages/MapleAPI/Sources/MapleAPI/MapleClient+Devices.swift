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

	public init(
		token: String,
		environment: PushEnvironment,
		bundleId: String,
		appVersion: String? = nil,
		deviceName: String? = nil,
		preferences: PushPreferences? = nil
	) {
		self.token = token
		self.environment = environment
		self.bundleId = bundleId
		self.appVersion = appVersion
		self.deviceName = deviceName
		self.preferences = preferences
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

	public func myDevices() async throws -> [MobileDevice] {
		try await mapping {
			try await client.listMobileDevices(.init()).ok.body.json.data
		}
	}
}

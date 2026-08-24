import Foundation
import OpenAPIRuntime

extension MapleClient {
	public func alertIncidents(
		status: AlertIncidentStatus? = nil,
		ruleId: String? = nil,
		limit: Int = 20,
		cursor: String? = nil
	) async throws -> Page<AlertIncident> {
		try await mapping {
			let output = try await client.listAlertIncidents(
				.init(query: .init(limit: String(limit), cursor: cursor, status: status, ruleId: ruleId))
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func alertIncident(id: String) async throws -> AlertIncident {
		try await mapping {
			try await client.getAlertIncident(.init(path: .init(id: id))).ok.body.json
		}
	}

	public func alertRules(limit: Int = 100, cursor: String? = nil) async throws -> Page<AlertRule> {
		try await mapping {
			let output = try await client.listAlertRules(.init(query: .init(limit: String(limit), cursor: cursor)))
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func alertRule(id: String) async throws -> AlertRule {
		try await mapping {
			try await client.getAlertRule(.init(path: .init(id: id))).ok.body.json
		}
	}

	/// The rule's recent evaluations, **oldest first** — the order a chart wants.
	/// The server returns newest first; one page is enough for a screen.
	public func alertRuleChecks(
		ruleId: String,
		groupKey: String? = nil,
		since: Date? = nil,
		limit: Int = 100
	) async throws -> [AlertCheck] {
		try await mapping {
			let output = try await client.listAlertRuleChecks(
				.init(
					path: .init(id: ruleId),
					query: .init(
						limit: String(limit),
						groupKey: groupKey,
						since: since.map(ResolvedTimeWindow.format)
					)
				)
			)
			return try output.ok.body.json.data.sorted { $0.timestamp < $1.timestamp }
		}
	}

	public func alertDeliveries(incidentId: String, limit: Int = 50) async throws -> [AlertDelivery] {
		try await mapping {
			let output = try await client.listAlertDeliveries(
				.init(query: .init(limit: String(limit), incidentId: incidentId))
			)
			return try output.ok.body.json.data
		}
	}

	public func anomalyIncidents(
		status: AnomalyIncidentStatus? = nil,
		serviceName: String? = nil,
		window: ResolvedTimeWindow? = nil,
		limit: Int = 20,
		cursor: String? = nil
	) async throws -> Page<AnomalyIncident> {
		try await mapping {
			let output = try await client.listAnomalyIncidents(
				.init(
					query: .init(
						limit: String(limit),
						cursor: cursor,
						status: status,
						serviceName: serviceName,
						// `deployment_env`, not `deployment_environment`: this is the
						// one v2 endpoint that spells the parameter short, and the
						// generated names follow the wire.
						deploymentEnv: environment,
						startTime: window?.startTime,
						endTime: window?.endTime
					)
				)
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func anomalyIncident(id: String) async throws -> AnomalyIncident {
		try await mapping {
			try await client.getAnomalyIncident(.init(path: .init(id: id))).ok.body.json
		}
	}

	/// Defaults to the incident's own window server-side.
	public func anomalyIncidentTimeseries(id: String) async throws -> AnomalyIncidentTimeseries {
		try await mapping {
			try await client.getAnomalyIncidentTimeseries(.init(path: .init(id: id))).ok.body.json
		}
	}
}

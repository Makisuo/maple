import Foundation
import MapleAPI

/// One open incident as Home shows it: the incident, the services its rule
/// covers, and the rule's last hour of observations for the sparkline.
struct IncidentCard: Identifiable, Hashable {
	let incident: AlertIncident
	let serviceNames: [String]
	let display: SignalDisplay
	/// Observed values from the rule's own checks, oldest first. Empty until
	/// loaded, and stays empty for a rule whose checks failed to load — the
	/// card is still worth showing.
	var observations: [Double]

	var id: String { incident.id }

	static func == (lhs: IncidentCard, rhs: IncidentCard) -> Bool {
		lhs.incident == rhs.incident && lhs.observations == rhs.observations && lhs.serviceNames == rhs.serviceNames
	}

	func hash(into hasher: inout Hasher) {
		hasher.combine(incident.id)
		hasher.combine(incident.lastTriggeredAt)
	}
}

/// What Home knows about the org right now.
struct HomeSnapshot {
	var services: [Service]
	var incidents: [IncidentCard]
	/// Error issues first seen inside the last 24 hours.
	var newIssues: Int
	/// Actionable issues seen in the last 24 hours that are older than that.
	var activeIssues: Int
	var openAnomalies: Int
	var loadedAt: Date

	// MARK: Derived

	var unhealthy: [Service] { services.filter { health(of: $0) == .unhealthy } }
	var degraded: [Service] { services.filter { health(of: $0) == .degraded } }
	var criticalIncidents: [IncidentCard] { incidents.filter { $0.incident.severity == .critical } }

	/// Services that need attention, worst first. Health first, then error
	/// rate, then volume — the same ordering as the Services tab.
	var attention: [Service] {
		(unhealthy + degraded).sorted { a, b in
			let ha = health(of: a)
			let hb = health(of: b)
			if ha != hb { return ha == .unhealthy }
			if a.errorRate != b.errorRate { return a.errorRate > b.errorRate }
			return a.throughput > b.throughput
		}
	}

	/// The overall status Home leads with. Worst thing wins: a critical
	/// incident beats a degraded service, no data beats everything — an org
	/// that stopped sending is not healthy, it's dark.
	var status: OverallStatus {
		if services.isEmpty && incidents.isEmpty { return .noData }
		if !criticalIncidents.isEmpty || !unhealthy.isEmpty { return .critical }
		if !incidents.isEmpty || !degraded.isEmpty { return .degraded }
		return .healthy
	}

	var headline: String {
		switch status {
		case .noData:
			return "No telemetry in the last hour"
		case .healthy:
			return services.count == 1 ? "Your service is healthy" : "All \(services.count) services healthy"
		case .degraded:
			let count = degraded.count
			if count == 0 { return incidents.count == 1 ? "1 open alert" : "\(incidents.count) open alerts" }
			return count == 1 ? "1 service degraded" : "\(count) services degraded"
		case .critical:
			let count = unhealthy.count
			if count == 0 {
				return criticalIncidents.count == 1 ? "1 critical alert" : "\(criticalIncidents.count) critical alerts"
			}
			return count == 1 ? "1 service unhealthy" : "\(count) services unhealthy"
		}
	}

	/// The second line: everything the headline didn't say, as counts.
	var subheadline: String {
		var parts: [String] = []
		let critical = criticalIncidents.count
		let warnings = incidents.count - critical
		if status == .critical, !unhealthy.isEmpty, critical > 0 {
			parts.append(critical == 1 ? "1 critical alert" : "\(critical) critical alerts")
		}
		if warnings > 0 { parts.append(warnings == 1 ? "1 warning" : "\(warnings) warnings") }
		if status == .critical, !degraded.isEmpty { parts.append("\(degraded.count) degraded") }
		if newIssues > 0 { parts.append(newIssues == 1 ? "1 new issue" : "\(newIssues) new issues") }
		if openAnomalies > 0 { parts.append(openAnomalies == 1 ? "1 anomaly" : "\(openAnomalies) anomalies") }
		if parts.isEmpty {
			switch status {
			case .noData: return "Nothing reported by any service."
			case .healthy: return "No open alerts, nothing new to triage."
			case .degraded, .critical: return "No other signals out of range."
			}
		}
		return parts.joined(separator: " · ")
	}

	private func health(of service: Service) -> ServiceHealth {
		ServiceHealth(errorRate: service.errorRate, p95LatencyMs: service.p95LatencyMs)
	}
}

enum OverallStatus {
	case noData
	case healthy
	case degraded
	case critical
}

@MainActor
@Observable
final class HomeModel {
	private(set) var loader: ScreenLoader<HomeSnapshot>!
	/// The `SessionController.dataGeneration` this model was built for; the
	/// view builds a fresh one when it moves, so one org's board never lingers
	/// while the next org loads.
	let generation: Int

	private let api: any MapleAPI

	/// Home is always "now": an hour for rates, a day for what's new. There is
	/// no time picker on purpose — a picker answers "what happened", and that
	/// is a question for the other tabs.
	static let rateWindow = TimeWindow.lastHour
	static let recentWindow = TimeWindow.last24Hours

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<HomeSnapshot> { loader.state }

	private func fetch() async throws -> HomeSnapshot {
		let now = Date()
		let rates = Self.rateWindow.resolve(now: now)
		let recent = Self.recentWindow.resolve(now: now)

		// Services and open incidents are the screen. The rest is decoration
		// and must not take the screen down with it.
		async let servicesTask = api.services(window: rates, limit: 100)
		async let incidentsTask = api.alertIncidents(status: .open, ruleId: nil, limit: 50, cursor: nil)
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)
		async let issuesTask = api.issues(
			query: IssueQuery(actionableOnly: true, sort: .lastSeen), window: recent, limit: 100, cursor: nil
		)
		async let anomaliesTask = api.anomalyIncidents(
			status: .open, serviceName: nil, window: nil, limit: 100, cursor: nil
		)

		let services = try await servicesTask.items
		let incidents = try await incidentsTask.items
		let rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		let issues = (try? await issuesTask.items) ?? []
		let anomalies = (try? await anomaliesTask.items) ?? []

		let dayAgo = recent.start
		let newIssues = issues.filter { issue in
			guard let firstSeen = ResolvedTimeWindow.parse(issue.firstSeenAt) else { return false }
			return firstSeen >= dayAgo
		}.count

		var cards = incidents.map { incident in
			let rule = rules[incident.ruleId]
			return IncidentCard(
				incident: incident,
				serviceNames: rule?.serviceNames ?? [],
				display: rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType),
				observations: []
			)
		}
		// Critical first, then most recently triggered.
		cards.sort { a, b in
			if a.incident.severity != b.incident.severity { return a.incident.severity == .critical }
			return a.incident.lastTriggeredAt > b.incident.lastTriggeredAt
		}

		// One checks request per card, bounded: the first eight cards are the
		// ones on screen; the rest get a sparkline when tapped into.
		let observations = await withTaskGroup(of: (Int, [Double]).self, returning: [Int: [Double]].self) { group in
			for (index, card) in cards.prefix(8).enumerated() {
				group.addTask { [api] in
					let checks = try? await api.alertRuleChecks(
						ruleId: card.incident.ruleId,
						groupKey: card.incident.groupKey,
						since: rates.start,
						limit: 60
					)
					return (index, (checks ?? []).compactMap(\.observedValue))
				}
			}
			var result: [Int: [Double]] = [:]
			for await (index, values) in group { result[index] = values }
			return result
		}
		for (index, values) in observations { cards[index].observations = values }

		return HomeSnapshot(
			services: services,
			incidents: cards,
			newIssues: newIssues,
			activeIssues: max(0, issues.count - newIssues),
			openAnomalies: anomalies.count,
			loadedAt: now
		)
	}
}

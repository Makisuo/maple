import Foundation
import MapleAPI

/// One open incident as Home shows it: the incident, the services its rule
/// covers, and the rule's last hour of observations for the sparkline.
struct IncidentCard: Identifiable, Hashable, Codable {
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
///
/// Codable because the last board is persisted per (org, environment) and
/// seeded on the next launch — see `SnapshotCache`.
struct HomeSnapshot: Codable {
	var services: [Service]
	var incidents: [IncidentCard]
	/// Error issues first seen inside the last 24 hours. The counts are
	/// optional because they are second-pass data: the board paints on
	/// services and incidents alone, and `nil` means "still on its way" —
	/// which is a different statement from 0.
	var newIssues: Int?
	/// Actionable issues seen in the last 24 hours that are older than that.
	var activeIssues: Int?
	var openAnomalies: Int?
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

	/// The second line: everything the headline didn't say, as counts. The
	/// second-pass numbers join it only once they exist — a sentence must not
	/// claim "0 new issues" while the count is still loading.
	var subheadline: String {
		var parts: [String] = []
		let critical = criticalIncidents.count
		let warnings = incidents.count - critical
		if status == .critical, !unhealthy.isEmpty, critical > 0 {
			parts.append(critical == 1 ? "1 critical alert" : "\(critical) critical alerts")
		}
		if warnings > 0 { parts.append(warnings == 1 ? "1 warning" : "\(warnings) warnings") }
		if status == .critical, !degraded.isEmpty { parts.append("\(degraded.count) degraded") }
		if let newIssues, newIssues > 0 {
			parts.append(newIssues == 1 ? "1 new issue" : "\(newIssues) new issues")
		}
		if let openAnomalies, openAnomalies > 0 {
			parts.append(openAnomalies == 1 ? "1 anomaly" : "\(openAnomalies) anomalies")
		}
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
		ServiceHealth(service: service)
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
	/// The organization and environment this model was built for; the view
	/// builds a fresh one when either moves, so one scope's board never lingers
	/// while the next one loads.
	let scope: SessionController.DataScope

	private let api: any MapleAPI
	/// The cache key's stable half. `scope.generation` moves every sign-in, so
	/// the persisted board is keyed on the organization itself.
	private let organizationId: String?
	/// The in-flight second pass, so a new load can cancel the previous one
	/// instead of racing it.
	private var decorations: Task<Void, Never>?

	/// Home is always "now": an hour for rates, a day for what's new. There is
	/// no time picker on purpose — a picker answers "what happened", and that
	/// is a question for the other tabs.
	static let rateWindow = TimeWindow.lastHour
	static let recentWindow = TimeWindow.last24Hours

	init(api: any MapleAPI, session: SessionController, scope: SessionController.DataScope) {
		self.api = api
		self.scope = scope
		self.organizationId = session.currentOrganizationId
		self.loader = ScreenLoader(session: session, screen: Screen.home) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<HomeSnapshot> { loader.state }

	/// First appearance for this scope: paint the persisted board if there is
	/// one and revalidate it, otherwise load cold. The seeded path refreshes
	/// rather than initial-loads so the cached content stays on screen and a
	/// failure becomes the refresh strip instead of the error panel.
	func start() async {
		if !loader.state.hasContent, !loader.isLoading, let organizationId,
			let cached = SnapshotCache.load(
				HomeSnapshot.self,
				screen: Screen.home,
				organizationId: organizationId,
				environment: scope.environment
			)
		{
			loader.seed(cached)
			await loader.load(.refresh)
			return
		}
		await loader.loadIfNeeded()
	}

	/// The first pass: only what gates the paint.
	///
	/// Services and open incidents *are* the screen, so they alone are awaited
	/// here — the `screen.load` span now measures time-to-content. Issue and
	/// anomaly counts and the sparklines are a second pass over the loaded
	/// board (`scheduleDecorations`), because making the first paint wait for
	/// the slowest of thirteen requests is what made Home feel broken.
	private func fetch() async throws -> HomeSnapshot {
		decorations?.cancel()
		let now = Date()
		let rates = Self.rateWindow.resolve(now: now)
		let recent = Self.recentWindow.resolve(now: now)

		async let servicesTask = api.services(window: rates, limit: 100)
		async let incidentsTask = api.alertIncidents(status: .open, ruleId: nil, limit: 50, cursor: nil)
		// Rules ride in the first pass: they name the incident cards. Still
		// decoration in the failure sense — a card without its rule falls back
		// to the signal type rather than taking the screen down.
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)

		let services = try await servicesTask.items
		let incidents = try await incidentsTask.items
		let rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)

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

		// A refresh must not blank the numbers it already has: the previous
		// pass's counts and sparklines stay up until the new pass lands.
		let previous = loader.state.value
		let previousObservations = Dictionary(
			(previous?.incidents ?? []).map { ($0.id, $0.observations) },
			uniquingKeysWith: { first, _ in first }
		)
		for index in cards.indices {
			if let kept = previousObservations[cards[index].id] { cards[index].observations = kept }
		}

		scheduleDecorations(cards: cards, rates: rates, recent: recent)

		return HomeSnapshot(
			services: services,
			incidents: cards,
			newIssues: previous?.newIssues,
			activeIssues: previous?.activeIssues,
			openAnomalies: previous?.openAnomalies,
			loadedAt: now
		)
	}

	/// What the second pass produced. Counts stay `nil` on failure so the
	/// merge can tell "request failed, keep what we had" from "genuinely 0".
	private struct Decorations: Sendable {
		var newIssues: Int?
		var activeIssues: Int?
		var openAnomalies: Int?
		var observations: [String: [Double]] = [:]
	}

	/// The second pass: issue counts, anomaly counts, sparklines — fetched
	/// after the board is on screen and merged into it in place.
	private func scheduleDecorations(cards: [IncidentCard], rates: ResolvedTimeWindow, recent: ResolvedTimeWindow) {
		// Captured before the task starts: if a newer load supersedes this one,
		// `update(ifGeneration:)` drops the merge on the floor.
		let generation = loader.generation
		let api = self.api
		decorations = Task { [weak self] in
			let decorations = await Telemetry.screenDecorations(
				screen: Screen.home,
				organizationId: self?.organizationId
			) {
				async let issuesTask = api.issues(
					query: IssueQuery(actionableOnly: true, sort: .lastSeen), window: recent, limit: 100, cursor: nil
				)
				async let anomaliesTask = api.anomalyIncidents(
					status: .open, serviceName: nil, window: nil, limit: 100, cursor: nil
				)
				async let observationsTask = Self.observations(for: cards, api: api, since: rates.start)

				var result = Decorations()
				if let issues = try? await issuesTask.items {
					let dayAgo = recent.start
					let newIssues = issues.filter { issue in
						guard let firstSeen = ResolvedTimeWindow.parse(issue.firstSeenAt) else { return false }
						return firstSeen >= dayAgo
					}.count
					result.newIssues = newIssues
					result.activeIssues = max(0, issues.count - newIssues)
				}
				if let anomalies = try? await anomaliesTask.items {
					result.openAnomalies = anomalies.count
				}
				result.observations = await observationsTask
				return result
			}

			guard let self, !Task.isCancelled else { return }
			self.loader.update(ifGeneration: generation) { snapshot in
				var next = snapshot
				if let newIssues = decorations.newIssues {
					next.newIssues = newIssues
					next.activeIssues = decorations.activeIssues
				}
				if let openAnomalies = decorations.openAnomalies { next.openAnomalies = openAnomalies }
				for index in next.incidents.indices {
					if let values = decorations.observations[next.incidents[index].id] {
						next.incidents[index].observations = values
					}
				}
				return next
			}
			self.persist()
		}
	}

	/// One checks request per card, bounded: the first eight cards are the
	/// ones on screen; the rest get a sparkline when tapped into.
	private static func observations(
		for cards: [IncidentCard],
		api: any MapleAPI,
		since: Date
	) async -> [String: [Double]] {
		await withTaskGroup(of: (String, [Double]).self, returning: [String: [Double]].self) { group in
			for card in cards.prefix(8) {
				group.addTask {
					let checks = try? await api.alertRuleChecks(
						ruleId: card.incident.ruleId,
						groupKey: card.incident.groupKey,
						since: since,
						limit: 60
					)
					return (card.id, (checks ?? []).compactMap(\.observedValue))
				}
			}
			var result: [String: [Double]] = [:]
			for await (id, values) in group { result[id] = values }
			return result
		}
	}

	/// Write whatever the board currently shows, so the next launch can seed
	/// it. Called after the second pass merges — the fullest the board gets.
	private func persist() {
		guard let organizationId, let snapshot = loader.state.value else { return }
		SnapshotCache.save(
			snapshot,
			screen: Screen.home,
			organizationId: organizationId,
			environment: scope.environment
		)
	}
}

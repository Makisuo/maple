import MapleAPI
import SwiftUI

struct ServiceDetail {
	var service: Service
	var errorRate: [Double]
	var p95: [Double]
	var throughput: [Double]
	/// Open incidents whose rule names this service (or is grouped on it).
	var incidents: [IncidentCard]
	var issues: [ErrorIssue]
	var slowestOperations: [BreakdownItem]
	var failingOperations: [BreakdownItem]
}

@MainActor
@Observable
final class ServiceDetailModel {
	private(set) var loader: ScreenLoader<ServiceDetail>!

	let serviceName: String
	var window: TimeWindow
	let generation: Int

	private let api: any MapleAPI

	init(serviceName: String, window: TimeWindow, api: any MapleAPI, session: SessionController) {
		self.serviceName = serviceName
		self.window = window
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.serviceDetail) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<ServiceDetail> { loader.state }

	private func fetch() async throws -> ServiceDetail {
		let resolved = window.resolve()
		let name = serviceName

		// The service itself is the screen; everything else is context that
		// degrades to "nothing here" rather than to an error.
		async let serviceTask = api.service(named: name, window: resolved)
		async let issuesTask = api.issues(
			query: IssueQuery(serviceName: name, actionableOnly: true), window: resolved, limit: 10, cursor: nil
		)
		async let errorTask = api.traceTimeseries(
			TraceTimeseriesRequest(aggregation: .errorRate, window: resolved, serviceName: name)
		)
		async let p95Task = api.traceTimeseries(
			TraceTimeseriesRequest(aggregation: .p95Duration, window: resolved, serviceName: name)
		)
		async let countTask = api.traceTimeseries(
			TraceTimeseriesRequest(aggregation: .count, window: resolved, serviceName: name)
		)
		async let slowTask = api.traceBreakdown(
			TraceBreakdownRequest(aggregation: .p95Duration, groupBy: .spanName, window: resolved, serviceName: name, limit: 5)
		)
		async let failingTask = api.traceBreakdown(
			TraceBreakdownRequest(
				aggregation: .count, groupBy: .spanName, window: resolved, serviceName: name, hasError: true, limit: 5
			)
		)
		async let incidentsTask = api.alertIncidents(status: .open, ruleId: nil, limit: 50, cursor: nil)
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)

		let service = try await serviceTask
		let rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		let incidents = ((try? await incidentsTask.items) ?? []).compactMap { incident -> IncidentCard? in
			guard let rule = rules[incident.ruleId] else { return nil }
			let scoped = rule.serviceNames.contains(name)
			let grouped = incident.groupKey == name
			let global = rule.serviceNames.isEmpty && !rule.excludeServiceNames.contains(name) && incident.groupKey == nil
			guard scoped || grouped || global else { return nil }
			return IncidentCard(
				incident: incident, serviceNames: rule.serviceNames, display: SignalDisplay(rule: rule), observations: []
			)
		}

		return ServiceDetail(
			service: service,
			errorRate: (try? await errorTask.values) ?? [],
			p95: (try? await p95Task.values) ?? [],
			throughput: (try? await countTask.values) ?? [],
			incidents: incidents,
			issues: (try? await issuesTask.items) ?? [],
			slowestOperations: (try? await slowTask.data) ?? [],
			failingOperations: (try? await failingTask.data) ?? []
		)
	}
}

struct ServiceDetailView: View {
	let serviceName: String
	let window: TimeWindow

	@Environment(SessionController.self) private var session
	@State private var model: ServiceDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "No data",
				emptyMessage: "This service reported nothing in \((model?.window ?? window).phrase).",
				skeleton: { DetailSkeleton() }
			) { detail in
				ServiceDetailContent(detail: detail, window: model?.window ?? window)
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .principal) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: serviceName, size: 8)
					Text(serviceName)
						.font(Typo.monoTitle)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					if let service = model?.state.value?.service {
						HealthDot(
							health: ServiceHealth(service: service)
						)
					}
				}
			}
			if let model {
				ToolbarItem(placement: .topBarTrailing) {
					TimeWindowMenu(
						window: Binding(
							get: { model.window },
							set: { newValue in
								model.window = newValue
								Telemetry.track(
									Telemetry.Event.timeWindowChanged,
									["screen": Screen.serviceDetail, "window": newValue.rawValue]
								)
								Task { await model.loader.load(.replace) }
							}
						)
					)
				}
			}
		}
		.mapleScreen(Screen.serviceDetail)
		.task(id: session.dataGeneration) {
			let model =
				model?.generation == session.dataGeneration
				? model!
				: ServiceDetailModel(serviceName: serviceName, window: window, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private struct ServiceDetailContent: View {
	let detail: ServiceDetail
	let window: TimeWindow

	private var service: Service { detail.service }

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			section("Golden signals") {
				// The number is the window aggregate the API computed; the
				// line under it is the shape of that window.
				StatGrid(columns: 3) {
					SignalTile(
						label: "Error rate",
						value: Format.errorRate(service.errorRate),
						valueTint: Tone.errorRate(service.errorRate),
						values: detail.errorRate,
						tint: Token.chartError
					)
					SignalTile(
						label: "p95",
						value: Format.latency(service.p95LatencyMs),
						valueTint: Tone.latency(service.p95LatencyMs, scale: .p95),
						values: detail.p95,
						tint: Token.chartP95
					)
					SignalTile(
						label: "Throughput",
						value: Format.throughput(service.throughput),
						values: detail.throughput,
						tint: Token.mutedForeground
					)
				}
				.padding(.horizontal, 16)

				StatGrid(columns: 3) {
					StatTile(
						label: "p50",
						value: Format.latency(service.p50LatencyMs),
						tint: Tone.latency(service.p50LatencyMs, scale: .p50)
					)
					StatTile(
						label: "p99",
						value: Format.latency(service.p99LatencyMs),
						tint: Tone.latency(service.p99LatencyMs, scale: .p99)
					)
					StatTile(label: "Errors", value: Format.count(service.errorCount))
				}
				.padding(.horizontal, 16)
			}

			if !detail.incidents.isEmpty {
				section("Open alerts") {
					VStack(spacing: 8) {
						ForEach(detail.incidents) { card in
							NavigationLink(value: Route.incident(id: card.id)) {
								IncidentCardView(card: card)
							}
							.buttonStyle(.plain)
						}
					}
					.padding(.horizontal, 16)
				}
			}

			section("Open issues") {
				if detail.issues.isEmpty {
					Text("Nothing needs attention in \(window.phrase).")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.padding(.horizontal, 16)
				} else {
					VStack(spacing: 0) {
						ForEach(detail.issues, id: \.id) { issue in
							NavigationLink(value: Route.issue(id: issue.id)) {
								IssueRow(issue: issue, showsService: false)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
						}
					}
				}
			}

			if !detail.failingOperations.isEmpty {
				section("Failing operations") {
					BreakdownList(items: detail.failingOperations, unit: .count, tint: Token.chartError)
				}
			}

			if !detail.slowestOperations.isEmpty {
				section("Slowest operations (p95)") {
					BreakdownList(items: detail.slowestOperations, unit: .milliseconds, tint: Token.chartP95)
				}
			}

			section("Volume") {
				VStack(spacing: 0) {
					DetailRow("Spans", Format.count(service.spanCount))
					Hairline()
					if service.hasSampling {
						// Sampled data means the raw counts understate reality;
						// saying so is more useful than silently scaling.
						DetailRow("Sampling", "1 in \(Format.count(service.samplingWeight))")
						Hairline()
						DetailRow("Est. throughput", Format.throughput(service.tracedThroughput))
						Hairline()
					}
					if !service.deploymentEnvironments.isEmpty {
						DetailRow("Environments", service.deploymentEnvironments.joined(separator: ", "))
						Hairline()
					}
					if !service.serviceNamespaces.isEmpty {
						DetailRow("Namespaces", service.serviceNamespaces.joined(separator: ", "))
					}
				}
				.padding(.horizontal, 16)
			}
		}
		.padding(.vertical, 16)
	}

	@ViewBuilder
	private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content)
		-> some View
	{
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title)
				.padding(.horizontal, 16)
			content()
		}
	}
}

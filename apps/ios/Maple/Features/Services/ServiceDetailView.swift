import MapleAPI
import SwiftUI

@MainActor
@Observable
final class ServiceDetailModel {
	private(set) var state: LoadState<Service> = .loading
	/// This service's open issues. Fetching them here is what makes the screen
	/// worth opening — the metrics alone are already on the list row.
	private(set) var issues: [ErrorIssue] = []

	let serviceName: String
	var window: TimeWindow

	private let api: any MapleAPI
	private let session: SessionController

	init(serviceName: String, window: TimeWindow, api: any MapleAPI, session: SessionController) {
		self.serviceName = serviceName
		self.window = window
		self.api = api
		self.session = session
	}

	func load(showPlaceholder: Bool = true) async {
		if showPlaceholder && !state.hasContent { state = .loading }

		do {
			let resolved = window.resolve()
			async let serviceTask = api.service(named: serviceName, window: resolved)
			async let issuesTask = api.issues(
				query: IssueQuery(serviceName: serviceName, actionableOnly: true),
				window: resolved,
				limit: 10,
				cursor: nil
			)

			let service = try await serviceTask
			issues = ((try? await issuesTask) ?? Page(items: [], hasMore: false, nextCursor: nil)).items
			state = .loaded(service)
		} catch is CancellationError {
		} catch let error as MapleAPIError {
			if await session.handle(error) {
				await load(showPlaceholder: false)
			} else {
				state = .failed(error)
			}
		} catch {
			state = .failed(.transport(error))
		}
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
			if let model {
				LoadableView(
					state: model.state,
					emptyTitle: "No data",
					emptyMessage: "This service reported nothing in \(model.window.phrase).",
					retry: { Task { await model.load() } }
				) { service in
					ServiceDetailContent(service: service, issues: model.issues, window: model.window)
				}
				.refreshable { await model.load(showPlaceholder: false) }
			} else {
				SkeletonList()
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
					if let service = model?.state.value {
						HealthDot(
							health: ServiceHealth(
								errorRate: service.errorRate,
								p95LatencyMs: service.p95LatencyMs
							)
						)
					}
				}
			}
		}
		.task(id: session.dataGeneration) {
			let model =
				model
				?? ServiceDetailModel(
					serviceName: serviceName, window: window, api: session.api, session: session
				)
			self.model = model
			await model.load()
		}
	}
}

private struct ServiceDetailContent: View {
	let service: Service
	let issues: [ErrorIssue]
	let window: TimeWindow

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				section("Golden signals") {
					StatGrid(columns: 2) {
						StatTile(
							label: "Error rate",
							value: Format.errorRate(service.errorRate),
							tint: Tone.errorRate(service.errorRate)
						)
						StatTile(label: "Throughput", value: Format.throughput(service.throughput))
						StatTile(
							label: "p50",
							value: Format.latency(service.p50LatencyMs),
							tint: Tone.latency(service.p50LatencyMs, scale: .p50)
						)
						StatTile(
							label: "p95",
							value: Format.latency(service.p95LatencyMs),
							tint: Tone.latency(service.p95LatencyMs, scale: .p95)
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

				section("Open issues") {
					if issues.isEmpty {
						Text("Nothing needs attention in \(window.phrase).")
							.font(Typo.small)
							.foregroundStyle(Token.mutedForeground)
							.padding(.horizontal, 16)
					} else {
						VStack(spacing: 0) {
							ForEach(issues, id: \.id) { issue in
								NavigationLink(value: IssueRoute.detail(id: issue.id)) {
									IssueRow(issue: issue, showsService: false)
								}
								.buttonStyle(RowButtonStyle())
								Hairline()
							}
						}
					}
				}
			}
			.padding(.vertical, 16)
		}
		.scrollContentBackground(.hidden)
		.navigationDestination(for: IssueRoute.self) { route in
			switch route {
			case .detail(let id): IssueDetailView(issueID: id)
			}
		}
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

enum IssueRoute: Hashable {
	case detail(id: String)
}

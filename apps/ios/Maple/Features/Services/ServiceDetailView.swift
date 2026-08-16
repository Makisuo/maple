import MapleAPI
import SwiftUI

@MainActor
@Observable
final class ServiceDetailModel {
	private(set) var state: LoadState<Service> = .loading
	/// This service's open issues. Fetching them here is what makes the screen
	/// worth opening — metrics alone are already on the list row.
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

	func load(showSpinner: Bool = true) async {
		if showSpinner && !state.hasContent { state = .loading }

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
				await load(showSpinner: false)
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
		Group {
			if let model {
				LoadableView(
					state: model.state,
					emptyTitle: "No data",
					emptyMessage: "This service reported nothing in \(model.window.phrase).",
					retry: { Task { await model.load() } }
				) { service in
					detail(service, model: model)
				}
				.refreshable { await model.load(showSpinner: false) }
			} else {
				ProgressView()
			}
		}
		.navigationTitle(serviceName)
		.navigationBarTitleDisplayMode(.inline)
		.task(id: session.dataGeneration) {
			let model =
				model ?? ServiceDetailModel(serviceName: serviceName, window: window, api: session.api, session: session)
			self.model = model
			await model.load()
		}
	}

	@ViewBuilder
	private func detail(_ service: Service, model: ServiceDetailModel) -> some View {
		List {
			Section("Golden signals") {
				LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 2), spacing: 8) {
					MetricTile(
						label: "Error rate",
						value: Format.percent(service.errorRate),
						tint: errorRateTint(service.errorRate)
					)
					MetricTile(label: "Throughput", value: Format.throughput(service.throughput))
					MetricTile(label: "p50", value: Format.milliseconds(service.p50LatencyMs))
					MetricTile(label: "p95", value: Format.milliseconds(service.p95LatencyMs))
					MetricTile(label: "p99", value: Format.milliseconds(service.p99LatencyMs))
					MetricTile(label: "Errors", value: Format.count(service.errorCount))
				}
				.listRowInsets(EdgeInsets())
				.listRowBackground(Color.clear)
			}

			Section("Volume") {
				LabeledContent("Spans", value: Format.count(service.spanCount))
				if service.hasSampling {
					LabeledContent("Sampling") {
						// Sampled data means the raw counts understate reality;
						// saying so is more useful than silently scaling.
						Text("1 in \(Format.count(service.samplingWeight))")
							.foregroundStyle(.secondary)
					}
					LabeledContent("Estimated spans", value: Format.count(service.tracedThroughput))
				}
			}

			if !service.deploymentEnvironments.isEmpty || !service.serviceNamespaces.isEmpty {
				Section("Scope") {
					if !service.deploymentEnvironments.isEmpty {
						LabeledContent("Environments", value: service.deploymentEnvironments.joined(separator: ", "))
					}
					if !service.serviceNamespaces.isEmpty {
						LabeledContent("Namespaces", value: service.serviceNamespaces.joined(separator: ", "))
					}
				}
			}

			Section("Open issues") {
				if model.issues.isEmpty {
					Text("No open issues in \(model.window.phrase).")
						.foregroundStyle(.secondary)
						.font(.callout)
				} else {
					ForEach(model.issues, id: \.id) { issue in
						NavigationLink(value: IssueRoute.detail(id: issue.id)) {
							IssueRow(issue: issue, showsService: false)
						}
					}
				}
			}
		}
		.navigationDestination(for: IssueRoute.self) { route in
			switch route {
			case .detail(let id): IssueDetailView(issueID: id)
			}
		}
	}
}

enum IssueRoute: Hashable {
	case detail(id: String)
}

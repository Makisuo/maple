import MapleAPI
import SwiftUI

@MainActor
@Observable
final class ServicesListModel {
	private(set) var state: LoadState<[Service]> = .loading
	/// Open-issue counts, keyed by service. Fetched once alongside the list so
	/// each row can carry a badge without an N+1.
	private(set) var openIssueCounts: [String: Int] = [:]
	var window: TimeWindow = .default

	private let api: any MapleAPI
	private let session: SessionController

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.session = session
	}

	func load(showSpinner: Bool = true) async {
		if showSpinner && !state.hasContent { state = .loading }

		do {
			let resolved = window.resolve()
			async let servicesTask = api.services(window: resolved, limit: 50)
			async let countsTask = api.issueCountsByService()

			let services = try await servicesTask.items
			// Counts are decoration: a failure there must not empty the screen.
			openIssueCounts = Dictionary(
				uniqueKeysWithValues: ((try? await countsTask) ?? []).map { ($0.serviceName, Int($0.openCount)) }
			)

			state = services.isEmpty
				? .empty
				: .loaded(services.sorted { $0.errorRate > $1.errorRate })
		} catch is CancellationError {
			// A window change or org switch superseded this load.
		} catch let error as MapleAPIError {
			// A 401 is usually a token that expired mid-flight; re-mint and retry
			// once before showing the user anything.
			if await session.handle(error) {
				await retryOnce()
			} else {
				state = .failed(error)
			}
		} catch {
			state = .failed(.transport(error))
		}
	}

	private func retryOnce() async {
		do {
			let services = try await api.services(window: window.resolve(), limit: 50).items
			state = services.isEmpty ? .empty : .loaded(services.sorted { $0.errorRate > $1.errorRate })
		} catch let error as MapleAPIError {
			state = .failed(error)
			if error.requiresReauthentication { await session.signOutLocally() }
		} catch {
			state = .failed(.transport(error))
		}
	}
}

struct ServicesListView: View {
	@Environment(SessionController.self) private var session
	@State private var model: ServicesListModel?
	@State private var search = ""

	var body: some View {
		NavigationStack {
			Group {
				if let model {
					content(model)
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Services")
			.toolbar {
				if let model {
					ToolbarItem(placement: .topBarTrailing) {
						TimeWindowMenu(window: bindingForWindow(model))
					}
				}
			}
		}
		// Re-runs on org switch, which is what clears one org's services before
		// the next org's arrive.
		.task(id: session.dataGeneration) {
			let model = model ?? ServicesListModel(api: session.api, session: session)
			self.model = model
			await model.load()
		}
	}

	@ViewBuilder
	private func content(_ model: ServicesListModel) -> some View {
		LoadableView(
			state: model.state,
			emptyTitle: "No services",
			emptyMessage: "No services reported telemetry in \(model.window.phrase).",
			retry: { Task { await model.load() } }
		) { services in
			List {
				ForEach(filtered(services), id: \.name) { service in
					NavigationLink(value: service.name) {
						ServiceRow(service: service, openIssues: model.openIssueCounts[service.name] ?? 0)
					}
				}
			}
			.listStyle(.plain)
			.searchable(text: $search, prompt: "Filter services")
			.overlay {
				if filtered(services).isEmpty {
					ContentUnavailableView.search(text: search)
				}
			}
		}
		.navigationDestination(for: String.self) { name in
			ServiceDetailView(serviceName: name, window: model.window)
		}
		.refreshable { await model.load(showSpinner: false) }
	}

	private func filtered(_ services: [Service]) -> [Service] {
		guard !search.isEmpty else { return services }
		return services.filter { $0.name.localizedCaseInsensitiveContains(search) }
	}

	private func bindingForWindow(_ model: ServicesListModel) -> Binding<TimeWindow> {
		Binding(
			get: { model.window },
			set: { newValue in
				model.window = newValue
				Task { await model.load() }
			}
		)
	}
}

private struct ServiceRow: View {
	let service: Service
	let openIssues: Int

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack {
				Text(service.name)
					.font(.body.weight(.medium))
					.lineLimit(1)
				Spacer()
				if openIssues > 0 {
					Text("\(openIssues)")
						.font(.caption2.weight(.semibold))
						.padding(.horizontal, 6)
						.padding(.vertical, 2)
						.background(.red.opacity(0.15), in: .capsule)
						.foregroundStyle(.red)
				}
			}

			HStack(spacing: 14) {
				Stat(label: "err", value: Format.percent(service.errorRate), tint: errorRateTint(service.errorRate))
				Stat(label: "p95", value: Format.milliseconds(service.p95LatencyMs))
				Stat(label: "rate", value: Format.throughput(service.throughput))
			}
		}
		.padding(.vertical, 4)
	}

	private struct Stat: View {
		let label: String
		let value: String
		var tint: Color = .secondary

		var body: some View {
			HStack(spacing: 3) {
				Text(label)
					.font(.caption2)
					.foregroundStyle(.tertiary)
				Text(value)
					.font(.caption.monospacedDigit())
					.foregroundStyle(tint)
			}
		}
	}
}

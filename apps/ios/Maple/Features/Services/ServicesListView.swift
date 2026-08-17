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

	func load(showPlaceholder: Bool = true) async {
		if showPlaceholder && !state.hasContent { state = .loading }

		do {
			let resolved = window.resolve()
			async let servicesTask = api.services(window: resolved, limit: 50)
			async let countsTask = api.issueCountsByService()

			let services = try await servicesTask.items
			// Counts are decoration: a failure there must not empty the screen.
			openIssueCounts = Dictionary(
				uniqueKeysWithValues: ((try? await countsTask) ?? []).map { ($0.serviceName, Int($0.openCount)) }
			)

			state = services.isEmpty ? .empty : .loaded(sorted(services))
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

	/// Unhealthy first, then by error rate, then by volume — so the rows that
	/// need attention are the ones on screen without scrolling.
	private func sorted(_ services: [Service]) -> [Service] {
		services.sorted { first, second in
			let a = ServiceHealth(errorRate: first.errorRate, p95LatencyMs: first.p95LatencyMs)
			let b = ServiceHealth(errorRate: second.errorRate, p95LatencyMs: second.p95LatencyMs)
			if a != b { return rank(a) < rank(b) }
			if first.errorRate != second.errorRate { return first.errorRate > second.errorRate }
			return first.throughput > second.throughput
		}
	}

	private func rank(_ health: ServiceHealth) -> Int {
		switch health {
		case .unhealthy: 0
		case .degraded: 1
		case .healthy: 2
		}
	}

	private func retryOnce() async {
		do {
			let services = try await api.services(window: window.resolve(), limit: 50).items
			state = services.isEmpty ? .empty : .loaded(sorted(services))
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
			ZStack {
				Token.background.ignoresSafeArea()
				if let model {
					content(model)
				} else {
					SkeletonList()
				}
			}
			.navigationTitle("Services")
			.toolbarTitleDisplayMode(.inlineLarge)
			.toolbar {
				if let model {
					ToolbarItem(placement: .topBarTrailing) {
						TimeWindowMenu(window: windowBinding(model))
					}
				}
			}
			.navigationDestination(for: String.self) { name in
				ServiceDetailView(serviceName: name, window: model?.window ?? .default)
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
			let visible = filtered(services)
			ScrollView {
				LazyVStack(spacing: 0) {
					if visible.isEmpty {
						EmptyStateView(
							title: "No matches",
							message: "No service name contains “\(search)”."
						)
						.padding(.top, 48)
					} else {
						ForEach(visible, id: \.name) { service in
							NavigationLink(value: service.name) {
								ServiceRow(
									service: service,
									openIssues: model.openIssueCounts[service.name] ?? 0
								)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
						}
					}
				}
			}
			.scrollContentBackground(.hidden)
		}
		.searchable(text: $search, prompt: "Filter services")
		.refreshable { await model.load(showPlaceholder: false) }
	}

	private func filtered(_ services: [Service]) -> [Service] {
		guard !search.isEmpty else { return services }
		return services.filter { $0.name.localizedCaseInsensitiveContains(search) }
	}

	private func windowBinding(_ model: ServicesListModel) -> Binding<TimeWindow> {
		Binding(
			get: { model.window },
			set: { newValue in
				model.window = newValue
				Task { await model.load() }
			}
		)
	}
}

/// Row anatomy from the web's mobile services list: name with service dot and
/// health dot, namespace, a mono stat line, and the error rate right-aligned
/// under an uppercase "err" caption.
private struct ServiceRow: View {
	let service: Service
	let openIssues: Int

	private var health: ServiceHealth {
		ServiceHealth(errorRate: service.errorRate, p95LatencyMs: service.p95LatencyMs)
	}

	var body: some View {
		HStack(alignment: .center, spacing: 12) {
			// A 2px lane reserved on every row and painted only when unhealthy,
			// so nothing shifts horizontally between rows.
			Rectangle()
				.fill(health == .unhealthy ? Token.destructive : .clear)
				.frame(width: 2)

			VStack(alignment: .leading, spacing: 5) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: service.name)
					Text(service.name)
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					HealthDot(health: health)
				}

				if let namespace = service.serviceNamespaces.first, !namespace.isEmpty {
					Text(namespace)
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}

				HStack(spacing: 12) {
					Stat(label: "p95", value: Format.latency(service.p95LatencyMs), tint: Tone.latency(service.p95LatencyMs, scale: .p95))
					Stat(label: "thru", value: Format.throughput(service.throughput), tint: Token.foreground)
					if openIssues > 0 {
						Stat(label: "open", value: "\(openIssues)", tint: Token.destructive)
					}
				}
			}

			Spacer(minLength: 8)

			VStack(alignment: .trailing, spacing: 2) {
				Text(Format.errorRate(service.errorRate))
					.font(Typo.smallSemibold)
					.tabularNumbers()
					.foregroundStyle(Tone.errorRate(service.errorRate))
				Text("err")
					.font(Typo.micro)
					.textCase(.uppercase)
					.tracking(0.8)
					.foregroundStyle(Token.mutedForeground.opacity(0.6))
			}
		}
		.padding(.trailing, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 64)
		.contentShape(.rect)
	}

	private struct Stat: View {
		let label: String
		let value: String
		var tint: Color

		var body: some View {
			HStack(spacing: 4) {
				Text(label)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground.opacity(0.6))
				Text(value)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(tint)
			}
		}
	}
}

/// List rows lift one tonal step on press — the same `hover:bg-muted/50` idea,
/// translated to touch.
struct RowButtonStyle: ButtonStyle {
	func makeBody(configuration: ButtonStyleConfiguration) -> some View {
		configuration.label
			.background(configuration.isPressed ? Token.muted.opacity(0.5) : .clear)
	}
}

/// The time-range control every data screen carries.
struct TimeWindowMenu: View {
	@Binding var window: TimeWindow

	var body: some View {
		Menu {
			Picker("Time range", selection: $window) {
				ForEach(TimeWindow.allCases) { option in
					Text(option.title).tag(option)
				}
			}
		} label: {
			Text(window.title)
				.font(Typo.smallMedium)
				.foregroundStyle(Token.foreground)
		}
	}
}

import MapleAPI
import SwiftUI

@MainActor
@Observable
final class ServicesListModel {
	private(set) var loader: ScreenLoader<[Service]>!
	/// Open-issue counts, keyed by service. Fetched once alongside the list so
	/// each row can carry a badge without an N+1.
	///
	/// **Organization-wide, even when an environment is selected.**
	/// `/v2/error_issues/service_counts` takes no parameters at all, so with
	/// "staging" chosen a row's metrics are staging and its badge is not. It is
	/// the only place in the app where one row mixes the two; the fix is a
	/// parameter on that endpoint, not a second request here.
	private(set) var openIssueCounts: [String: Int] = [:]
	var window: TimeWindow = .default
	let generation: Int

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.services, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<[Service]> { loader.state }

	private func fetch() async throws -> [Service] {
		let resolved = window.resolve()
		async let servicesTask = api.services(window: resolved, limit: 50)
		async let countsTask = api.issueCountsByService()

		let services = try await servicesTask.items
		// Counts are decoration: a failure there must not empty the screen.
		openIssueCounts = Dictionary(
			uniqueKeysWithValues: ((try? await countsTask) ?? []).map { ($0.serviceName, Int($0.openCount)) }
		)
		return sorted(services)
	}

	/// Unhealthy first, then by error rate, then by volume — so the rows that
	/// need attention are the ones on screen without scrolling.
	private func sorted(_ services: [Service]) -> [Service] {
		services.sorted { first, second in
			let a = ServiceHealth(service: first)
			let b = ServiceHealth(service: second)
			if a != b { return a.rank > b.rank }
			if first.errorRate != second.errorRate { return first.errorRate > second.errorRate }
			return first.throughput > second.throughput
		}
	}
}

struct ServicesListView: View {
	@Environment(SessionController.self) private var session
	@Environment(AppNavigation.self) private var navigation
	@Environment(EnvironmentController.self) private var environments
	@State private var model: ServicesListModel?
	@State private var search = ""

	var body: some View {
		@Bindable var navigation = navigation
		// The path lives in `AppNavigation` so the throughput widget can open a
		// service from outside the view tree — same reason as the Alerts hub.
		return NavigationStack(path: $navigation.servicesPath) {
			ZStack {
				Token.background.ignoresSafeArea()
				content
			}
			.navigationTitle("Services")
			.navigationBarTitleDisplayMode(.large)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					OrganizationSwitcherButton()
				}
				ToolbarItem(placement: .topBarLeading) {
					EnvironmentPickerView()
				}
				if let model {
					ToolbarItem(placement: .topBarTrailing) {
						TimeWindowMenu(window: windowBinding(model))
					}
				}
			}
			.mapleDestinations()
			.mapleScreen(Screen.services)
		}
		// Re-runs on org switch, which is what clears one org's services before
		// the next org's arrive.
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : ServicesListModel(api: session.api.scoped(toEnvironment: environments.selected), session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}

	private var content: some View {
		LoadableView(
			loader: model?.loader,
			emptyTitle: "No services",
			emptyMessage: "No services reported telemetry in \(model?.window.phrase ?? TimeWindow.default.phrase).",
			skeletonRowHeight: 64
		) { services in
			let visible = filtered(services)
			LazyVStack(spacing: 0) {
				if visible.isEmpty {
					EmptyStateView(
						title: "No matches",
						message: "No service name contains “\(search)”."
					)
					.padding(.top, 48)
				} else if let model {
					ForEach(visible, id: \.name) { service in
						NavigationLink(value: Route.service(name: service.name, window: model.window)) {
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
		.searchable(text: $search, prompt: "Filter services")
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
				Telemetry.track(
					Telemetry.Event.timeWindowChanged,
					["screen": Screen.services, "window": newValue.rawValue]
				)
				Task { await model.loader.load(.replace) }
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
		ServiceHealth(service: service)
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

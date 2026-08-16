import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IssuesListModel {
	private(set) var state: LoadState<[ErrorIssue]> = .loading
	private(set) var isLoadingMore = false

	var query = IssueQuery(actionableOnly: false, sort: .lastSeen) {
		didSet {
			// The server rejects a cursor carried across a sort change
			// (`cursor_sort_mismatch`), so any filter edit restarts pagination.
			guard query != oldValue else { return }
			Task { await load() }
		}
	}

	private var nextCursor: String?
	private var hasMore = false

	private let api: any MapleAPI
	private let session: SessionController

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.session = session
	}

	func load(showSpinner: Bool = true) async {
		if showSpinner && !state.hasContent { state = .loading }
		nextCursor = nil

		do {
			let page = try await api.issues(query: query, window: nil, limit: 20, cursor: nil)
			nextCursor = page.nextCursor
			hasMore = page.hasMore
			state = page.items.isEmpty ? .empty : .loaded(page.items)
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

	/// Append the next page. Silent by design: a pagination failure must not
	/// throw away the rows already on screen.
	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, let existing = state.value else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }

		guard let page = try? await api.issues(query: query, window: nil, limit: 20, cursor: cursor) else {
			hasMore = false
			return
		}
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		state = .loaded(existing + page.items)
	}

	var canLoadMore: Bool { hasMore }
}

struct IssuesListView: View {
	@Environment(SessionController.self) private var session
	@State private var model: IssuesListModel?

	var body: some View {
		NavigationStack {
			Group {
				if let model {
					content(model)
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Issues")
			.toolbar {
				if let model {
					ToolbarItem(placement: .topBarTrailing) {
						FilterMenu(model: model)
					}
				}
			}
			.navigationDestination(for: IssueRoute.self) { route in
				switch route {
				case .detail(let id): IssueDetailView(issueID: id)
				}
			}
		}
		.task(id: session.dataGeneration) {
			let model = model ?? IssuesListModel(api: session.api, session: session)
			self.model = model
			await model.load()
		}
	}

	@ViewBuilder
	private func content(_ model: IssuesListModel) -> some View {
		LoadableView(
			state: model.state,
			emptyTitle: "No issues",
			emptyMessage: model.query.actionableOnly
				? "Nothing needs attention right now."
				: "No error issues match these filters.",
			retry: { Task { await model.load() } }
		) { issues in
			List {
				ForEach(issues, id: \.id) { issue in
					NavigationLink(value: IssueRoute.detail(id: issue.id)) {
						IssueRow(issue: issue, showsService: true)
					}
				}

				if model.canLoadMore {
					HStack {
						Spacer()
						ProgressView()
						Spacer()
					}
					.listRowSeparator(.hidden)
					// Trigger on appearance of the trailing row rather than on a
					// scroll offset — no geometry math, and it keeps working if
					// the row heights change.
					.task { await model.loadMore() }
				}
			}
			.listStyle(.plain)
		}
		.refreshable { await model.load(showSpinner: false) }
	}
}

private struct FilterMenu: View {
	@Bindable var model: IssuesListModel

	var body: some View {
		Menu {
			Toggle("Needs attention", isOn: $model.query.actionableOnly)

			Picker("Sort", selection: $model.query.sort) {
				ForEach(IssueQuery.Sort.allCases, id: \.self) { sort in
					Text(sort.title).tag(sort)
				}
			}

			Picker("Severity", selection: $model.query.severity) {
				Text("Any severity").tag(IssueSeverityFilter?.none)
				ForEach(IssueSeverityFilter.allCases, id: \.self) { severity in
					Text(severity.rawValue.capitalized).tag(IssueSeverityFilter?.some(severity))
				}
			}

			Picker("State", selection: $model.query.workflowState) {
				Text("Any state").tag(WorkflowState?.none)
				ForEach(WorkflowState.allCases, id: \.self) { state in
					Text(state.title).tag(WorkflowState?.some(state))
				}
			}
		} label: {
			Label("Filter", systemImage: isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
		}
	}

	private var isFiltered: Bool {
		model.query.actionableOnly || model.query.severity != nil || model.query.workflowState != nil
	}
}

struct IssueRow: View {
	let issue: ErrorIssue
	let showsService: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				SeverityBadge(severity: issue.severity)
				Text(issue.exceptionType)
					.font(.subheadline.weight(.semibold))
					.lineLimit(1)
				Spacer()
				Text(Format.relative(issue.lastSeenAt))
					.font(.caption2)
					.foregroundStyle(.tertiary)
			}

			Text(issue.exceptionMessage)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(2)

			HStack(spacing: 8) {
				if showsService {
					Label(issue.serviceName, systemImage: "square.stack.3d.up")
						.font(.caption2)
						.foregroundStyle(.tertiary)
						.lineLimit(1)
				}
				Text("\(Format.count(issue.occurrenceCount)) events")
					.font(.caption2)
					.foregroundStyle(.tertiary)
				if issue.hasOpenIncident {
					Text("Open incident")
						.font(.caption2.weight(.medium))
						.foregroundStyle(.red)
				}
			}
		}
		.padding(.vertical, 4)
	}
}

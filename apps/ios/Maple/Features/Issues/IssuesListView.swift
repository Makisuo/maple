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

	func load(showPlaceholder: Bool = true) async {
		if showPlaceholder && !state.hasContent { state = .loading }
		nextCursor = nil

		do {
			let page = try await api.issues(query: query, window: nil, limit: 20, cursor: nil)
			nextCursor = page.nextCursor
			hasMore = page.hasMore
			state = page.items.isEmpty ? .empty : .loaded(page.items)
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
			ZStack {
				Token.background.ignoresSafeArea()
				if let model {
					content(model)
				} else {
					SkeletonList(rowHeight: 56)
				}
			}
			.navigationTitle("Issues")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				// The organization occupies the title slot: it is the context for
				// everything on screen, the tab bar already names the screen, and
				// a leading item here gets collapsed into an overflow menu — which
				// is where a switcher goes to be undiscoverable.
				ToolbarItem(placement: .principal) {
					OrganizationSwitcherButton(fallbackTitle: "Issues")
				}
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
			skeletonRowHeight: 56,
			retry: { Task { await model.load() } }
		) { issues in
			ScrollView {
				LazyVStack(spacing: 0) {
					ForEach(issues, id: \.id) { issue in
						NavigationLink(value: IssueRoute.detail(id: issue.id)) {
							IssueRow(issue: issue, showsService: true)
						}
						.buttonStyle(RowButtonStyle())
						Hairline()
					}

					if model.canLoadMore {
						// Trigger on the appearance of the trailing row rather than
						// on a scroll offset — no geometry maths, and it keeps
						// working if row heights change.
						SkeletonList(rowHeight: 56, rows: 2)
							.frame(height: 112)
							.task { await model.loadMore() }
					}
				}
			}
			.scrollContentBackground(.hidden)
		}
		.refreshable { await model.load(showPlaceholder: false) }
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
					Text(state.label).tag(WorkflowState?.some(state))
				}
			}
		} label: {
			Text(isFiltered ? "Filtered" : "Filter")
				.font(Typo.smallMedium)
				.foregroundStyle(isFiltered ? Token.primary : Token.foreground)
		}
	}

	private var isFiltered: Bool {
		model.query.actionableOnly || model.query.severity != nil || model.query.workflowState != nil
	}
}

/// The issue row, following `issue-row.tsx`: severity chip, then the exception
/// type with its message trailing on the same line in muted text, then service,
/// count, and a terse relative time.
struct IssueRow: View {
	let issue: ErrorIssue
	let showsService: Bool

	/// Some issue kinds (integration and alert issues) carry no exception type.
	/// The label then becomes the row's identity.
	private var title: String {
		let type = issue.exceptionType.trimmingCharacters(in: .whitespacesAndNewlines)
		if !type.isEmpty { return type }
		let label = issue.errorLabel.trimmingCharacters(in: .whitespacesAndNewlines)
		return label.isEmpty ? issue.exceptionMessage : label
	}

	/// Suppressed when it would merely restate the title, which is what happens
	/// once the title has fallen back to the label.
	private var subtitle: String? {
		let message = issue.exceptionMessage.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !message.isEmpty, !message.hasPrefix(title), !title.hasPrefix(message) else { return nil }
		return message
	}

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			// Fixed-width severity lane, mirroring the web's `w-[60px]`. Without
			// it the title starts at a different x on every row, because a badge
			// and an em dash are different widths.
			SeverityBadge(severity: issue.severity)
				.frame(width: 56, alignment: .leading)

			VStack(alignment: .leading, spacing: 4) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(title)
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					Spacer(minLength: 4)
					Text(Format.lastSeen(issue.lastSeenAt))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.layoutPriority(1)
				}

				if let subtitle {
					Text(subtitle)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(2)
						.fixedSize(horizontal: false, vertical: true)
				}

				// One line, truncating. Wrapping metadata destroys the row rhythm
				// that makes a dense list scannable.
				HStack(spacing: 10) {
					if showsService {
						HStack(spacing: 5) {
							ServiceDot(serviceName: issue.serviceName, size: 6)
							Text(issue.serviceName)
								.font(Typo.tiny)
								.foregroundStyle(Token.mutedForeground)
						}
						.fixedSize()
					}

					Text(Format.count(issue.occurrenceCount))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.fixedSize()

					if issue.hasOpenIncident {
						HStack(spacing: 4) {
							Circle()
								.fill(Token.destructive)
								.frame(width: 5, height: 5)
							Text("Incident")
								.font(Typo.tinyMedium)
								.foregroundStyle(Token.destructive)
						}
						.fixedSize()
					}

					Spacer(minLength: 0)
				}
				.lineLimit(1)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
		.contentShape(.rect)
	}
}

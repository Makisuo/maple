import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IssuesListModel {
	private(set) var loader: ScreenLoader<[ErrorIssue]>!
	private(set) var isLoadingMore = false

	var query = IssueQuery(actionableOnly: false, sort: .lastSeen) {
		didSet {
			// The server rejects a cursor carried across a sort change
			// (`cursor_sort_mismatch`), so any filter edit restarts pagination.
			guard query != oldValue else { return }
			Task { await loader.load(.replace) }
		}
	}

	private var nextCursor: String?
	private var hasMore = false

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetchFirstPage() }
	}

	var state: LoadState<[ErrorIssue]> { loader.state }

	private func fetchFirstPage() async throws -> [ErrorIssue] {
		let page = try await api.issues(query: query, window: nil, limit: 20, cursor: nil)
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		return page.items
	}

	/// Append the next page. Silent by design: a pagination failure must not
	/// throw away the rows already on screen, and a page that arrives after a
	/// refresh or filter change replaced the list is dropped rather than
	/// appended to rows it was never a continuation of.
	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, state.value != nil else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let generation = loader.generation

		guard let page = try? await api.issues(query: query, window: nil, limit: 20, cursor: cursor) else {
			if generation == loader.generation { hasMore = false }
			return
		}
		guard generation == loader.generation else { return }
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		loader.update(ifGeneration: generation) { $0 + page.items }
	}

	var canLoadMore: Bool { hasMore }
}

/// The Errors segment of the Alerts hub. Content only — the hub owns the
/// `NavigationStack`, the org switcher, and the destinations; this view
/// contributes its rows and its own filter menu.
struct IssuesListContent: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: IssuesListModel

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: "No issues",
			emptyMessage: model.query.actionableOnly
				? "Nothing needs attention right now."
				: "No error issues match these filters.",
			skeletonRowHeight: 56
		) { issues in
			LazyVStack(spacing: 0) {
				ForEach(issues, id: \.id) { issue in
					NavigationLink(value: Route.issue(id: issue.id)) {
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
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				FilterMenu(model: model)
			}
		}
		.task {
			await model.loader.loadIfNeeded()
		}
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

	/// See `ErrorIssue.displayTitle` — shared with the Home Screen widget, so
	/// the same issue names itself the same way on both surfaces.
	private var title: String { issue.displayTitle }
	private var subtitle: String? { issue.displaySubtitle }

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

					// The web carries this as a bare number with a tooltip; a
					// phone has no hover, so the unit has to be on the row or
					// the count reads as an orphan digit.
					Text("\(Format.count(issue.occurrenceCount)) events")
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

import MapleWidgetData
import SwiftUI
import WidgetKit

/// The widget, in every family it supports.
///
/// Design notes, from `DESIGN.md`: mono is the body voice, the amber primary
/// appears once, and severity colour always sits beside a word rather than
/// carrying meaning alone. A widget gets one glance, so the hierarchy is
/// count → worst rows → age, in that order.
struct IssuesWidgetView: View {
	let entry: IssuesEntry

	@Environment(\.widgetFamily) private var family

	var body: some View {
		switch family {
		case .accessoryInline: InlineView(entry: entry)
		case .accessoryCircular: CircularView(entry: entry)
		case .accessoryRectangular: RectangularView(entry: entry)
		case .systemSmall: SmallView(entry: entry)
		default: ListView(entry: entry, rowLimit: family == .systemLarge ? 6 : 3)
		}
	}
}

// MARK: - Home Screen

private struct SmallView: View {
	let entry: IssuesEntry

	var body: some View {
		WidgetFrame(entry: entry) { snapshot in
			VStack(alignment: .leading, spacing: 0) {
				SectionHeader(snapshot: snapshot)
				CountLine(snapshot: snapshot)
				SeverityLine(snapshot: snapshot)

				Spacer(minLength: 8)

				if let top = snapshot.issues.first {
					Divider().overlay(Token.border)
						.padding(.bottom, 8)
					IssueRowView(issue: top, now: entry.date, showsCount: false)
				}

				StalenessFooter(snapshot: snapshot, now: entry.date)
			}
		}
		.widgetURL(IssuesWidgetKind.issuesListURL)
	}
}

/// Medium and large: the same list, cut to what fits.
private struct ListView: View {
	let entry: IssuesEntry
	let rowLimit: Int

	var body: some View {
		WidgetFrame(entry: entry) { snapshot in
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .firstTextBaseline) {
					SectionHeader(snapshot: snapshot)
					Spacer()
					CountLine(snapshot: snapshot, isCompact: true)
				}

				SeverityLine(snapshot: snapshot)
					.padding(.bottom, 8)

				VStack(alignment: .leading, spacing: 0) {
					ForEach(Array(snapshot.issues.prefix(rowLimit).enumerated()), id: \.element.id) { index, issue in
						if index > 0 {
							Divider().overlay(Token.border).padding(.vertical, 6)
						}
						// Per-row deep link: the point of showing the rows is
						// that one of them is the reason to open the app.
						Link(destination: IssuesWidgetKind.issueURL(id: issue.id) ?? fallbackURL) {
							IssueRowView(issue: issue, now: entry.date, showsCount: true)
						}
					}
				}

				Spacer(minLength: 4)

				HStack {
					if snapshot.openCount > rowLimit {
						Text("+\(snapshot.openCount - rowLimit) more")
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
					Spacer()
					StalenessFooter(snapshot: snapshot, now: entry.date)
				}
			}
		}
		.widgetURL(IssuesWidgetKind.issuesListURL)
	}

	/// Only reachable if the scheme itself failed to parse, which it cannot.
	private var fallbackURL: URL { URL(string: "\(IssuesWidgetKind.urlScheme)://issues")! }
}

// MARK: - Lock Screen

private struct RectangularView: View {
	let entry: IssuesEntry

	var body: some View {
		WidgetFrame(entry: entry, isAccessory: true) { snapshot in
			VStack(alignment: .leading, spacing: 2) {
				Text(snapshot.isEmpty ? "No ongoing issues" : "\(snapshot.countLabel) ongoing")
					.font(.headline)
					.widgetAccentable()
				if let top = snapshot.issues.first {
					Text(top.title)
						.font(.caption)
						.lineLimit(1)
					Text("\(top.serviceName) · \(WidgetTime.lastSeen(top.lastSeenAt, now: entry.date))")
						.font(.caption2)
						.foregroundStyle(.secondary)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.widgetURL(IssuesWidgetKind.issuesListURL)
	}
}

private struct CircularView: View {
	let entry: IssuesEntry

	var body: some View {
		WidgetFrame(entry: entry, isAccessory: true) { snapshot in
			VStack(spacing: 0) {
				Text(snapshot.countLabel)
					.font(.system(.title2, design: .rounded, weight: .semibold))
					.minimumScaleFactor(0.6)
					.widgetAccentable()
				Text(snapshot.criticalCount > 0 ? "crit \(snapshot.criticalCount)" : "issues")
					.font(.system(size: 9))
					.foregroundStyle(.secondary)
			}
		}
		.widgetURL(IssuesWidgetKind.issuesListURL)
	}
}

private struct InlineView: View {
	let entry: IssuesEntry

	var body: some View {
		// Inline is one line of system-styled text; a `WidgetFrame` empty state
		// would be a second line it cannot show.
		if let snapshot = entry.snapshot, !snapshot.isEmpty {
			if let top = snapshot.issues.first {
				Text("\(snapshot.countLabel) ongoing · \(top.title)")
			} else {
				Text("\(snapshot.countLabel) ongoing issues")
			}
		} else {
			Text(entry.snapshot == nil ? "Maple — open to connect" : "No ongoing issues")
		}
	}
}

// MARK: - Shared chrome

/// The three states every family shares: never published, nothing ongoing, and
/// content. Written once so a signed-out phone cannot show "0 issues" — which
/// would read as "all clear" when the truth is "Maple has no idea".
private struct WidgetFrame<Content: View>: View {
	let entry: IssuesEntry
	var isAccessory = false
	@ViewBuilder let content: (IssuesSnapshot) -> Content

	var body: some View {
		Group {
			if let snapshot = entry.snapshot {
				if snapshot.isEmpty {
					EmptyStateView(snapshot: snapshot, now: entry.date, isAccessory: isAccessory)
				} else {
					content(snapshot)
						// Stale data stays on screen — it is still the last
						// truth we had — but stops looking like live data.
						.opacity(snapshot.isStale(at: entry.date) ? 0.55 : 1)
				}
			} else {
				DisconnectedView(isAccessory: isAccessory)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.redacted(reason: entry.isPlaceholder ? .placeholder : [])
	}
}

private struct SectionHeader: View {
	let snapshot: IssuesSnapshot

	var body: some View {
		Text("Ongoing issues")
			.sectionLabelStyle()
			.lineLimit(1)
	}
}

private struct CountLine: View {
	let snapshot: IssuesSnapshot
	var isCompact = false

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 4) {
			Text(snapshot.countLabel)
				.font(isCompact ? Typo.monoTitle : Typo.statValue)
				.tabularNumbers()
				// The one amber per surface: the number is the whole point.
				.foregroundStyle(snapshot.criticalCount > 0 ? Token.destructive : Token.primary)
		}
	}
}

private struct SeverityLine: View {
	let snapshot: IssuesSnapshot

	var body: some View {
		Text(summary)
			.font(Typo.tiny)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
			.lineLimit(1)
	}

	private var summary: String {
		var parts: [String] = []
		if snapshot.criticalCount > 0 { parts.append("\(snapshot.criticalCount) critical") }
		if snapshot.highCount > 0 { parts.append("\(snapshot.highCount) high") }
		return parts.isEmpty ? "needs attention" : parts.joined(separator: " · ")
	}
}

private struct IssueRowView: View {
	let issue: WidgetIssue
	let now: Date
	let showsCount: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			HStack(alignment: .firstTextBaseline, spacing: 6) {
				// A dot, not a chip: at this size a "Critical" badge costs the
				// title half its width. The severity word is on the header
				// line, so colour is never the only carrier here.
				Circle()
					.fill(issue.severity.tint)
					.frame(width: 6, height: 6)
					.alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }

				Text(issue.title)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)

				Spacer(minLength: 4)

				Text(WidgetTime.lastSeen(issue.lastSeenAt, now: now))
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.layoutPriority(1)
			}

			HStack(spacing: 6) {
				ServiceDot(serviceName: issue.serviceName, size: 5)
				Text(issue.serviceName)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)

				if showsCount {
					Text("\(WidgetTime.count(issue.occurrenceCount)) events")
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}

				// Both are states, not decoration: regressed means a fix came
				// undone, paging means someone is being woken up.
				if issue.isRegressed {
					Text("regressed")
						.font(Typo.micro)
						.foregroundStyle(Token.orangeText)
				}
				if issue.hasOpenIncident {
					Text("paging")
						.font(Typo.micro)
						.foregroundStyle(Token.destructive)
				}
			}
		}
	}
}

private struct EmptyStateView: View {
	let snapshot: IssuesSnapshot
	let now: Date
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text("No ongoing issues").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text("Ongoing issues").sectionLabelStyle()
				Text("All clear")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("Nothing needs attention.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
				Spacer(minLength: 0)
				StalenessFooter(snapshot: snapshot, now: now)
			}
		}
	}
}

/// No snapshot at all. Deliberately not "0 issues": the app has never
/// published, so the honest statement is that the widget knows nothing.
private struct DisconnectedView: View {
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text("Open Maple").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text("Maple").sectionLabelStyle()
				Text("Open Maple")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("Sign in to see ongoing issues here.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}
}

/// Shown only once the data is old enough to mislead. A timestamp on fresh
/// data is noise; on stale data it is the most important thing on the widget.
private struct StalenessFooter: View {
	let snapshot: IssuesSnapshot
	let now: Date

	var body: some View {
		if snapshot.isStale(at: now) {
			Text("as of \(WidgetTime.age(snapshot.age(at: now)))")
				.font(Typo.micro)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
		}
	}
}

// MARK: - Presentation helpers

extension IssuesSnapshot {
	/// "20+" when the app only saw a page of them, so the number is never a
	/// quiet lie.
	var countLabel: String { isCapped ? "\(openCount)+" : "\(openCount)" }
}

extension Optional where Wrapped == WidgetIssueSeverity {
	/// The severity fills from `Primitives.swift`, which the extension does not
	/// link — it would drag in the whole generated API client.
	var tint: Color {
		switch self {
		case .critical: Token.destructive
		case .high: Token.orangeFill
		case .medium: Token.amberFill
		case .low, .none: Token.mutedForeground
		}
	}
}

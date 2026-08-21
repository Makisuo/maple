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
		default: ListView(entry: entry, isLarge: family == .systemLarge)
		}
	}
}

// MARK: - Home Screen

private struct SmallView: View {
	let entry: IssuesEntry

	var body: some View {
		WidgetFrame(entry: entry) { snapshot in
			VStack(alignment: .leading, spacing: 0) {
				SectionHeader(snapshot: snapshot, organization: entry.headerOrganization)
				CountLine(snapshot: snapshot)
				SeverityLine(snapshot: snapshot)

				Spacer(minLength: 8)

				if let top = snapshot.issues.first {
					Divider().overlay(Token.border)
						.padding(.bottom, 8)
					IssueRowView(issue: top, now: entry.date, showsCount: false, showsTrailingTime: false)
				}

				UpdatedFooter(snapshot: snapshot, now: entry.date)
			}
		}
		.widgetURL(IssuesWidgetKind.issuesListURL(organizationId: entry.organizationId))
	}
}

/// Medium and large: the same list, cut to what fits.
private struct ListView: View {
	let entry: IssuesEntry
	let isLarge: Bool

	private var rowLimit: Int { isLarge ? 6 : 3 }

	var body: some View {
		WidgetFrame(entry: entry) { snapshot in
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .firstTextBaseline) {
					SectionHeader(snapshot: snapshot, organization: entry.headerOrganization)
					Spacer()
					CountLine(snapshot: snapshot, isCompact: true)
				}

				// Everything secondary on one line: at 155pt tall the medium
				// family has room for a header, three rows, and nothing else —
				// a separate footer row got clipped. So medium is the one family
				// where the age rides this line instead of a footer, and large —
				// which has the room — takes the footer below.
				SeverityLine(
					snapshot: snapshot,
					now: isLarge ? nil : entry.date,
					extra: snapshot.openCount > rowLimit ? "+\(snapshot.openCount - rowLimit) more" : nil
				)
				.padding(.bottom, 6)

				VStack(alignment: .leading, spacing: 0) {
					ForEach(Array(snapshot.issues.prefix(rowLimit).enumerated()), id: \.element.id) { index, issue in
						if index > 0 {
							Divider().overlay(Token.border).padding(.vertical, 4)
						}
						// Per-row deep link: the point of showing the rows is
						// that one of them is the reason to open the app.
						Link(destination: IssuesWidgetKind.issueURL(id: issue.id, organizationId: entry.organizationId) ?? fallbackURL) {
							IssueRowView(issue: issue, now: entry.date, showsCount: true)
						}
					}
				}

				Spacer(minLength: 0)

				if isLarge {
					UpdatedFooter(snapshot: snapshot, now: entry.date)
				}
			}
		}
		.widgetURL(IssuesWidgetKind.issuesListURL(organizationId: entry.organizationId))
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
				Text(rectangularHeadline(snapshot: snapshot))
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
		.widgetURL(IssuesWidgetKind.issuesListURL(organizationId: entry.organizationId))
	}

	/// Rectangular is the only accessory family with room for the organization;
	/// truncating a name to two glyphs on circular or inline is worse than
	/// leaving it out.
	private func rectangularHeadline(snapshot: IssuesSnapshot) -> String {
		let base = snapshot.isEmpty ? "No ongoing issues" : "\(snapshot.countLabel) ongoing"
		guard let organization = entry.headerOrganization else { return base }
		return "\(base) · \(organization.name)"
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
		.widgetURL(IssuesWidgetKind.issuesListURL(organizationId: entry.organizationId))
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

/// The states every family shares: never published, no longer a member, waiting
/// on an organization, nothing ongoing, and content. Written once so a
/// signed-out phone cannot show "0 issues" — which would read as "all clear"
/// when the truth is "Maple has no idea".
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
			} else if entry.isOrganizationUnavailable {
				// Terminal, not a loading state: no amount of opening the app
				// will fill this in.
				UnavailableOrganizationView(
					organizationName: entry.organizationName,
					isAccessory: isAccessory
				)
			} else if let organizationName = entry.organizationName {
				// Pinned to an organization this round did not publish — outside
				// the refresh budget, or added since. Names the action that fixes
				// it rather than looking broken.
				WaitingOrganizationView(organizationName: organizationName, isAccessory: isAccessory)
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
	/// Only when the account has more than one organization published — a
	/// single-organization Home Screen does not need its own name repeated back.
	var organization: (name: String, id: String)?

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
			Text("Ongoing issues")
				.sectionLabelStyle()
				.lineLimit(1)
			if let organization {
				HStack(spacing: 4) {
					// The same categorical colour the app's organization
					// switcher uses, so the two read as one thing.
					OrganizationDot(organizationId: organization.id)
					Text(organization.name)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			}
		}
	}
}

/// The organization's categorical colour, from the same `ServiceColor` the app
/// uses for `OrganizationRow` and the switcher — so the Home Screen and the
/// toolbar agree on what an organization looks like.
private struct OrganizationDot: View {
	let organizationId: String

	var body: some View {
		ServiceDot(serviceName: organizationId, size: 7)
	}
}

/// The organization a widget is pinned to no longer publishes anything: the
/// user left it, or was removed.
private struct UnavailableOrganizationView: View {
	let organizationName: String?
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text(organizationName ?? "Unavailable").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text(organizationName ?? "Organization").sectionLabelStyle()
				Text("Unavailable")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("You're no longer a member. Edit this widget to pick another organization.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}
}

/// Pinned to a real organization that has not been published yet.
private struct WaitingOrganizationView: View {
	let organizationName: String
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text("Open Maple").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text(organizationName).sectionLabelStyle()
				Text("Open Maple")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("Open the app once to load this organization's issues.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
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

/// The one secondary line: severity counts, plus whatever else the family
/// needs to admit — rows it could not show, and how old the data is.
private struct SeverityLine: View {
	let snapshot: IssuesSnapshot
	var now: Date?
	var extra: String?

	var body: some View {
		Text(summary)
			.font(Typo.tiny)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
			.lineLimit(1)
			// The age is the last segment, so plain truncation would drop
			// exactly the thing this line was widened to carry. A worst-case
			// medium ("3 critical · 2 high · +5 more · updated 12m ago") fits at
			// full size; this is the margin for a wider accessibility face.
			.minimumScaleFactor(0.85)
	}

	private var summary: String {
		var parts: [String] = []
		if snapshot.criticalCount > 0 { parts.append("\(snapshot.criticalCount) critical") }
		if snapshot.highCount > 0 { parts.append("\(snapshot.highCount) high") }
		if parts.isEmpty { parts.append("needs attention") }
		if let extra { parts.append(extra) }
		// Only the families with no room for `UpdatedFooter` pass `now` — see
		// `ListView`. Exactly one age per family, never two.
		if let now { parts.append(WidgetTime.updated(snapshot.age(at: now))) }
		return parts.joined(separator: " · ")
	}
}

private struct IssueRowView: View {
	let issue: WidgetIssue
	let now: Date
	let showsCount: Bool
	/// The small family has no room for a time column beside the title, so it
	/// carries the time on the metadata line instead of truncating the name of
	/// the exception — which is the one thing the row exists to say.
	var showsTrailingTime = true

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
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

				if showsTrailingTime {
					Spacer(minLength: 4)

					Text(WidgetTime.lastSeen(issue.lastSeenAt, now: now))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.layoutPriority(1)
				}
			}

			HStack(spacing: 6) {
				ServiceDot(serviceName: issue.serviceName, size: 5)
				Text(issue.serviceName)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)

				if !showsTrailingTime {
					Text(WidgetTime.lastSeen(issue.lastSeenAt, now: now))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.layoutPriority(1)
				}

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
				UpdatedFooter(snapshot: snapshot, now: now)
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

/// How old the numbers are, always.
///
/// It used to appear only past `staleAfter`, on the theory that a timestamp on
/// fresh data is noise. That was wrong in the one way that matters: a widget
/// silent about its age is asking to be taken as live, and a reader who has
/// never seen the line has no reason to expect it — so on the day it does
/// appear, it reads as a new kind of error rather than as an age. Stated every
/// time, it is a fact you learn to glance at, and the dimming past `staleAfter`
/// is what escalates it.
private struct UpdatedFooter: View {
	let snapshot: IssuesSnapshot
	let now: Date

	var body: some View {
		Text(WidgetTime.updated(snapshot.age(at: now)))
			.font(Typo.micro)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
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

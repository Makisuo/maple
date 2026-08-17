import Charts
import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IssueDetailModel {
	private(set) var state: LoadState<ErrorIssueDetail> = .loading

	let issueID: String
	private let api: any MapleAPI
	private let session: SessionController

	init(issueID: String, api: any MapleAPI, session: SessionController) {
		self.issueID = issueID
		self.api = api
		self.session = session
	}

	func load(showPlaceholder: Bool = true) async {
		if showPlaceholder && !state.hasContent { state = .loading }

		do {
			state = .loaded(try await api.issue(id: issueID))
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

/// Read-only. Claiming, transitioning, and commenting on issues are
/// internal-tier operations that v2 deliberately does not expose, so there is
/// nothing to mutate here.
///
/// The sections are separate views rather than one long body: the type checker
/// gives up on a body this size ("failed to produce diagnostic for
/// expression"), and the error it emits points at the whole function.
struct IssueDetailView: View {
	let issueID: String

	@Environment(SessionController.self) private var session
	@State private var model: IssueDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			if let model {
				LoadableView(
					state: model.state,
					emptyTitle: "Not found",
					emptyMessage: "This issue no longer exists.",
					retry: { Task { await model.load() } }
				) { issue in
					IssueDetailContent(issue: issue)
				}
				.refreshable { await model.load(showPlaceholder: false) }
			} else {
				SkeletonList()
			}
		}
		.navigationTitle("Issue")
		.navigationBarTitleDisplayMode(.inline)
		.task(id: session.dataGeneration) {
			let model = model ?? IssueDetailModel(issueID: issueID, api: session.api, session: session)
			self.model = model
			await model.load()
		}
	}
}

private struct IssueDetailContent: View {
	let issue: ErrorIssueDetail

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				IssueHeader(issue: issue)
				IssueOccurrences(issue: issue)
				IssueActivity(issue: issue)
				IssueIncidents(incidents: issue.incidents)
				IssueSamples(samples: issue.sampleTraces)
			}
			.padding(.vertical, 16)
		}
		.scrollContentBackground(.hidden)
	}
}

/// A titled block with the uppercase section label.
private struct Section<Content: View>: View {
	let title: String
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title)
				.padding(.horizontal, 16)
			content
		}
	}
}

private struct IssueHeader: View {
	let issue: ErrorIssueDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				SeverityBadge(severity: issue.severity)
				WorkflowBadge(state: issue.workflowState)
				Spacer()
			}

			// Mono, not the display face. Proportional Geist is reserved for page
			// titles and empty states; an exception type is an identifier, and
			// the nav bar already carries this screen's title.
			Text(issue.exceptionType)
				.font(Typo.monoTitle)
				.foregroundStyle(Token.foreground)

			Text(issue.exceptionMessage)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)

			Text(issue.topFrame)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground.opacity(0.75))
				.lineLimit(2)
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.md)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
		}
		.padding(.horizontal, 16)
	}
}

private struct IssueOccurrences: View {
	let issue: ErrorIssueDetail

	var body: some View {
		if !issue.timeseries.isEmpty {
			Section(title: "Occurrences") {
				Chart(issue.timeseries, id: \.bucket) { point in
					BarMark(
						x: .value("Time", ResolvedTimeWindow.parse(point.bucket) ?? Date()),
						y: .value("Events", point.count)
					)
					.foregroundStyle(Token.chartError)
				}
				.chartYAxis {
					AxisMarks(position: .leading) { value in
						AxisGridLine().foregroundStyle(Token.border)
						AxisValueLabel().font(Typo.micro).foregroundStyle(Token.mutedForeground)
					}
				}
				.chartXAxis {
					AxisMarks { value in
						AxisValueLabel().font(Typo.micro).foregroundStyle(Token.mutedForeground)
					}
				}
				.frame(height: 132)
				.padding(.horizontal, 16)
			}
		}
	}
}

private struct IssueActivity: View {
	let issue: ErrorIssueDetail

	var body: some View {
		Section(title: "Activity") {
			VStack(spacing: 0) {
				DetailRow(label: "Service") {
					HStack(spacing: 6) {
						ServiceDot(serviceName: issue.serviceName, size: 6)
						Text(issue.serviceName)
					}
				}
				Hairline()
				DetailRow("Events", Format.count(issue.occurrenceCount))
				Hairline()
				DetailRow("First seen", Format.absolute(issue.firstSeenAt))
				Hairline()
				DetailRow("Last seen", Format.lastSeen(issue.lastSeenAt))
				if let assignee {
					Hairline()
					DetailRow("Assigned", assignee)
				}
				if let notes = issue.notes, !notes.isEmpty {
					Hairline()
					DetailRow("Notes", notes)
				}
			}
			.padding(.horizontal, 16)
		}
	}

	private var assignee: String? {
		guard let actor = issue.assignedActor else { return nil }
		return actor.agentName ?? actor.userId ?? actor.id
	}
}

private struct IssueIncidents: View {
	let incidents: [ErrorIncident]

	var body: some View {
		if !incidents.isEmpty {
			Section(title: "Incidents") {
				VStack(spacing: 0) {
					ForEach(incidents, id: \.id) { incident in
						HStack(alignment: .firstTextBaseline) {
							VStack(alignment: .leading, spacing: 3) {
								Text(incident.status == .open ? "Open" : "Resolved")
									.font(Typo.smallMedium)
									.foregroundStyle(
										incident.status == .open ? Token.destructive : Token.mutedForeground
									)
								Text(subtitle(for: incident))
									.font(Typo.tiny)
									.foregroundStyle(Token.mutedForeground)
							}
							Spacer()
							Text(Format.lastSeen(incident.lastTriggeredAt))
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
						.padding(.vertical, 10)
						Hairline()
					}
				}
				.padding(.horizontal, 16)
			}
		}
	}

	private func subtitle(for incident: ErrorIncident) -> String {
		let reason = incident.reason.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
		return "\(reason) · \(Format.count(incident.occurrenceCount)) events"
	}
}

private struct IssueSamples: View {
	let samples: [ErrorIssueSampleTrace]

	var body: some View {
		if !samples.isEmpty {
			Section(title: "Sample traces") {
				VStack(spacing: 0) {
					ForEach(samples, id: \.traceId) { sample in
						HStack(alignment: .firstTextBaseline) {
							Text(sample.traceId)
								.font(Typo.tiny)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
								.truncationMode(.middle)
							Spacer(minLength: 12)
							Text(Format.latency(sample.durationMicros / 1000))
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
						.padding(.vertical, 10)
						Hairline()
					}
				}
				.padding(.horizontal, 16)
			}
		}
	}
}

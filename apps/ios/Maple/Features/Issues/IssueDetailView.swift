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

	func load(showSpinner: Bool = true) async {
		if showSpinner && !state.hasContent { state = .loading }

		do {
			state = .loaded(try await api.issue(id: issueID))
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

/// Read-only. Claiming, transitioning, and commenting on issues are
/// internal-tier operations that v2 deliberately does not expose, so there is
/// nothing to mutate here.
///
/// The sections are separate views rather than one long `List` body: the type
/// checker gives up on a body this size ("failed to produce diagnostic for
/// expression"), and the error it emits points at the whole function.
struct IssueDetailView: View {
	let issueID: String

	@Environment(SessionController.self) private var session
	@State private var model: IssueDetailModel?

	var body: some View {
		Group {
			if let model {
				LoadableView(
					state: model.state,
					emptyTitle: "Not found",
					emptyMessage: "This issue no longer exists.",
					retry: { Task { await model.load() } }
				) { issue in
					IssueDetailContent(issue: issue)
				}
				.refreshable { await model.load(showSpinner: false) }
			} else {
				ProgressView()
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
		List {
			IssueHeaderSection(issue: issue)
			IssueActivitySection(issue: issue)
			IssueOccurrencesSection(issue: issue)
			IssueIncidentsSection(incidents: issue.incidents)
			IssueSamplesSection(samples: issue.sampleTraces)
		}
	}
}

private struct IssueHeaderSection: View {
	let issue: ErrorIssueDetail

	var body: some View {
		Section {
			VStack(alignment: .leading, spacing: 8) {
				HStack(spacing: 6) {
					SeverityBadge(severity: issue.severity)
					Text(issue.workflowState.title)
						.font(.caption2.weight(.medium))
						.padding(.horizontal, 6)
						.padding(.vertical, 2)
						.background(.quaternary, in: .capsule)
				}
				Text(issue.exceptionType)
					.font(.headline)
				Text(issue.exceptionMessage)
					.font(.callout)
					.foregroundStyle(.secondary)
				Text(issue.topFrame)
					.font(.caption.monospaced())
					.foregroundStyle(.tertiary)
					.lineLimit(2)
			}
			.padding(.vertical, 4)
		}
	}
}

private struct IssueActivitySection: View {
	let issue: ErrorIssueDetail

	var body: some View {
		Section("Activity") {
			LabeledContent("Service", value: issue.serviceName)
			LabeledContent("Events", value: Format.count(issue.occurrenceCount))
			LabeledContent("First seen", value: Format.absolute(issue.firstSeenAt))
			LabeledContent("Last seen", value: Format.relative(issue.lastSeenAt))
			if let assignee {
				LabeledContent("Assigned", value: assignee)
			}
			if let notes = issue.notes, !notes.isEmpty {
				LabeledContent("Notes", value: notes)
			}
		}
	}

	private var assignee: String? {
		guard let actor = issue.assignedActor else { return nil }
		return actor.agentName ?? actor.userId ?? actor.id
	}
}

private struct IssueOccurrencesSection: View {
	let issue: ErrorIssueDetail

	var body: some View {
		if !issue.timeseries.isEmpty {
			Section("Occurrences") {
				Chart(issue.timeseries, id: \.bucket) { point in
					BarMark(
						x: .value("Time", ResolvedTimeWindow.parse(point.bucket) ?? Date()),
						y: .value("Events", point.count)
					)
					.foregroundStyle(issue.severity?.tint ?? Color.accentColor)
				}
				.chartYAxis { AxisMarks(position: .leading) }
				.frame(height: 140)
				.listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
			}
		}
	}
}

private struct IssueIncidentsSection: View {
	let incidents: [ErrorIncident]

	var body: some View {
		if !incidents.isEmpty {
			Section("Incidents") {
				ForEach(incidents, id: \.id) { incident in
					VStack(alignment: .leading, spacing: 2) {
						HStack {
							Text(incident.status == .open ? "Open" : "Resolved")
								.font(.subheadline.weight(.medium))
								.foregroundStyle(incident.status == .open ? Color.red : Color.secondary)
							Spacer()
							Text(Format.relative(incident.lastTriggeredAt))
								.font(.caption2)
								.foregroundStyle(.tertiary)
						}
						Text(subtitle(for: incident))
							.font(.caption)
							.foregroundStyle(.secondary)
					}
					.padding(.vertical, 2)
				}
			}
		}
	}

	private func subtitle(for incident: ErrorIncident) -> String {
		let reason = incident.reason.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
		return "\(reason) · \(Format.count(incident.occurrenceCount)) events"
	}
}

private struct IssueSamplesSection: View {
	let samples: [ErrorIssueSampleTrace]

	var body: some View {
		if !samples.isEmpty {
			Section("Sample traces") {
				ForEach(samples, id: \.traceId) { sample in
					VStack(alignment: .leading, spacing: 2) {
						Text(sample.traceId)
							.font(.caption.monospaced())
							.lineLimit(1)
							.truncationMode(.middle)
						HStack(spacing: 8) {
							Text(Format.absolute(sample.timestamp))
							Text(Format.milliseconds(sample.durationMicros / 1000))
						}
						.font(.caption2)
						.foregroundStyle(.tertiary)
					}
					.padding(.vertical, 2)
				}
			}
		}
	}
}

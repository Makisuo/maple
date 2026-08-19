import Charts
import MapleAPI
import SwiftUI

struct AnomalyDetail {
	var anomaly: AnomalyIncident
	var timeseries: AnomalyIncidentTimeseries?
	var linkedIssue: ErrorIssueDetail?
}

@MainActor
@Observable
final class AnomalyDetailModel {
	private(set) var loader: ScreenLoader<AnomalyDetail>!

	let anomalyID: String
	let generation: Int
	private let api: any MapleAPI

	init(anomalyID: String, api: any MapleAPI, session: SessionController) {
		self.anomalyID = anomalyID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session) { [unowned self] in
			let anomaly = try await self.api.anomalyIncident(id: self.anomalyID)
			async let series = self.api.anomalyIncidentTimeseries(id: anomaly.id)
			async let issue: ErrorIssueDetail? = {
				guard let id = anomaly.errorIssueId else { return nil }
				return try? await self.api.issue(id: id)
			}()
			return AnomalyDetail(anomaly: anomaly, timeseries: try? await series, linkedIssue: await issue)
		}
	}

	var state: LoadState<AnomalyDetail> { loader.state }
}

struct AnomalyDetailView: View {
	let anomalyID: String

	@Environment(SessionController.self) private var session
	@State private var model: AnomalyDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Not found",
				emptyMessage: "This anomaly no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { detail in
				AnomalyDetailContent(detail: detail)
			}
		}
		.navigationTitle("Anomaly")
		.navigationBarTitleDisplayMode(.inline)
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : AnomalyDetailModel(anomalyID: anomalyID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private struct AnomalyDetailContent: View {
	let detail: AnomalyDetail

	private var anomaly: AnomalyIncident { detail.anomaly }
	private var isOpen: Bool { anomaly.status == .open }
	private var unit: SignalUnit { anomaly.signalType.unit }

	var body: some View {
		VStack(alignment: .leading, spacing: 28) {
			header
			chart
			facts
			if let issue = detail.linkedIssue {
				VStack(alignment: .leading, spacing: 10) {
					SectionLabel("Linked issue").padding(.horizontal, 16)
					NavigationLink(value: Route.issue(id: issue.id)) {
						HStack(alignment: .top, spacing: 10) {
							SeverityBadge(severity: issue.severity).frame(width: 56, alignment: .leading)
							VStack(alignment: .leading, spacing: 4) {
								Text(issue.exceptionType.isEmpty ? issue.errorLabel : issue.exceptionType)
									.font(Typo.bodyMedium)
									.foregroundStyle(Token.foreground)
									.lineLimit(1)
								Text(issue.exceptionMessage)
									.font(Typo.small)
									.foregroundStyle(Token.mutedForeground)
									.lineLimit(2)
							}
							Spacer(minLength: 0)
						}
						.padding(.horizontal, 16)
						.padding(.vertical, 12)
						.contentShape(.rect)
					}
					.buttonStyle(RowButtonStyle())
					Hairline()
				}
			}
		}
		.padding(.vertical, 16)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				MapleBadge(text: anomaly.severity.label, tint: anomaly.severity.tint)
				MapleBadge(text: isOpen ? "Open" : "Resolved", tint: isOpen ? Token.destructive : Token.success)
				Spacer()
				Text(
					isOpen
						? "open \(Format.duration(from: anomaly.firstTriggeredAt))"
						: "lasted \(Format.duration(from: anomaly.firstTriggeredAt, to: anomaly.resolvedAt))"
				)
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
			}
			Text("\(anomaly.signalType.label) on \(anomaly.serviceName)")
				.font(Typo.monoTitle)
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(unit.format(anomaly.lastObservedValue))
					.font(Typo.smallSemibold)
					.tabularNumbers()
					.foregroundStyle(isOpen ? anomaly.severity.tint : Token.mutedForeground)
				Text("vs baseline \(unit.format(anomaly.baselineMedian))")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
			}
			NavigationLink(value: Route.service(name: anomaly.serviceName, window: .lastHour)) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: anomaly.serviceName, size: 7)
					Text(anomaly.serviceName)
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
					Image(systemName: "chevron.right")
						.font(.system(size: 9, weight: .semibold))
						.foregroundStyle(Token.mutedForeground.opacity(0.6))
				}
			}
			.buttonStyle(.plain)
		}
		.padding(.horizontal, 16)
	}

	private struct Bucket: Identifiable {
		let id: String
		let date: Date
		let value: Double
	}

	@ViewBuilder
	private var chart: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel("Signal").padding(.horizontal, 16)
			if let series = detail.timeseries {
				let buckets = series.buckets.compactMap { bucket -> Bucket? in
					guard let date = ResolvedTimeWindow.parse(bucket.bucket) else { return nil }
					return Bucket(id: bucket.bucket, date: date, value: bucket.value)
				}
				if buckets.count < 2 {
					Text("Not enough data to chart.")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.padding(.horizontal, 16)
				} else {
					Chart {
						ForEach(buckets) { bucket in
							AreaMark(x: .value("Time", bucket.date), y: .value("Value", bucket.value))
								.foregroundStyle(
									.linearGradient(
										colors: [anomaly.severity.tint.opacity(0.18), .clear], startPoint: .top, endPoint: .bottom
									)
								)
								.interpolationMethod(.monotone)
							LineMark(x: .value("Time", bucket.date), y: .value("Value", bucket.value))
								.foregroundStyle(anomaly.severity.tint)
								.lineStyle(StrokeStyle(lineWidth: 1.25))
								.interpolationMethod(.monotone)
						}
						RuleMark(y: .value("Baseline", series.baselineMedian))
							.foregroundStyle(Token.mutedForeground.opacity(0.6))
							.lineStyle(StrokeStyle(lineWidth: 1, dash: [1, 3]))
						RuleMark(y: .value("Threshold", series.thresholdValue))
							.foregroundStyle(Token.mutedForeground.opacity(0.9))
							.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
							.annotation(position: .top, alignment: .trailing) {
								Text(unit.format(series.thresholdValue))
									.font(Typo.micro)
									.tabularNumbers()
									.foregroundStyle(Token.mutedForeground)
							}
					}
					.chartXAxis {
						AxisMarks(values: .automatic(desiredCount: 4)) { _ in
							AxisGridLine().foregroundStyle(Token.border)
							AxisValueLabel(format: .dateTime.hour().minute())
								.font(Typo.micro)
								.foregroundStyle(Token.mutedForeground)
						}
					}
					.chartYAxis {
						AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
							AxisGridLine().foregroundStyle(Token.border)
							AxisValueLabel {
								if let number = value.as(Double.self) {
									Text(unit.format(number))
										.font(Typo.micro)
										.tabularNumbers()
										.foregroundStyle(Token.mutedForeground)
								}
							}
						}
					}
					.frame(height: 150)
					.padding(.horizontal, 16)
				}
			} else {
				Text("Timeseries unavailable.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.horizontal, 16)
			}
		}
	}

	private var facts: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel("Detector").padding(.horizontal, 16)
			VStack(spacing: 0) {
				DetailRow("Opened at", unit.format(anomaly.openedValue))
				Hairline()
				DetailRow("Threshold", unit.format(anomaly.thresholdValue))
				Hairline()
				DetailRow("Baseline σ", unit.format(anomaly.baselineSigma))
				Hairline()
				if !anomaly.deploymentEnv.isEmpty {
					DetailRow("Environment", anomaly.deploymentEnv)
					Hairline()
				}
				if anomaly.reopenCount > 0 {
					DetailRow("Reopened", "\(Int(anomaly.reopenCount))×")
					Hairline()
				}
				if let reason = anomaly.resolveReason {
					DetailRow("Resolved by", reason.rawValue.replacingOccurrences(of: "_", with: " "))
					Hairline()
				}
			}
			.padding(.horizontal, 16)
		}
	}
}

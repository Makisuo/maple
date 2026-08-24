import Foundation
import MapleAPI
import MapleWidgetData

/// A deterministic in-memory `MapleAPI` for previews, screenshots, and running
/// the app without a Clerk session (`MAPLE_FIXTURES=1` in the scheme's
/// environment). One believable org: nine services, one critical incident,
/// one warning, a couple of issues, an anomaly.
///
/// The data is generated relative to `now` so timestamps always read as
/// current, and seeded so the same shapes appear on every launch.
struct FixtureAPI: MapleAPI {
	static let isEnabled = ProcessInfo.processInfo.environment["MAPLE_FIXTURES"] == "1"

	private let now: Date
	private let latency: Duration

	init(now: Date = Date(), latency: Duration = .milliseconds(350)) {
		self.now = now
		self.latency = latency
	}

	// MARK: Services

	private struct Seed {
		let name: String
		let namespace: String
		let throughput: Double
		let errorRate: Double
		let p50: Double
		let p95: Double
		let p99: Double
		/// The service's own trailing-7d p95. Most seeds sit at their baseline —
		/// a batch worker whose p95 is always ~900ms is normal, not degraded —
		/// so only `payments`, at 3.4× its own history, is latency-degraded.
		let baselineP95: Double
	}

	private static let seeds: [Seed] = [
		Seed(name: "checkout-api", namespace: "commerce", throughput: 42.1, errorRate: 0.091, p50: 84, p95: 640, p99: 1_480, baselineP95: 610),
		Seed(name: "search", namespace: "discovery", throughput: 118.4, errorRate: 0.004, p50: 210, p95: 1_340, p99: 2_900, baselineP95: 1_280),
		Seed(name: "payments", namespace: "commerce", throughput: 9.7, errorRate: 0.012, p50: 120, p95: 410, p99: 880, baselineP95: 120),
		Seed(name: "web", namespace: "edge", throughput: 380.2, errorRate: 0.0007, p50: 32, p95: 140, p99: 320, baselineP95: 135),
		Seed(name: "auth", namespace: "platform", throughput: 61.0, errorRate: 0.0002, p50: 18, p95: 61, p99: 140, baselineP95: 58),
		Seed(name: "catalog", namespace: "commerce", throughput: 27.5, errorRate: 0, p50: 44, p95: 190, p99: 410, baselineP95: 185),
		Seed(name: "notifications", namespace: "platform", throughput: 3.2, errorRate: 0.001, p50: 90, p95: 380, p99: 720, baselineP95: 360),
		Seed(name: "worker", namespace: "platform", throughput: 14.9, errorRate: 0, p50: 400, p95: 900, p99: 1_900, baselineP95: 880),
		Seed(name: "ingest-gateway", namespace: "edge", throughput: 1_240.0, errorRate: 0.0001, p50: 6, p95: 21, p99: 58, baselineP95: 20),
	]

	private func service(_ seed: Seed, window: ResolvedTimeWindow) -> Service {
		let seconds = window.end.timeIntervalSince(window.start)
		let spans = seed.throughput * seconds
		return Service(
			baselineP95LatencyMs: seed.baselineP95,
			baselineSpanCount: (seed.throughput * 7 * 24 * 3_600).rounded(),
			deploymentEnvironments: Self.environments,
			errorCount: (spans * seed.errorRate).rounded(),
			errorRate: seed.errorRate,
			hasSampling: false,
			name: seed.name,
			object: .service,
			p50LatencyMs: seed.p50,
			p95LatencyMs: seed.p95,
			p99LatencyMs: seed.p99,
			samplingWeight: 1,
			serviceNamespaces: [seed.namespace],
			spanCount: spans.rounded(),
			throughput: seed.throughput,
			tracedThroughput: seed.throughput
		)
	}

	/// Two, not one: the environment picker hides itself when there is nothing
	/// to switch to, so a single-environment fixture organization would make
	/// the control invisible in exactly the mode the screens are built and
	/// screenshotted in.
	///
	/// The fixture client ignores the environment scope — `FixtureAPI` serves
	/// one fixed world, like every other stub — so switching here proves the
	/// control and its layout, not the filtering. The filtering is proved
	/// against the real API and in `MapleAPI`'s own tests.
	static let environments = ["production", "staging"]

	func environments(window: ResolvedTimeWindow) async throws -> [String] {
		try await pause()
		return Self.environments
	}

	func services(window: ResolvedTimeWindow, limit: Int) async throws -> Page<Service> {
		try await pause()
		return Page(items: Self.seeds.map { service($0, window: window) }, hasMore: false, nextCursor: nil)
	}

	func service(named name: String, window: ResolvedTimeWindow) async throws -> Service {
		try await pause()
		guard let seed = Self.seeds.first(where: { $0.name == name }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		return service(seed, window: window)
	}

	// MARK: Issues

	private var issues: [ErrorIssue] {
		[
			issue(
				id: "iss_checkout_timeout", service: "checkout-api", type: "PaymentGatewayTimeout",
				message: "upstream payments/authorize exceeded 5000ms", frame: "checkout/authorize.ts:142",
				severity: .critical, state: .triage, count: 1_842, firstSeen: -50 * 60, lastSeen: -40, incident: true
			),
			issue(
				id: "iss_checkout_null", service: "checkout-api", type: "TypeError",
				message: "Cannot read properties of undefined (reading 'currency')", frame: "checkout/cart.ts:88",
				severity: .high, state: .todo, count: 96, firstSeen: -6 * 3600, lastSeen: -180, incident: false
			),
			issue(
				id: "iss_search_es", service: "search", type: "ElasticsearchException",
				message: "circuit_breaking_exception: [parent] Data too large", frame: "search/query.ts:211",
				severity: .medium, state: .inProgress, count: 41, firstSeen: -3 * 86_400, lastSeen: -900,
				incident: false, regressions: 2
			),
			issue(
				id: "iss_payments_decline", service: "payments", type: "CardDeclined",
				message: "insufficient_funds", frame: "payments/charge.ts:57",
				severity: .low, state: .triage, count: 12_004, firstSeen: -20 * 86_400, lastSeen: -30, incident: false
			),
		]
	}

	private func issue(
		id: String, service: String, type: String, message: String, frame: String, severity: IssueSeverity,
		state: WorkflowState, count: Double, firstSeen: TimeInterval, lastSeen: TimeInterval, incident: Bool,
		regressions: Double = 0
	) -> ErrorIssue {
		ErrorIssue(
			errorLabel: type,
			exceptionMessage: message,
			exceptionType: type,
			fingerprintHash: id,
			firstSeenAt: stamp(firstSeen),
			hasOpenIncident: incident,
			id: id,
			kind: .error,
			lastSeenAt: stamp(lastSeen),
			object: .errorIssue,
			occurrenceCount: count,
			priority: 1,
			// Fixed, then seen again — the state the issue list and the widget
			// both mark. Fixtures carry one so the mark is visible without a
			// real regression to hand.
			regressionCount: regressions,
			// No release tracking in fixtures.
			resolvedVersions: [],
			serviceName: service,
			severity: severity,
			severitySource: .manual,
			topFrame: frame,
			workflowState: state
		)
	}

	func issues(query: IssueQuery, window: ResolvedTimeWindow?, limit: Int, cursor: String?) async throws
		-> Page<ErrorIssue>
	{
		try await pause()
		var items = issues
		if let service = query.serviceName { items = items.filter { $0.serviceName == service } }
		if let window {
			items = items.filter { issue in
				guard let last = ResolvedTimeWindow.parse(issue.lastSeenAt) else { return false }
				return last >= window.start
			}
		}
		return Page(items: Array(items.prefix(limit)), hasMore: false, nextCursor: nil)
	}

	func issue(id: String) async throws -> ErrorIssueDetail {
		try await pause()
		guard let issue = issues.first(where: { $0.id == id }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		let buckets = (0..<24).map { index -> ErrorIssueTimeseriesPoint in
			let hoursAgo = TimeInterval(23 - index) * 3600
			let share: Double = index > 20 ? 3.2 : 0.7
			let count = (issue.occurrenceCount / 24 * share).rounded()
			return ErrorIssueTimeseriesPoint(bucket: stamp(-hoursAgo), count: count)
		}
		return ErrorIssueDetail(
			environments: [ErrorIssueEnvironment(count: issue.occurrenceCount, name: "production")],
			errorLabel: issue.errorLabel,
			exceptionMessage: issue.exceptionMessage,
			exceptionType: issue.exceptionType,
			fingerprintHash: issue.fingerprintHash,
			firstSeenAt: issue.firstSeenAt,
			hasOpenIncident: issue.hasOpenIncident,
			id: issue.id,
			incidents: [],
			kind: issue.kind,
			lastSeenAt: issue.lastSeenAt,
			object: .errorIssue,
			occurrenceCount: issue.occurrenceCount,
			priority: issue.priority,
			regressionCount: issue.regressionCount,
			resolvedVersions: issue.resolvedVersions,
			sampleTraces: [],
			serviceName: issue.serviceName,
			severity: issue.severity,
			severitySource: issue.severitySource,
			timeseries: buckets,
			topFrame: issue.topFrame,
			workflowState: issue.workflowState
		)
	}

	func issueCountsByService() async throws -> [ErrorIssueServiceCount] {
		try await pause()
		return [
			ErrorIssueServiceCount(openCount: 2, serviceName: "checkout-api"),
			ErrorIssueServiceCount(openCount: 1, serviceName: "search"),
			ErrorIssueServiceCount(openCount: 1, serviceName: "payments"),
		]
	}

	// MARK: Alerts

	private var rules: [AlertRule] {
		[
			rule(
				id: "alrt_checkout_errors", name: "Checkout error rate", severity: .critical, services: ["checkout-api"],
				signal: .errorRate, threshold: 0.05, window: 5, breaches: 2, healthy: 3
			),
			rule(
				id: "alrt_search_p95", name: "Search latency", severity: .warning, services: ["search"],
				signal: .p95Latency, threshold: 1_000, window: 10, breaches: 3, healthy: 3
			),
			rule(
				id: "alrt_global_errors", name: "Any service error rate", severity: .warning, services: [],
				signal: .errorRate, threshold: 0.2, window: 5, breaches: 2, healthy: 3
			),
		]
	}

	private func rule(
		id: String, name: String, severity: AlertSeverity, services: [String], signal: AlertSignalType,
		threshold: Double, window: Int, breaches: Int, healthy: Int
	) -> AlertRule {
		AlertRule(
			comparator: .gt,
			consecutiveBreachesRequired: breaches,
			consecutiveHealthyRequired: healthy,
			createdAt: stamp(-30 * 86_400),
			createdBy: "user_fixture",
			destinationIds: ["dest_slack_oncall"],
			enabled: true,
			environments: ["production"],
			excludeServiceNames: [],
			id: id,
			lastEvaluatedAt: stamp(-30),
			minimumSampleCount: 50,
			name: name,
			noDataBehavior: .skip,
			object: .alertRule,
			renotifyIntervalMinutes: 60,
			serviceNames: services,
			severity: severity,
			signalType: signal,
			tags: [],
			threshold: threshold,
			updatedAt: stamp(-2 * 86_400),
			updatedBy: "user_fixture",
			windowMinutes: window
		)
	}

	private var incidents: [AlertIncident] {
		[
			AlertIncident(
				comparator: .gt,
				dedupeKey: "alrt_checkout_errors:__total__",
				errorIssueId: "iss_checkout_timeout",
				firstTriggeredAt: stamp(-32 * 60),
				id: "inc_checkout_now",
				lastDeliveredEventType: .trigger,
				lastNotifiedAt: stamp(-32 * 60 + 5),
				lastObservedValue: 0.091,
				lastSampleCount: 1_260,
				lastTriggeredAt: stamp(-60),
				object: .alertIncident,
				ruleId: "alrt_checkout_errors",
				ruleName: "Checkout error rate",
				severity: .critical,
				signalType: .errorRate,
				status: .open,
				threshold: 0.05
			),
			AlertIncident(
				comparator: .gt,
				dedupeKey: "alrt_search_p95:__total__",
				firstTriggeredAt: stamp(-2 * 3600 - 14 * 60),
				id: "inc_search_now",
				lastDeliveredEventType: .renotify,
				lastNotifiedAt: stamp(-74 * 60),
				lastObservedValue: 1_340,
				lastSampleCount: 7_100,
				lastTriggeredAt: stamp(-120),
				object: .alertIncident,
				ruleId: "alrt_search_p95",
				ruleName: "Search latency",
				severity: .warning,
				signalType: .p95Latency,
				status: .open,
				threshold: 1_000
			),
			AlertIncident(
				comparator: .gt,
				dedupeKey: "alrt_checkout_errors:__total__",
				firstTriggeredAt: stamp(-2 * 86_400 - 3_000),
				id: "inc_checkout_yesterday",
				lastDeliveredEventType: .resolve,
				lastNotifiedAt: stamp(-2 * 86_400),
				lastObservedValue: 0.03,
				lastSampleCount: 900,
				lastTriggeredAt: stamp(-2 * 86_400 - 600),
				object: .alertIncident,
				resolvedAt: stamp(-2 * 86_400),
				ruleId: "alrt_checkout_errors",
				ruleName: "Checkout error rate",
				severity: .critical,
				signalType: .errorRate,
				status: .resolved,
				threshold: 0.05
			),
		]
	}

	func alertIncidents(status: AlertIncidentStatus?, ruleId: String?, limit: Int, cursor: String?) async throws
		-> Page<AlertIncident>
	{
		try await pause()
		var items = incidents
		if let status { items = items.filter { $0.status == status } }
		if let ruleId { items = items.filter { $0.ruleId == ruleId } }
		return Page(items: items, hasMore: false, nextCursor: nil)
	}

	func alertIncident(id: String) async throws -> AlertIncident {
		try await pause()
		guard let incident = incidents.first(where: { $0.id == id }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		return incident
	}

	func alertRules(limit: Int, cursor: String?) async throws -> Page<AlertRule> {
		try await pause()
		return Page(items: rules, hasMore: false, nextCursor: nil)
	}

	func alertRule(id: String) async throws -> AlertRule {
		try await pause()
		guard let rule = rules.first(where: { $0.id == id }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		return rule
	}

	func alertRuleChecks(ruleId: String, groupKey: String?, since: Date?, limit: Int) async throws -> [AlertCheck] {
		try await pause()
		guard let rule = rules.first(where: { $0.id == ruleId }) else { return [] }
		let incident = incidents.first { $0.ruleId == ruleId && $0.status == .open }
		let start = since ?? now.addingTimeInterval(-3600)
		let count = min(limit, max(2, Int(now.timeIntervalSince(start) / 60)))
		return (0..<count).map { index in
			let at = start.addingTimeInterval(TimeInterval(index) * 60)
			let progress = Double(index) / Double(max(1, count - 1))
			// Calm, then a ramp that crosses the threshold about 60% of the
			// way through, then a plateau — the shape most incidents have.
			let ramp = max(0, (progress - 0.45) / 0.3)
			let value: Double
			switch rule.signalType {
			case .errorRate:
				value = incident == nil ? 0.004 + 0.002 * sin(Double(index)) : min(0.11, 0.006 + 0.1 * min(1, ramp))
			case .p95Latency, .p99Latency:
				value = incident == nil ? 620 + 40 * sin(Double(index) / 3) : 640 + 780 * min(1, ramp)
			default:
				value = rule.threshold * (0.5 + 0.7 * min(1, ramp))
			}
			let breached = value > rule.threshold
			return AlertCheck(
				comparator: rule.comparator,
				consecutiveBreaches: breached ? 1 : 0,
				consecutiveHealthy: breached ? 0 : 1,
				evaluationDurationMs: 320,
				groupKey: "__total__",
				incidentId: breached ? incident?.id : nil,
				incidentTransition: .none,
				object: .alertCheck,
				observedValue: value,
				sampleCount: 1_000,
				signalType: rule.signalType,
				status: breached ? .breached : .healthy,
				threshold: rule.threshold,
				timestamp: ResolvedTimeWindow.format(at),
				windowEnd: ResolvedTimeWindow.format(at),
				windowMinutes: Double(rule.windowMinutes),
				windowStart: ResolvedTimeWindow.format(at.addingTimeInterval(-Double(rule.windowMinutes) * 60))
			)
		}
	}

	func alertDeliveries(incidentId: String, limit: Int) async throws -> [AlertDelivery] {
		try await pause()
		guard let incident = incidents.first(where: { $0.id == incidentId }) else { return [] }
		var deliveries = [
			AlertDelivery(
				attemptNumber: 1,
				attemptedAt: incident.lastNotifiedAt ?? incident.firstTriggeredAt,
				deliveryKey: "\(incident.id):trigger",
				destinationId: "dest_slack_oncall",
				destinationName: "#oncall",
				destinationType: .slackBot,
				eventType: .trigger,
				id: "evt_\(incident.id)_1",
				incidentId: incident.id,
				object: .alertDelivery,
				responseCode: 200,
				ruleId: incident.ruleId,
				scheduledAt: incident.firstTriggeredAt,
				status: .success
			)
		]
		if incident.severity == .critical {
			deliveries.append(
				AlertDelivery(
					attemptNumber: 2,
					attemptedAt: incident.firstTriggeredAt,
					deliveryKey: "\(incident.id):trigger:pd",
					destinationId: "dest_pagerduty",
					destinationName: "Payments on-call",
					destinationType: .pagerduty,
					errorMessage: incident.status == .open ? "429 Too Many Requests" : nil,
					eventType: .trigger,
					id: "evt_\(incident.id)_2",
					incidentId: incident.id,
					object: .alertDelivery,
					responseCode: incident.status == .open ? 429 : 202,
					ruleId: incident.ruleId,
					scheduledAt: incident.firstTriggeredAt,
					status: incident.status == .open ? .failed : .success
				)
			)
		}
		if let resolved = incident.resolvedAt {
			deliveries.append(
				AlertDelivery(
					attemptNumber: 1,
					attemptedAt: resolved,
					deliveryKey: "\(incident.id):resolve",
					destinationId: "dest_slack_oncall",
					destinationName: "#oncall",
					destinationType: .slackBot,
					eventType: .resolve,
					id: "evt_\(incident.id)_3",
					incidentId: incident.id,
					object: .alertDelivery,
					responseCode: 200,
					ruleId: incident.ruleId,
					scheduledAt: resolved,
					status: .success
				)
			)
		}
		return deliveries
	}

	// MARK: Anomalies

	private var anomalies: [AnomalyIncident] {
		[
			AnomalyIncident(
				baselineMedian: 27.4,
				baselineSigma: 3.1,
				deploymentEnv: "production",
				detectorKey: "throughput:catalog:production",
				fingerprints: [],
				firstTriggeredAt: stamp(-48 * 60),
				id: "anom_catalog_throughput",
				lastObservedValue: 9.8,
				lastSampleCount: 2_300,
				lastTriggeredAt: stamp(-120),
				object: .anomalyIncident,
				openedValue: 11.2,
				reopenCount: 0,
				serviceName: "catalog",
				severity: .warning,
				signalType: .throughput,
				status: .open,
				thresholdValue: 18.1,
				triageStatus: .completed
			)
		]
	}

	func anomalyIncidents(
		status: AnomalyIncidentStatus?, serviceName: String?, window: ResolvedTimeWindow?, limit: Int, cursor: String?
	) async throws -> Page<AnomalyIncident> {
		try await pause()
		var items = anomalies
		if let status { items = items.filter { $0.status == status } }
		if let serviceName { items = items.filter { $0.serviceName == serviceName } }
		return Page(items: items, hasMore: false, nextCursor: nil)
	}

	func anomalyIncident(id: String) async throws -> AnomalyIncident {
		try await pause()
		guard let anomaly = anomalies.first(where: { $0.id == id }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		return anomaly
	}

	func anomalyIncidentTimeseries(id: String) async throws -> AnomalyIncidentTimeseries {
		try await pause()
		let anomaly = try await anomalyIncident(id: id)
		let buckets = (0..<36).map { index -> AnomalyTimeseriesBucket in
			let progress = Double(index) / 35
			let drop = max(0, (progress - 0.6) / 0.15)
			let value = anomaly.baselineMedian * (1 - 0.65 * min(1, drop)) + 1.5 * sin(Double(index))
			return AnomalyTimeseriesBucket(
				bucket: stamp(TimeInterval(-(35 - index) * 300)),
				sampleCount: 100,
				value: max(0, value)
			)
		}
		return AnomalyIncidentTimeseries(
			baselineMedian: anomaly.baselineMedian,
			bucketSeconds: 300,
			buckets: buckets,
			object: .anomalyIncident_timeseries,
			signalType: anomaly.signalType,
			thresholdValue: anomaly.thresholdValue,
			unit: .perMinute
		)
	}

	// MARK: Home Screen widgets

	/// Fixture mode has no server to mint against, and no widget fetches for
	/// itself here — the credential is a well-formed placeholder so the
	/// mint-and-store path can be exercised without a session.
	func mintWidgetCredential(installationId: String) async throws -> WidgetCredential {
		try await pause()
		return WidgetCredential(
			organizationId: FixtureSession.organizationId,
			secret: "maple_ak_fixture",
			apiBaseURL: URL(string: "https://fixtures.maple.invalid")!,
			expiresAt: now.addingTimeInterval(30 * 24 * 60 * 60),
			mintedAt: now
		)
	}

	func revokeWidgetCredential(installationId: String) async throws {
		try await pause()
	}

	/// Assembled from the same seeds the rest of the fixtures use, so a Home
	/// Screen screenshot and the Services tab behind it agree.
	func widgetSummary() async throws -> WidgetSummaryPayload {
		try await pause()
		let bucketSeconds = 300
		let window = TimeWindow.lastHour.resolve(now: now)
		return WidgetSummaryPayload(
			schemaVersion: WidgetSummaryPayload.supportedSchemaVersion,
			generatedAt: now,
			organizationId: FixtureSession.organizationId,
			issues: WidgetSummaryPayload.Issues(
				windowSeconds: 24 * 60 * 60,
				hasMore: false,
				data: issues.map { issue in
					WidgetSummaryPayload.Issue(
						id: issue.id,
						exceptionType: issue.exceptionType,
						errorLabel: issue.errorLabel,
						exceptionMessage: issue.exceptionMessage,
						serviceName: issue.serviceName,
						severity: issue.severity?.rawValue,
						occurrenceCount: issue.occurrenceCount,
						lastSeenAt: ResolvedTimeWindow.parse(issue.lastSeenAt) ?? now,
						isRegressed: issue.regressionCount > 0,
						hasOpenIncident: issue.hasOpenIncident
					)
				}
			),
			throughput: WidgetSummaryPayload.Throughput(
				windowSeconds: Int(window.end.timeIntervalSince(window.start)),
				bucketSeconds: bucketSeconds,
				services: Self.seeds.map { seed in
					WidgetSummaryPayload.Service(
						name: seed.name,
						throughputPerSecond: seed.throughput,
						errorRate: seed.errorRate,
						p95LatencyMs: seed.p95,
						// Counts, not rates — the wire's unit. The mapper divides.
						points: (0..<12).map { index in
							seed.throughput * Double(bucketSeconds) * (index.isMultiple(of: 2) ? 0.92 : 1.08)
						}
					)
				},
				totalPoints: (0..<12).map { index in
					Self.seeds.reduce(0) { total, seed in
						total + seed.throughput * Double(bucketSeconds) * (index.isMultiple(of: 2) ? 0.92 : 1.08)
					}
				}
			)
		)
	}

	// MARK: Telemetry

	func traceTimeseries(_ request: TraceTimeseriesRequest) async throws -> TraceTimeseriesResult {
		try await pause()
		let bucket = TimeInterval(request.resolvedBucketSeconds)
		let count = max(2, Int(request.window.end.timeIntervalSince(request.window.start) / bucket))

		// Grouped: one series per service, which is what the throughput widget
		// asks for. Ungrouped keeps the single-series shape every screen uses.
		if request.groupBy == .service {
			let seeds = Array(Self.seeds.prefix(request.seriesLimit ?? Self.seeds.count))
			return TraceTimeseriesResult(
				aggregation: .init(rawValue: request.aggregation.rawValue) ?? .count,
				bucketSeconds: request.resolvedBucketSeconds,
				endTime: request.window.endTime,
				object: .traceTimeseries,
				series: seeds.map { seed in
					TimeseriesSeries(
						group: seed.name,
						points: series(for: seed, request: request, bucket: bucket, count: count)
					)
				},
				startTime: request.window.startTime
			)
		}

		let seed = Self.seeds.first { $0.name == request.serviceName } ?? Self.seeds[3]
		return TraceTimeseriesResult(
			aggregation: .init(rawValue: request.aggregation.rawValue) ?? .count,
			bucketSeconds: request.resolvedBucketSeconds,
			endTime: request.window.endTime,
			object: .traceTimeseries,
			series: [TimeseriesSeries(group: nil, points: series(for: seed, request: request, bucket: bucket, count: count))],
			startTime: request.window.startTime
		)
	}

	private func series(
		for seed: Seed,
		request: TraceTimeseriesRequest,
		bucket: TimeInterval,
		count: Int
	) -> [TimeseriesValuePoint] {
		let incident = seed.name == "checkout-api" || seed.name == "search"
		return (0..<count).map { index -> TimeseriesValuePoint in
			let progress = Double(index) / Double(max(1, count - 1))
			let ramp = incident ? max(0, (progress - 0.55) / 0.3) : 0
			let wobble = sin(Double(index) * 0.9) * 0.08 + 1
			let value: Double
			switch request.aggregation {
			case .errorRate: value = incident ? min(0.11, 0.004 + 0.1 * min(1, ramp)) : seed.errorRate * wobble
			case .p95Duration: value = seed.p95 * (incident ? 0.55 + 0.6 * min(1, ramp) : wobble)
			case .p99Duration: value = seed.p99 * wobble
			case .p50Duration, .avgDuration: value = seed.p50 * wobble
			case .count: value = seed.throughput * bucket * (incident ? 1 - 0.3 * min(1, ramp) : wobble)
			case .apdex: value = 0.94 * wobble
			}
			return TimeseriesValuePoint(
				timestamp: ResolvedTimeWindow.format(request.window.start.addingTimeInterval(bucket * Double(index))),
				value: value
			)
		}
	}

	func traceBreakdown(_ request: TraceBreakdownRequest) async throws -> TraceBreakdownResult {
		try await pause()
		let service = request.serviceName ?? "web"
		let items: [BreakdownItem]
		switch request.aggregation {
		case .count where request.hasError == true:
			items = [
				BreakdownItem(name: "POST /checkout/authorize", value: 812),
				BreakdownItem(name: "payments.authorize", value: 790),
				BreakdownItem(name: "GET /cart", value: 61),
				BreakdownItem(name: "db.query SELECT carts", value: 12),
			]
		default:
			items = [
				BreakdownItem(name: "POST /checkout/authorize", value: 1_420),
				BreakdownItem(name: "\(service).render", value: 610),
				BreakdownItem(name: "GET /cart", value: 240),
				BreakdownItem(name: "db.query SELECT carts", value: 44),
				BreakdownItem(name: "cache.get", value: 3),
			]
		}
		return TraceBreakdownResult(
			aggregation: .init(rawValue: request.aggregation.rawValue) ?? .count,
			data: Array(items.prefix(request.limit)),
			endTime: request.window.endTime,
			groupBy: request.groupBy.rawValue,
			object: .traceBreakdown,
			startTime: request.window.startTime
		)
	}

	// MARK: Push

	func registerDevice(_ registration: DeviceRegistration) async throws -> MobileDevice {
		try await pause()
		let prefs = registration.preferences ?? .default
		return MobileDevice(
			appVersion: registration.appVersion,
			bundleId: registration.bundleId,
			createdAt: stamp(-86_400),
			deviceName: registration.deviceName,
			enabled: true,
			environment: registration.environment,
			id: "mdev_fixture",
			lastSeenAt: stamp(0),
			liveActivitiesEnabled: registration.liveActivityStartToken != nil,
			object: .mobileDevice,
			platform: .ios,
			preferences: .init(
				anomalies: prefs.anomalies,
				criticalIncidents: prefs.criticalIncidents,
				newErrorIssues: prefs.newErrorIssues,
				resolvedIncidents: prefs.resolvedIncidents,
				warningIncidents: prefs.warningIncidents
			),
			token: registration.token
		)
	}

	func unregisterDevice(token: String) async throws {
		try await pause()
	}

	func myDevices() async throws -> [MobileDevice] {
		try await pause()
		return []
	}

	func registerLiveActivity(
		deviceToken: String,
		incidentId: String,
		activityId: String,
		pushToken: String
	) async throws {
		try await pause()
	}

	func endLiveActivity(deviceToken: String, incidentId: String) async throws {
		try await pause()
	}

	// MARK: Helpers

	private func stamp(_ offset: TimeInterval) -> String {
		ResolvedTimeWindow.format(now.addingTimeInterval(offset))
	}

	private func pause() async throws {
		try await Task.sleep(for: latency)
		try Self.failureInjector.throwIfDue()
	}

	/// `MAPLE_FIXTURES_FAIL_EVERY=<n>` makes every nth request fail as if the
	/// device were offline, so the error state, the refresh-failed strip, and
	/// "Try again" can be exercised without a network to break.
	private static let failureInjector = FailureInjector(
		every: ProcessInfo.processInfo.environment["MAPLE_FIXTURES_FAIL_EVERY"].flatMap(Int.init) ?? 0
	)

	private final class FailureInjector: @unchecked Sendable {
		private let every: Int
		private var count = 0
		private let lock = NSLock()

		init(every: Int) { self.every = every }

		func throwIfDue() throws {
			guard every > 0 else { return }
			lock.lock()
			count += 1
			let due = count % every == 0
			lock.unlock()
			if due { throw MapleAPIError.transport(URLError(.notConnectedToInternet)) }
		}
	}
}

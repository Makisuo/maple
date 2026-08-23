import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let organizationId = "org_fetch"

/// A transport that answers from a script instead of a network, and counts what
/// it was asked for — which is how the coalescing assertions below can tell "one
/// request served three providers" from "three requests happened to agree".
private final class StubProtocol: URLProtocol, @unchecked Sendable {
	nonisolated(unsafe) static var status = 200
	nonisolated(unsafe) static var body = Data()
	nonisolated(unsafe) static var failure: Error?
	nonisolated(unsafe) static var requestCount = 0
	nonisolated(unsafe) static var delay: TimeInterval = 0

	static func reset() {
		status = 200
		body = Data()
		failure = nil
		requestCount = 0
		delay = 0
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func stopLoading() {}

	override func startLoading() {
		Self.requestCount += 1
		let status = Self.status
		let body = Self.body
		let failure = Self.failure
		let url = request.url!
		let finish = {
			if let failure {
				self.client?.urlProtocol(self, didFailWithError: failure)
				return
			}
			let response = HTTPURLResponse(
				url: url,
				statusCode: status,
				httpVersion: "HTTP/1.1",
				headerFields: ["Content-Type": "application/json"]
			)!
			self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
			self.client?.urlProtocol(self, didLoad: body)
			self.client?.urlProtocolDidFinishLoading(self)
		}
		if Self.delay > 0 {
			DispatchQueue.global().asyncAfter(deadline: .now() + Self.delay, execute: finish)
		} else {
			finish()
		}
	}
}

private func stubSession() -> URLSession {
	let configuration = URLSessionConfiguration.ephemeral
	configuration.protocolClasses = [StubProtocol.self]
	configuration.timeoutIntervalForRequest = 1
	configuration.waitsForConnectivity = false
	return URLSession(configuration: configuration)
}

private func payloadJSON(organizationId: String = organizationId, schemaVersion: Int = 1) -> Data {
	Data(
		"""
		{
		  "object": "widget_summary",
		  "schema_version": \(schemaVersion),
		  "generated_at": "2027-01-15T08:00:00.000Z",
		  "organization_id": "\(organizationId)",
		  "issues": {"window_seconds": 86400, "has_more": false, "data": []},
		  "throughput": {
		    "window_seconds": 3600, "bucket_seconds": 60,
		    "services": [{"name":"api","throughput_per_second":10,"error_rate":0,"p95_latency_ms":5,"points":[600]}],
		    "total_points": [600]
		  }
		}
		""".utf8
	)
}

/// A store trio pointed at throwaway state, so nothing here touches the real
/// App Group.
private struct Harness {
	let suite: String
	let directory: URL
	let credentials: WidgetCredentialStore
	let fetchStates: WidgetFetchStateStore
	let fetcher: WidgetSummaryFetcher

	init() {
		suite = "widget-fetch-tests-\(UUID().uuidString)"
		directory = URL(fileURLWithPath: NSTemporaryDirectory())
			.appendingPathComponent(suite, isDirectory: true)
		credentials = WidgetCredentialStore(directory: directory)
		fetchStates = WidgetFetchStateStore(appGroupIdentifier: suite)
		fetcher = WidgetSummaryFetcher(
			credentials: credentials,
			fetchStates: fetchStates,
			session: stubSession()
		)
	}

	func credential(expiresIn: TimeInterval = 30 * 24 * 3_600) {
		credentials.save(
			WidgetCredential(
				organizationId: organizationId,
				secret: "maple_ak_test",
				apiBaseURL: URL(string: "https://api.maple.test")!,
				expiresAt: now.addingTimeInterval(expiresIn),
				mintedAt: now
			)
		)
	}

	func cleanUp() {
		try? FileManager.default.removeItem(at: directory)
		UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
	}
}

@Suite("Widget summary fetcher", .serialized)
struct WidgetSummaryFetcherTests {
	@Test("does not fetch when the app just published")
	func skipsFreshSnapshots() async {
		StubProtocol.reset()
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			// Inside the freshness floor: the app publishes on every foreground,
			// so a widget woken moments later already has this.
			storedGeneratedAt: now.addingTimeInterval(-30),
			now: now
		)
		#expect(attempt == .fresh)
		#expect(StubProtocol.requestCount == 0)
	}

	@Test("says so rather than fetching when the app has not minted yet")
	func noCredential() async {
		StubProtocol.reset()
		let harness = Harness()
		defer { harness.cleanUp() }

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(attempt == .noCredential)
		#expect(StubProtocol.requestCount == 0)
	}

	@Test("does not spend a request to be told a credential it knows is expired is expired")
	func expiredCredential() async {
		StubProtocol.reset()
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential(expiresIn: -60)

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(attempt == .needsApp)
		#expect(StubProtocol.requestCount == 0)
	}

	@Test("writes both widgets' snapshots from one response")
	func writesBothSnapshots() async {
		StubProtocol.reset()
		StubProtocol.body = payloadJSON()
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: "Acme",
			storedGeneratedAt: nil,
			now: now
		)
		guard case .fetched = attempt else {
			Issue.record("expected a fetch, got \(attempt)")
			return
		}
		#expect(StubProtocol.requestCount == 1)
		#expect(harness.fetchStates.load(organizationId: organizationId).lastOutcome == .success)
		#expect(harness.fetchStates.load(organizationId: organizationId).consecutiveFailures == 0)
	}

	@Test("treats a rejected credential as terminal so it cannot burn the budget")
	func unauthorizedIsTerminal() async {
		StubProtocol.reset()
		StubProtocol.status = 401
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let first = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(first == .failed)
		#expect(harness.fetchStates.load(organizationId: organizationId).isCredentialRejected)

		// A rolled credential answers 401 forever. Every rebuild spent retrying
		// is one the widget does not get to be current in.
		let second = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now.addingTimeInterval(3_600)
		)
		#expect(second == .needsApp)
		#expect(StubProtocol.requestCount == 1)

		// Only the app can lift it.
		harness.fetchStates.clearCredentialRejection(organizationId: organizationId)
		#expect(harness.fetchStates.load(organizationId: organizationId).isCredentialRejected == false)
	}

	@Test("a 403 is as dead as a 401 — scopes it no longer has, not a retryable error")
	func forbiddenIsTerminal() async {
		StubProtocol.reset()
		StubProtocol.status = 403
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		_ = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(harness.fetchStates.load(organizationId: organizationId).isCredentialRejected)
	}

	@Test("counts failures so the timeline can back off")
	func countsFailures() async {
		StubProtocol.reset()
		StubProtocol.status = 503
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		for index in 1...3 {
			_ = await harness.fetcher.fetch(
				organizationId: organizationId,
				organizationName: nil,
				storedGeneratedAt: nil,
				// Past the attempt lock each time, so this counts failures rather
				// than coalescing.
				now: now.addingTimeInterval(Double(index) * 600)
			)
		}
		let state = harness.fetchStates.load(organizationId: organizationId)
		#expect(state.consecutiveFailures == 3)
		#expect(state.lastOutcome == .server)
		#expect(state.isCredentialRejected == false)
	}

	@Test("a success clears the backoff")
	func successResets() async {
		StubProtocol.reset()
		StubProtocol.status = 503
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()
		_ = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(harness.fetchStates.load(organizationId: organizationId).consecutiveFailures == 1)

		StubProtocol.status = 200
		StubProtocol.body = payloadJSON()
		_ = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now.addingTimeInterval(600)
		)
		#expect(harness.fetchStates.load(organizationId: organizationId).consecutiveFailures == 0)
	}

	@Test("refuses a payload for a different organization")
	func rejectsWrongOrganization() async {
		StubProtocol.reset()
		// One organization's numbers under another's name is invisible until
		// someone reads the wrong figure off their Home Screen.
		StubProtocol.body = payloadJSON(organizationId: "org_somebody_else")
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(attempt == .failed)
		#expect(harness.fetchStates.load(organizationId: organizationId).lastOutcome == .undecodable)
	}

	@Test("refuses a payload from a newer server")
	func rejectsFutureSchema() async {
		StubProtocol.reset()
		StubProtocol.body = payloadJSON(schemaVersion: WidgetSummaryPayload.supportedSchemaVersion + 1)
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(attempt == .failed)
	}

	@Test("three providers woken together make one request between them")
	func coalesces() async {
		StubProtocol.reset()
		StubProtocol.body = payloadJSON()
		// Long enough that all three are in flight at once, which is the case
		// that matters: WidgetKit builds each pinned instance separately.
		StubProtocol.delay = 0.2
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		async let a = harness.fetcher.fetch(
			organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		async let b = harness.fetcher.fetch(
			organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		async let c = harness.fetcher.fetch(
			organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		_ = await (a, b, c)

		#expect(StubProtocol.requestCount == 1)
	}

	@Test("waits for an attempt another process already has in flight")
	func crossProcessLock() async {
		StubProtocol.reset()
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		// The app stamped an attempt a moment ago and has not reported back. This
		// has to keep working *after* the first successful fetch — inferring
		// in-flight from "no outcome yet" would stop working the moment it first
		// worked.
		harness.fetchStates.save(
			WidgetFetchState(lastOutcome: .success, consecutiveFailures: 0).attempting(at: now),
			organizationId: organizationId
		)
		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now.addingTimeInterval(5)
		)
		#expect(attempt == .coalesced)
		#expect(StubProtocol.requestCount == 0)
	}

	@Test("a lock nothing released expires rather than freezing the widget")
	func staleLockExpires() async {
		StubProtocol.reset()
		StubProtocol.body = payloadJSON()
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		// A process killed mid-fetch never clears the flag.
		harness.fetchStates.save(
			WidgetFetchState().attempting(at: now),
			organizationId: organizationId
		)
		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now.addingTimeInterval(WidgetSummaryFetcher.attemptLock + 1)
		)
		guard case .fetched = attempt else {
			Issue.record("expected a fetch, got \(attempt)")
			return
		}
	}

	@Test("offline is an answer, and a fast one")
	func offline() async {
		StubProtocol.reset()
		StubProtocol.failure = URLError(.notConnectedToInternet)
		let harness = Harness()
		defer { harness.cleanUp() }
		harness.credential()

		let attempt = await harness.fetcher.fetch(
			organizationId: organizationId,
			organizationName: nil,
			storedGeneratedAt: nil,
			now: now
		)
		#expect(attempt == .failed)
		#expect(harness.fetchStates.load(organizationId: organizationId).lastOutcome == .unreachable)
	}
}

@Suite("Widget timeline backoff")
struct WidgetTimelineBackoffTests {
	@Test("a healthy widget asks on the normal interval")
	func healthyInterval() {
		#expect(WidgetTimelineSchedule.refreshInterval(consecutiveFailures: 0) == 45 * 60)
	}

	@Test("one miss is worth a quick retry; repeated failure is not")
	func backsOff() {
		let intervals = (0...5).map { WidgetTimelineSchedule.refreshInterval(consecutiveFailures: $0) }
		// A single miss is usually a tunnel — back inside a quarter of an hour.
		#expect(intervals[1] == 15 * 60)
		// After that, monotonically further out, so a widget that cannot fix
		// itself stops spending the day's rebuilds on failures.
		#expect(intervals[2] > intervals[1])
		#expect(intervals[3] > intervals[2])
		#expect(intervals[4] > intervals[3])
		#expect(intervals[5] == intervals[4])
		#expect(intervals[4] == 4 * 60 * 60)
	}

	@Test("the entry ladder still reaches past the refresh, so a throttled widget ages honestly")
	func ladderOutlastsThePolicy() {
		let dates = WidgetTimelineSchedule.entryDates(from: now)
		let refresh = WidgetTimelineSchedule.refreshDate(from: now)
		#expect(dates.last! > refresh)
	}
}

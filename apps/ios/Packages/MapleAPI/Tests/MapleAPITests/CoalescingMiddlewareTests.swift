import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

/// Records every request that reaches the network and parks it until released,
/// so a test can hold several in flight at once and count what actually went
/// out. The counterpart to `MintGate` one layer down.
private actor RecordingTransport: ClientTransport {
	private(set) var requests: [HTTPRequest] = []
	private var isOpen = false
	private var waiters: [CheckedContinuation<Void, Never>] = []
	private var arrivals: [CheckedContinuation<Void, Never>] = []
	private var status: HTTPResponse.Status = .ok
	private var payload = #"{"items":[],"hasMore":false}"#

	func answer(status: HTTPResponse.Status, payload: String = "{}") {
		self.status = status
		self.payload = payload
	}

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		requests.append(request)
		resumeArrivals()
		if !isOpen {
			await withCheckedContinuation { waiters.append($0) }
		}
		return (HTTPResponse(status: status), HTTPBody(payload))
	}

	func waitForArrivals(_ count: Int) async {
		while requests.count < count {
			await withCheckedContinuation { arrivals.append($0) }
		}
	}

	func open() {
		isOpen = true
		for waiter in waiters { waiter.resume() }
		waiters.removeAll()
	}

	func count() -> Int { requests.count }

	private func resumeArrivals() {
		for arrival in arrivals { arrival.resume() }
		arrivals.removeAll()
	}
}

private struct StaticTokens: MapleTokenProvider {
	let value: String

	func token(forceRefresh: Bool) async throws -> String? { value }
}

@Suite("Request coalescing")
struct CoalescingMiddlewareTests {
	private let baseURL = URL(string: "https://api.maple.dev")!

	/// Sends `count` identical GETs through one chain, holding them all at the
	/// transport before releasing.
	private func sendConcurrently(
		count: Int,
		through middlewares: [any ClientMiddleware],
		transport: RecordingTransport,
		request: HTTPRequest
	) async throws -> [Data?] {
		try await withThrowingTaskGroup(of: Data?.self) { group in
			for _ in 0 ..< count {
				group.addTask {
					let (_, body) = try await Self.send(request, through: middlewares, transport: transport, baseURL: baseURL)
					guard let body else { return nil }
					return try await Data(collecting: body, upTo: 1024 * 1024)
				}
			}
			await transport.waitForArrivals(1)
			await transport.open()
			return try await group.reduce(into: [Data?]()) { $0.append($1) }
		}
	}

	private static func send(
		_ request: HTTPRequest,
		through middlewares: [any ClientMiddleware],
		transport: RecordingTransport,
		baseURL: URL
	) async throws -> (HTTPResponse, HTTPBody?) {
		var next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?) = {
			try await transport.send($0, body: $1, baseURL: $2, operationID: "test")
		}
		for middleware in middlewares.reversed() {
			let inner = next
			next = { try await middleware.intercept($0, body: $1, baseURL: $2, operationID: "test", next: inner) }
		}
		return try await next(request, nil, baseURL)
	}

	private func get(path: String, token: String = "tok", organization: String? = nil) -> HTTPRequest {
		var request = HTTPRequest(method: .get, scheme: "https", authority: "api.maple.dev", path: path)
		request.headerFields[.authorization] = "Bearer \(token)"
		if let organization {
			request.headerFields[OrganizationMiddleware.headerName] = organization
		}
		return request
	}

	/// The headline case: Home and the Services tab both asking for the same
	/// window while one is still in flight.
	@Test func identicalConcurrentGetsIssueOneRequest() async throws {
		let transport = RecordingTransport()
		let bodies = try await sendConcurrently(
			count: 3,
			through: [CoalescingMiddleware()],
			transport: transport,
			request: get(path: "/v2/services?startTime=1&endTime=2")
		)

		#expect(await transport.count() == 1)
		// Every waiter gets a readable body. `HTTPBody` is single-consumption,
		// so the naive implementation hands two of the three an empty one.
		#expect(bodies.count == 3)
		#expect(bodies.allSatisfy { $0 != nil && !$0!.isEmpty })
		#expect(Set(bodies.map { $0.map { String(decoding: $0, as: UTF8.self) } }).count == 1)
	}

	/// Different query strings are different questions.
	@Test func differentQueriesAreNotShared() async throws {
		let transport = RecordingTransport()
		await transport.open()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware()]

		_ = try await Self.send(get(path: "/v2/services?startTime=1"), through: middlewares, transport: transport, baseURL: baseURL)
		_ = try await Self.send(get(path: "/v2/services?startTime=2"), through: middlewares, transport: transport, baseURL: baseURL)

		#expect(await transport.count() == 2)
	}

	/// The widget-publisher case: `scoped(to:)` names the organization in a
	/// header, and two organizations must never share a response body.
	@Test func differentOrganizationsAreNotShared() async throws {
		let transport = RecordingTransport()
		let coalescer = RequestCoalescer()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware(coalescer: coalescer)]

		try await withThrowingTaskGroup(of: Void.self) { group in
			group.addTask {
				_ = try await Self.send(
					self.get(path: "/v2/services", organization: "org_a"),
					through: middlewares, transport: transport, baseURL: self.baseURL
				)
			}
			group.addTask {
				_ = try await Self.send(
					self.get(path: "/v2/services", organization: "org_b"),
					through: middlewares, transport: transport, baseURL: self.baseURL
				)
			}
			await transport.waitForArrivals(2)
			await transport.open()
			try await group.waitForAll()
		}

		#expect(await transport.count() == 2)
	}

	/// Two organizations also differ by bearer token alone — the unscoped client
	/// carries the organization in the token's claim, not in any header.
	@Test func differentTokensAreNotShared() async throws {
		let transport = RecordingTransport()
		let coalescer = RequestCoalescer()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware(coalescer: coalescer)]

		try await withThrowingTaskGroup(of: Void.self) { group in
			for token in ["token_a", "token_b"] {
				group.addTask {
					_ = try await Self.send(
						self.get(path: "/v2/services", token: token),
						through: middlewares, transport: transport, baseURL: self.baseURL
					)
				}
			}
			await transport.waitForArrivals(2)
			await transport.open()
			try await group.waitForAll()
		}

		#expect(await transport.count() == 2)
	}

	/// Coalescing a write would silently drop one, and tell its caller the write
	/// succeeded when it never ran.
	@Test func writesAreNeverCoalesced() async throws {
		let transport = RecordingTransport()
		let coalescer = RequestCoalescer()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware(coalescer: coalescer)]
		let request: HTTPRequest = {
			var request = HTTPRequest(method: .post, scheme: "https", authority: "api.maple.dev", path: "/v2/devices")
			request.headerFields[.authorization] = "Bearer tok"
			return request
		}()

		try await withThrowingTaskGroup(of: Void.self) { group in
			for _ in 0 ..< 2 {
				group.addTask {
					_ = try await Self.send(request, through: middlewares, transport: transport, baseURL: self.baseURL)
				}
			}
			await transport.waitForArrivals(2)
			await transport.open()
			try await group.waitForAll()
		}

		#expect(await transport.count() == 2)
	}

	/// Every waiter must get the failure it would have received on its own —
	/// and get it typed, because `ErrorMappingMiddleware` still runs per caller
	/// above the coalescer.
	@Test func failuresReachEveryWaiterTyped() async throws {
		let transport = RecordingTransport()
		await transport.answer(status: .internalServerError, payload: "boom")
		let middlewares: [any ClientMiddleware] = [ErrorMappingMiddleware(), CoalescingMiddleware()]
		let request = get(path: "/v2/services")

		let failures = await withTaskGroup(of: (any Error)?.self) { group in
			for _ in 0 ..< 3 {
				group.addTask {
					do {
						_ = try await Self.send(request, through: middlewares, transport: transport, baseURL: self.baseURL)
						return nil
					} catch {
						return error
					}
				}
			}
			await transport.waitForArrivals(1)
			await transport.open()
			return await group.reduce(into: [(any Error)?]()) { $0.append($1) }
		}

		#expect(await transport.count() == 1)
		#expect(failures.count == 3)
		#expect(failures.allSatisfy { $0 is MapleAPIError })
	}

	/// In-flight only. Once a response has been delivered the next caller goes
	/// to the network, so nothing is ever served from an unbounded cache.
	@Test func aCompletedRequestIsNotReused() async throws {
		let transport = RecordingTransport()
		await transport.open()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware()]
		let request = get(path: "/v2/services")

		_ = try await Self.send(request, through: middlewares, transport: transport, baseURL: baseURL)
		_ = try await Self.send(request, through: middlewares, transport: transport, baseURL: baseURL)

		#expect(await transport.count() == 2)
	}

	/// A cancelled leader must not take its waiters down with it.
	///
	/// This is the case the whole app runs into: `ScreenLoader` cancels a
	/// running `refresh` whenever an `initial` supersedes it, and a request from
	/// a different screen may have joined that refresh in the meantime. It never
	/// asked to be cancelled, and `perform` reads a cancellation as "leave the
	/// screen alone" — so a propagated one would silently blank a tab.
	@Test func aCancelledLeaderPromotesAWaiter() async throws {
		let coalescer = RequestCoalescer()
		let key = "GET\nhttps://api.maple.dev\n/v2/services"

		// The leader takes the key, then a second caller joins behind it.
		#expect(await coalescer.join(key: key) == nil)
		let waiter = Task { await coalescer.join(key: key) }
		await Task.yield()

		// The leader is cancelled. The waiter should be promoted, not failed.
		await coalescer.complete(key: key, with: .failure(CancellationError()))
		let outcome = await waiter.value
		#expect(outcome == nil, "the waiter should have been promoted to leader")

		// And it really does hold the key: a third caller waits behind it rather
		// than starting a second request.
		let third = Task { await coalescer.join(key: key) }
		await Task.yield()
		#expect(await coalescer.count == 1)

		let response = BufferedResponse(response: HTTPResponse(status: .ok), body: Data("{}".utf8))
		await coalescer.complete(key: key, with: .success(response))
		#expect(try await third.value?.get().body == Data("{}".utf8))
		#expect(await coalescer.count == 0)
	}

	/// A non-cancellation failure is not promoted — every waiter gets the error,
	/// because every one of them would have received it on its own.
	@Test func aFailedLeaderDoesNotPromote() async throws {
		let coalescer = RequestCoalescer()
		let key = "GET\nhttps://api.maple.dev\n/v2/services"

		#expect(await coalescer.join(key: key) == nil)
		let waiter = Task { await coalescer.join(key: key) }
		await Task.yield()

		await coalescer.complete(key: key, with: .failure(MapleAPIError.notAuthenticated))
		let outcome = try #require(await waiter.value)
		#expect(throws: MapleAPIError.self) { try outcome.get() }
		#expect(await coalescer.count == 0)
	}

	/// The coalescer must not leak entries: a key retired by its own flight, and
	/// nothing left behind after everything settles.
	@Test func theRegistryEmptiesOut() async throws {
		let transport = RecordingTransport()
		await transport.open()
		let coalescer = RequestCoalescer()
		let middlewares: [any ClientMiddleware] = [CoalescingMiddleware(coalescer: coalescer)]

		_ = try await Self.send(get(path: "/v2/services"), through: middlewares, transport: transport, baseURL: baseURL)

		#expect(await coalescer.count == 0)
	}
}

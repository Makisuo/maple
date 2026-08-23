import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Shares one in-flight response between identical concurrent GETs.
///
/// Screens fetch independently and none of them knows the others exist: Home
/// wants services, so does the Services tab, so does the widget publisher. When
/// two of those overlap — a pull-to-refresh while a tab switch is still
/// loading, or a rebuilt model starting an `initial` load over a running
/// `refresh` — the same URL goes out two or three times.
///
/// Production traces put `/v2/services` at 2.05 calls per ten-second window per
/// session, duplicated in 72% of windows, peaking at five. Against an endpoint
/// whose server-side p95 is 1.2s, that is the single most expensive redundancy
/// in the app.
///
/// **In-flight only, deliberately.** This is not a response cache and holds
/// nothing after the request completes. A TTL cache would be the obvious next
/// step and it is the wrong one for these screens: every caller here is asking
/// "what is true right now", and a cached answer is a staleness argument
/// waiting to happen. Coalescing sidesteps it entirely — a joined caller gets a
/// response no older than the one it would have fetched itself, because it is
/// the response it would have fetched itself.
public struct CoalescingMiddleware: ClientMiddleware {
	/// Bodies are buffered so every waiter can be handed its own copy, which
	/// bounds what a single response may cost. List endpoints answer in tens of
	/// kilobytes; this only stops a pathological body from being held in memory.
	static let maxBufferedBytes = 16 * 1024 * 1024

	private let coalescer: RequestCoalescer

	public init() {
		self.coalescer = RequestCoalescer()
	}

	/// Shares one coalescer across several clients — `scoped(to:)` builds a
	/// client per organization and they should still dedupe against each other.
	public init(coalescer: RequestCoalescer) {
		self.coalescer = coalescer
	}

	public func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		// Only idempotent reads. Coalescing two POSTs would drop one of them,
		// and the caller would be told its write succeeded when it never ran.
		guard request.method == .get else {
			return try await next(request, body, baseURL)
		}

		let key = Self.key(for: request, baseURL: baseURL)

		// `next` is not `@Sendable`, so the work cannot be handed to the actor to
		// run. Instead the actor only arbitrates: it either parks this caller
		// behind an existing flight, or nominates it leader and lets it make the
		// call here, in its own isolation.
		if let outcome = await coalescer.join(key: key) {
			let buffered = try outcome.get()
			return (buffered.response, buffered.body.map { HTTPBody($0) })
		}

		do {
			let (response, responseBody) = try await next(request, body, baseURL)
			// `HTTPBody` is a single-consumption stream. Handing the same one to
			// three waiters gives two of them an empty body, so it is collected
			// once here and replayed per caller below.
			var buffered = BufferedResponse(response: response, body: nil)
			if let responseBody {
				let data = try await Data(collecting: responseBody, upTo: Self.maxBufferedBytes)
				buffered = BufferedResponse(response: response, body: data)
			}
			await coalescer.complete(key: key, with: .success(buffered))
			return (buffered.response, buffered.body.map { HTTPBody($0) })
		} catch {
			await coalescer.complete(key: key, with: .failure(error))
			throw error
		}
	}

	/// What makes two requests "the same request".
	///
	/// The authorization header is part of it because the organization lives in
	/// the token's claim rather than in the URL — two organizations ask for
	/// `/v2/services` with byte-identical paths and must never share a response.
	/// `x-maple-org-id` covers the one caller that names the organization
	/// explicitly instead (the widget publisher, via `scoped(to:)`).
	static func key(for request: HTTPRequest, baseURL: URL) -> String {
		let authorization = request.headerFields[.authorization] ?? ""
		let organization = request.headerFields[OrganizationMiddleware.headerName] ?? ""
		return [
			request.method.rawValue,
			baseURL.absoluteString,
			request.path ?? "",
			authorization,
			organization,
		].joined(separator: "\n")
	}
}

/// A response held whole, so it can be handed to more than one waiter.
struct BufferedResponse: Sendable {
	let response: HTTPResponse
	let body: Data?
}

/// Decides which caller performs a request and which callers wait on it.
///
/// Separate from the middleware because a middleware is a value type that the
/// generated client copies, and the whole point is shared state.
public actor RequestCoalescer {
	/// A waiter is resumed either with the leader's outcome, or with `nil`
	/// meaning "the leader went away, you are the leader now".
	private typealias Waiter = CheckedContinuation<Result<BufferedResponse, any Error>?, Never>

	private var leading: Set<String> = []
	private var waiting: [String: [Waiter]] = [:]

	public init() {}

	/// `nil` means this caller is the leader and must perform the request, then
	/// report back through `complete(key:with:)`. A non-nil result is the
	/// leader's outcome, already delivered.
	func join(key: String) async -> Result<BufferedResponse, any Error>? {
		guard leading.contains(key) else {
			leading.insert(key)
			return nil
		}
		return await withCheckedContinuation { (continuation: Waiter) in
			waiting[key, default: []].append(continuation)
		}
	}

	/// Hand the leader's outcome to everyone waiting on it.
	func complete(key: String, with result: Result<BufferedResponse, any Error>) {
		var pending = waiting.removeValue(forKey: key) ?? []

		// A cancelled leader must not cancel its waiters. Screens cancel loads
		// routinely — an `initial` supersedes a running `refresh` — and a waiter
		// that joined from a different screen never asked to be cancelled.
		// Promote the first one to leader instead and let it make the call.
		if result.isCancellation, let promoted = pending.first {
			waiting[key] = Array(pending.dropFirst())
			promoted.resume(returning: nil)
			return  // `key` stays in `leading`: the promoted waiter now holds it.
		}

		leading.remove(key)
		for waiter in pending { waiter.resume(returning: result) }
		pending.removeAll()
	}

	/// In-flight request count. For tests.
	var count: Int { leading.count }
}

extension Result where Success == BufferedResponse, Failure == any Error {
	fileprivate var isCancellation: Bool {
		guard case .failure(let error) = self else { return false }
		if error is CancellationError { return true }
		if let apiError = error as? MapleAPIError { return apiError.isCancellation }
		return false
	}
}

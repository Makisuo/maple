import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

/// Records what a request actually carried, and answers with a body the
/// generated client can decode so the call completes.
///
/// The environment scope is checked on the **wire**, not on the client, for one
/// reason: it is not a header. Every endpoint spells it in its own query
/// parameter or body field, several endpoints have none at all, and one of them
/// spells it differently from all the others. A scope that silently reaches
/// nothing looks exactly like a scope that reaches everything until someone
/// reads a filtered screen and sees unfiltered numbers.
private final class ScriptedTransport: ClientTransport, @unchecked Sendable {
	private(set) var lastRequest: HTTPRequest?
	private(set) var lastBody: String?
	private let responseJSON: String

	init(responseJSON: String) {
		self.responseJSON = responseJSON
	}

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		lastRequest = request
		if let body {
			let collected = try await [UInt8](collecting: body, upTo: 1_000_000)
			lastBody = String(decoding: collected, as: UTF8.self)
		} else {
			lastBody = nil
		}
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(responseJSON))
	}
}

private struct StaticTokens: MapleTokenProvider {
	func token(forceRefresh: Bool) async throws -> String? { "test-token" }
}

@Suite("Environment scoping")
struct EnvironmentScopeTests {
	private static let emptyList = #"{"object":"list","has_more":false,"next_cursor":null,"data":[]}"#

	private func client(_ transport: ScriptedTransport, environment: String?) -> any MapleAPI {
		MapleClient(
			tokens: StaticTokens(),
			serverURL: URL(string: "https://api.maple.test")!,
			transport: transport
		)
		.scoped(toEnvironment: environment)
	}

	private var window: ResolvedTimeWindow {
		TimeWindow.last24Hours.resolve(now: Date(timeIntervalSince1970: 1_756_000_000))
	}

	@Test("The services listing carries the scope, and carries nothing without one")
	func services() async throws {
		let scoped = ScriptedTransport(responseJSON: Self.emptyList)
		_ = try await client(scoped, environment: "staging").services(window: window, limit: 50)
		#expect(scoped.lastRequest?.path?.contains("deployment_environment=staging") == true)

		let unscoped = ScriptedTransport(responseJSON: Self.emptyList)
		_ = try await client(unscoped, environment: nil).services(window: window, limit: 50)
		// Absent, not empty: `deployment_environment=` would filter to the blank
		// environment, which the warehouse reads as "unset" and answers with
		// everything — a filter that silently does nothing.
		#expect(unscoped.lastRequest?.path?.contains("deployment_environment") == false)
	}

	@Test("The issues listing carries the scope")
	func issues() async throws {
		let transport = ScriptedTransport(responseJSON: Self.emptyList)
		_ = try await client(transport, environment: "staging").issues(
			query: IssueQuery(),
			window: nil,
			limit: 20,
			cursor: nil
		)
		#expect(transport.lastRequest?.path?.contains("deployment_environment=staging") == true)
	}

	/// The one endpoint that spells the parameter short. Pinned because nothing
	/// else would catch it: sending `deployment_environment` here is not an
	/// error, it is an ignored parameter and an unfiltered list.
	@Test("The anomalies listing spells it deployment_env, not deployment_environment")
	func anomalies() async throws {
		let transport = ScriptedTransport(responseJSON: Self.emptyList)
		_ = try await client(transport, environment: "staging").anomalyIncidents(
			status: nil,
			serviceName: nil,
			window: nil,
			limit: 20,
			cursor: nil
		)
		let path = try #require(transport.lastRequest?.path)
		#expect(path.contains("deployment_env=staging"))
		#expect(!path.contains("deployment_environment="))
	}

	/// The regression this guard exists for: `filters` used to be built only
	/// when a service or an error flag was set, so an environment-only chart
	/// sent no filters at all — a successful request, and every environment's
	/// traffic drawn under one environment's label.
	@Test("A trace query with only an environment still sends a filters object")
	func traceFiltersSurviveWithoutAServiceName() async throws {
		let transport = ScriptedTransport(
			responseJSON: """
				{"object":"trace_timeseries","aggregation":"count","bucket_seconds":300,
				 "start_time":"2026-08-21T08:00:00.000Z","end_time":"2026-08-21T09:00:00.000Z",
				 "series":[]}
				"""
		)
		_ = try await client(transport, environment: "staging").traceTimeseries(
			TraceTimeseriesRequest(aggregation: .count, window: window)
		)
		// Whitespace-insensitive: the generated client pretty-prints its bodies,
		// so matching the compact spelling would fail on formatting rather than
		// on the thing under test.
		let body = try #require(transport.lastBody).filter { !$0.isWhitespace }
		#expect(body.contains("\"deployment_environment\":\"staging\""))
	}

	@Test("The widget summary carries the scope")
	func widgetSummary() async throws {
		let transport = ScriptedTransport(
			responseJSON: """
				{"object":"widget_summary","schema_version":1,
				 "generated_at":"2026-08-21T09:10:00.000Z","organization_id":"org_2abc",
				 "deployment_environment":"staging",
				 "issues":{"window_seconds":86400,"has_more":false,"data":[]},
				 "throughput":{"window_seconds":3600,"bucket_seconds":300,"services":[],"total_points":[]}}
				"""
		)
		let payload = try await client(transport, environment: "staging").widgetSummary()
		#expect(transport.lastRequest?.path?.contains("deployment_environment=staging") == true)
		// The echo, not the value asked for: it is what the caller keys its
		// snapshot slot on, so a server that ignored the parameter has to be
		// distinguishable from one that honoured it.
		#expect(payload.deploymentEnvironment == "staging")
	}

	/// The endpoints that have no environment parameter must not grow a
	/// hand-rolled one — a query string the contract does not declare is a
	/// decode error at the boundary, not a filter.
	@Test("Endpoints with no environment parameter send nothing extra")
	func unfilterableEndpointsStayUnfiltered() async throws {
		let transport = ScriptedTransport(responseJSON: Self.emptyList)
		_ = try await client(transport, environment: "staging").alertIncidents(
			status: nil,
			ruleId: nil,
			limit: 20,
			cursor: nil
		)
		#expect(transport.lastRequest?.path?.contains("deployment") == false)
	}

	@Test("The environments listing is not filtered by the current selection")
	func environmentsListingIgnoresTheScope() async throws {
		// Otherwise choosing "staging" would leave the picker offering staging
		// alone, and the user unable to choose anything else.
		let transport = ScriptedTransport(
			responseJSON: #"{"object":"list","has_more":false,"next_cursor":null,"data":[{"object":"environment","name":"production"}]}"#
		)
		let environments = try await client(transport, environment: "staging").environments(window: window)
		#expect(transport.lastRequest?.path?.contains("deployment_environment") == false)
		#expect(environments == ["production"])
	}

	@Test("Scoping to an environment keeps the organization scope")
	func scopesCompose() async throws {
		let transport = ScriptedTransport(responseJSON: Self.emptyList)
		let api = MapleClient(
			tokens: StaticTokens(),
			serverURL: URL(string: "https://api.maple.test")!,
			transport: transport
		)
		.scoped(to: "org_2abc")
		.scoped(toEnvironment: "staging")

		_ = try await api.services(window: window, limit: 50)
		// The organization travels in a header and the environment in the query
		// string, so the second scope dropping the first would be invisible on
		// the wire it does control.
		#expect(transport.lastRequest?.headerFields[OrganizationMiddleware.headerName] == "org_2abc")
		#expect(transport.lastRequest?.path?.contains("deployment_environment=staging") == true)
	}
}

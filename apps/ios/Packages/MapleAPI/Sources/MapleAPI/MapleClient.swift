import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

public typealias Service = Components.Schemas.Service
public typealias ErrorIssue = Components.Schemas.ErrorIssue
public typealias ErrorIssueDetail = Components.Schemas.ErrorIssueDetail
public typealias ErrorIssueActor = Components.Schemas.ErrorIssueActor
public typealias ErrorIncident = Components.Schemas.ErrorIncident
public typealias ErrorIssueSampleTrace = Components.Schemas.ErrorIssueSampleTrace
public typealias ErrorIssueServiceCount = Components.Schemas.ErrorIssueServiceCount
public typealias ErrorIssueTimeseriesPoint = Components.Schemas.ErrorIssueTimeseriesPoint
public typealias IssueSeverity = Components.Schemas._MapleIssueSeverity
public typealias WorkflowState = Components.Schemas._MapleWorkflowState
public typealias IssueKind = Components.Schemas._MapleIssueKind

public typealias AlertIncident = Components.Schemas.AlertIncident
public typealias AlertRule = Components.Schemas.AlertRule
public typealias AlertCheck = Components.Schemas.AlertCheck
public typealias AlertDelivery = Components.Schemas.AlertDelivery
public typealias AlertSeverity = Components.Schemas._MapleAlertSeverity
public typealias AlertSignalType = Components.Schemas._MapleAlertSignalType
public typealias AlertComparator = Components.Schemas._MapleAlertComparator
public typealias AlertIncidentStatus = Components.Schemas._MapleAlertIncidentStatus
public typealias AlertCheckStatus = Components.Schemas._MapleAlertCheckStatus
public typealias AlertEventType = Components.Schemas._MapleAlertEventType
public typealias AlertDeliveryStatus = Components.Schemas._MapleAlertDeliveryStatus
public typealias AlertDestinationType = Components.Schemas._MapleAlertDestinationType

public typealias AnomalyIncident = Components.Schemas.AnomalyIncident
public typealias AnomalyIncidentTimeseries = Components.Schemas.AnomalyIncidentTimeseries
public typealias AnomalyTimeseriesBucket = Components.Schemas.AnomalyTimeseriesBucket
public typealias AnomalyIncidentStatus = Components.Schemas._MapleAnomalyIncidentStatus
public typealias AnomalyIncidentSeverity = Components.Schemas._MapleAnomalyIncidentSeverity
public typealias AnomalySignalType = Components.Schemas._MapleAnomalySignalType

public typealias MobileDevice = Components.Schemas.MobileDevice
public typealias PushEnvironment = Components.Schemas._MapleMobilePushEnvironment

public typealias TraceTimeseriesResult = Components.Schemas.TraceTimeseriesResult
public typealias TraceBreakdownResult = Components.Schemas.TraceBreakdownResult
public typealias TraceAggregation = Components.Schemas.TraceTimeseriesParams.AggregationPayload
public typealias TraceBreakdownAggregation = Components.Schemas.TraceBreakdownParams.AggregationPayload
public typealias TraceBreakdownGroup = Components.Schemas.TraceBreakdownParams.GroupByPayload
public typealias TraceTimeseriesGroup = Components.Schemas.TraceTimeseriesParams.GroupByPayload
public typealias TimeseriesSeries = Components.Schemas.TimeseriesSeries
public typealias TimeseriesValuePoint = Components.Schemas.TimeseriesValuePoint
public typealias BreakdownItem = Components.Schemas.BreakdownItem

/// `IssueSeverity` widened with the `unset` sentinel the list filter accepts.
/// The pruned spec merges the contract's `IssueSeverity | "unset"` union into
/// this single enum — ungathered, it would generate a struct-of-optionals.
public typealias IssueSeverityFilter = Operations.ListErrorIssues.Input.Query.SeverityPayload

/// One page of a cursor-paginated list.
public struct Page<Element: Sendable>: Sendable {
	public let items: [Element]
	public let hasMore: Bool
	public let nextCursor: String?

	public init(items: [Element], hasMore: Bool, nextCursor: String?) {
		self.items = items
		self.hasMore = hasMore
		self.nextCursor = nextCursor
	}
}

/// How `listErrorIssues` should be filtered and ordered.
public struct IssueQuery: Hashable, Sendable {
	public var workflowState: WorkflowState?
	public var severity: IssueSeverityFilter?
	public var kind: IssueKind?
	public var serviceName: String?
	public var actionableOnly: Bool
	public var sort: Sort

	public enum Sort: String, CaseIterable, Sendable {
		case lastSeen = "last_seen"
		case severity

		public var title: String {
			switch self {
			case .lastSeen: "Most recent"
			case .severity: "Most severe"
			}
		}
	}

	public init(
		workflowState: WorkflowState? = nil,
		severity: IssueSeverityFilter? = nil,
		kind: IssueKind? = nil,
		serviceName: String? = nil,
		actionableOnly: Bool = false,
		sort: Sort = .lastSeen
	) {
		self.workflowState = workflowState
		self.severity = severity
		self.kind = kind
		self.serviceName = serviceName
		self.actionableOnly = actionableOnly
		self.sort = sort
	}
}

/// The API surface the app uses.
///
/// A protocol so screens can be driven by a stub in tests and previews without
/// a network, a token, or a signed-in user.
public protocol MapleAPI: Sendable {
	/// A view of this client that names `organizationId` explicitly instead of
	/// relying on the session token's active-organization claim.
	///
	/// A scoped *instance* rather than a per-call argument: the alternative is a
	/// parameter on all twenty methods below and every stub that implements
	/// them. A task-local would read better still, but its failure mode —
	/// "forgot to wrap, request silently went to the active organization" — is
	/// the exact bug this exists to prevent.
	func scoped(to organizationId: String) -> any MapleAPI

	func services(window: ResolvedTimeWindow, limit: Int) async throws -> Page<Service>
	func service(named name: String, window: ResolvedTimeWindow) async throws -> Service
	func issues(query: IssueQuery, window: ResolvedTimeWindow?, limit: Int, cursor: String?) async throws
		-> Page<ErrorIssue>
	func issue(id: String) async throws -> ErrorIssueDetail
	func issueCountsByService() async throws -> [ErrorIssueServiceCount]

	// Alerts — see MapleClient+Alerts.swift
	func alertIncidents(status: AlertIncidentStatus?, ruleId: String?, limit: Int, cursor: String?) async throws
		-> Page<AlertIncident>
	func alertIncident(id: String) async throws -> AlertIncident
	func alertRules(limit: Int, cursor: String?) async throws -> Page<AlertRule>
	func alertRule(id: String) async throws -> AlertRule
	func alertRuleChecks(ruleId: String, groupKey: String?, since: Date?, limit: Int) async throws -> [AlertCheck]
	func alertDeliveries(incidentId: String, limit: Int) async throws -> [AlertDelivery]

	// Anomalies — see MapleClient+Alerts.swift
	func anomalyIncidents(status: AnomalyIncidentStatus?, serviceName: String?, window: ResolvedTimeWindow?, limit: Int, cursor: String?)
		async throws -> Page<AnomalyIncident>
	func anomalyIncident(id: String) async throws -> AnomalyIncident
	func anomalyIncidentTimeseries(id: String) async throws -> AnomalyIncidentTimeseries

	// Push — see MapleClient+Devices.swift
	func registerDevice(_ registration: DeviceRegistration) async throws -> MobileDevice
	func unregisterDevice(token: String) async throws
	func myDevices() async throws -> [MobileDevice]
	func registerLiveActivity(deviceToken: String, incidentId: String, activityId: String, pushToken: String)
		async throws
	func endLiveActivity(deviceToken: String, incidentId: String) async throws

	// Telemetry — see MapleClient+Telemetry.swift
	func traceTimeseries(_ request: TraceTimeseriesRequest) async throws -> TraceTimeseriesResult
	func traceBreakdown(_ request: TraceBreakdownRequest) async throws -> TraceBreakdownResult
}

extension MapleAPI {
	/// Stubs and fixtures serve one organization and ignore the scope.
	public func scoped(to organizationId: String) -> any MapleAPI { self }
}

/// The live client: generated operations, wrapped so call sites see plain
/// values and one error type.
public struct MapleClient: MapleAPI {
	let client: Client
	private let tokens: any MapleTokenProvider
	private let serverURL: URL
	private let transport: any ClientTransport
	/// Shared with every client `scoped(to:)` produces, so a widget fetch for
	/// one organization still dedupes against a foreground fetch for another
	/// when they happen to be identical.
	private let coalescer: RequestCoalescer

	/// - Parameters:
	///   - tokens: supplies the Clerk session JWT.
	///   - baseURL: defaults to the server declared in the OpenAPI document
	///     (`https://api.maple.dev`), so the production URL is never hardcoded
	///     in Swift. Override for a locally-run API.
	public init(tokens: any MapleTokenProvider, baseURL: URL? = nil) throws {
		self.init(
			tokens: tokens,
			serverURL: try baseURL ?? Servers.Server1.url(),
			transport: URLSessionTransport(),
			organizationId: nil,
			coalescer: RequestCoalescer()
		)
	}

	/// Builds a client over a caller-supplied transport. For tests — it is what
	/// lets the request-count assertions run without a network.
	init(
		tokens: any MapleTokenProvider,
		serverURL: URL,
		transport: any ClientTransport,
		coalescer: RequestCoalescer = RequestCoalescer()
	) {
		self.init(
			tokens: tokens,
			serverURL: serverURL,
			transport: transport,
			organizationId: nil,
			coalescer: coalescer
		)
	}

	private init(
		tokens: any MapleTokenProvider,
		serverURL: URL,
		transport: any ClientTransport,
		organizationId: String?,
		coalescer: RequestCoalescer
	) {
		self.tokens = tokens
		self.serverURL = serverURL
		self.transport = transport
		self.coalescer = coalescer

		// Order matters, outermost first: auth runs outermost so the error
		// mapper sees the response to a request that actually carried a token,
		// and coalescing runs innermost so its key is computed over the finished
		// request — bearer token and organization header included — and so every
		// waiter still gets its own typed error from the mapper above it.
		var middlewares: [any ClientMiddleware] = [BearerAuthMiddleware(tokens: tokens)]
		if let organizationId {
			middlewares.append(OrganizationMiddleware(organizationId: organizationId))
		}
		middlewares.append(ErrorMappingMiddleware())
		middlewares.append(CoalescingMiddleware(coalescer: coalescer))

		self.client = Client(serverURL: serverURL, transport: transport, middlewares: middlewares)
	}

	/// The transport is shared rather than rebuilt, so scoping to three
	/// organizations does not mean three `URLSession`s and three connection
	/// pools.
	///
	/// A scoped call must never invalidate the token: it does not depend on the
	/// active-organization claim, so a background fetch for one organization
	/// must not perturb the token the foreground is using for another.
	public func scoped(to organizationId: String) -> any MapleAPI {
		MapleClient(
			tokens: tokens,
			serverURL: serverURL,
			transport: transport,
			organizationId: organizationId,
			coalescer: coalescer
		)
	}

	public func services(window: ResolvedTimeWindow, limit: Int = 50) async throws -> Page<Service> {
		try await mapping {
			let output = try await client.listServices(
				.init(
					query: .init(
						startTime: window.startTime,
						endTime: window.endTime,
						limit: String(limit)
					)
				)
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func service(named name: String, window: ResolvedTimeWindow) async throws -> Service {
		try await mapping {
			let output = try await client.getService(
				.init(
					path: .init(name: name),
					query: .init(startTime: window.startTime, endTime: window.endTime)
				)
			)
			return try output.ok.body.json
		}
	}

	public func issues(
		query: IssueQuery = .init(),
		window: ResolvedTimeWindow? = nil,
		limit: Int = 20,
		cursor: String? = nil
	) async throws -> Page<ErrorIssue> {
		try await mapping {
			let output = try await client.listErrorIssues(
				.init(
					query: .init(
						limit: String(limit),
						cursor: cursor,
						workflowState: query.workflowState,
						severity: query.severity,
						kind: query.kind,
						serviceName: query.serviceName,
						startTime: window?.startTime,
						endTime: window?.endTime,
						// The contract accepts the literal string "true" only —
						// sending "false" is a schema error, so omit instead.
						actionable: query.actionableOnly ? ._true : nil,
						sort: .init(rawValue: query.sort.rawValue)
					)
				)
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func issue(id: String) async throws -> ErrorIssueDetail {
		try await mapping {
			let output = try await client.getErrorIssue(.init(path: .init(id: id)))
			return try output.ok.body.json
		}
	}

	public func issueCountsByService() async throws -> [ErrorIssueServiceCount] {
		try await mapping {
			let output = try await client.listErrorIssueServiceCounts(.init())
			return try output.ok.body.json.data
		}
	}

	/// Normalizes whatever escapes the generated client into `MapleAPIError`.
	///
	/// `ErrorMappingMiddleware` already converts non-2xx responses, so what
	/// reaches here is a transport failure or a 2xx body that failed to decode.
	func mapping<T>(_ work: () async throws -> T) async throws -> T {
		do {
			return try await work()
		} catch {
			throw Self.normalize(error)
		}
	}

	/// The one place a raw error becomes either `MapleAPIError` or
	/// `CancellationError`. Static so it is testable without a token provider.
	///
	/// OpenAPIRuntime wraps everything the transport throws in a `ClientError`,
	/// including the `CancellationError` / `URLError(.cancelled)` that a
	/// cancelled Task produces. Mapping that to `.transport` reported every
	/// superseded request — a tab switch, an org switch, a pull-to-refresh
	/// interrupted by navigation — as "Can't reach Maple", so cancellation is
	/// unwrapped first and rethrown as the plain `CancellationError` that
	/// callers already look for.
	static func normalize(_ error: any Error) -> any Error {
		if isCancellation(error) { return CancellationError() }
		switch error {
		case let error as MapleAPIError:
			return error
		case let error as ClientError:
			if let underlying = error.underlyingError as? MapleAPIError { return underlying }
			return MapleAPIError.transport(error)
		default:
			return MapleAPIError.decoding(error)
		}
	}

	static func isCancellation(_ error: any Error) -> Bool {
		switch error {
		case is CancellationError:
			return true
		case let error as URLError:
			return error.code == .cancelled
		case let error as ClientError:
			return isCancellation(error.underlyingError)
		case let error as MapleAPIError:
			if case .transport(let underlying) = error { return isCancellation(underlying) }
			return false
		default:
			return false
		}
	}
}

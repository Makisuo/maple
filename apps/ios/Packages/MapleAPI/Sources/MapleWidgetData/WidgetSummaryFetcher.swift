import Foundation

/// The widget extension's own client for `GET /v2/widget_summary`.
///
/// Hand-written, and deliberately so. The extension does not link `MapleAPI`:
/// that is 30k lines of generated code plus `OpenAPIRuntime`, inside a process
/// the system gives roughly 30MB and a few seconds of wall clock. One endpoint
/// it can decode by hand is the only shape that fits — which is also why the
/// endpoint exists at all.
///
/// Everything here is written so that **failing changes nothing**. A widget
/// never shows an error; it shows the last snapshot it has, with an honest age.
/// So the fetch is an enrichment of a timeline that was already going to be
/// built, never a precondition for building one.
public actor WidgetSummaryFetcher {
	/// Shared per process. WidgetKit builds each pinned instance's timeline
	/// separately — issues-small, issues-medium and throughput can all be woken
	/// for the same organization at once — and without one place to coalesce
	/// them that is three identical requests for one answer.
	public static let shared = WidgetSummaryFetcher()

	/// The provider's whole budget, not just the request's.
	///
	/// The system kills a slow timeline provider, and a killed provider costs a
	/// rebuild from a metered budget having rendered nothing. Five seconds is
	/// enough for a small payload on a bad connection and short enough to leave
	/// room to fall back and still return a timeline.
	public static let deadline: TimeInterval = 5

	/// Below this age, the stored snapshot is used as-is.
	///
	/// The app publishes on every foreground, so without a floor a widget woken
	/// moments later would re-fetch what it already has.
	public static let freshnessFloor: TimeInterval = 2 * 60

	/// How long an in-flight attempt suppresses another one.
	///
	/// The in-process coalescing below covers three providers in one extension;
	/// this covers the app and the extension racing, which are different
	/// processes and share nothing but the App Group.
	public static let attemptLock: TimeInterval = 60

	private let credentials: WidgetCredentialStore
	private let fetchStates: WidgetFetchStateStore
	private let session: URLSession
	private var inFlight: [String: Task<WidgetSummaryPayload?, Never>] = [:]

	public init(
		credentials: WidgetCredentialStore = WidgetCredentialStore(),
		fetchStates: WidgetFetchStateStore = WidgetFetchStateStore(),
		session: URLSession? = nil
	) {
		self.credentials = credentials
		self.fetchStates = fetchStates
		if let session {
			self.session = session
		} else {
			let configuration = URLSessionConfiguration.ephemeral
			configuration.timeoutIntervalForRequest = WidgetSummaryFetcher.deadline
			configuration.timeoutIntervalForResource = WidgetSummaryFetcher.deadline
			// A provider that waits for connectivity is a provider that gets
			// killed. Offline is an answer here, and a fast one.
			configuration.waitsForConnectivity = false
			self.session = URLSession(configuration: configuration)
		}
	}

	/// Why a fetch was skipped, or that one ran. Returned so a caller can put it
	/// on a timeline policy without re-deriving it.
	public enum Attempt: Sendable, Equatable {
		/// The stored snapshot is younger than `freshnessFloor`.
		case fresh
		/// No credential yet: the app has not run, or has not covered this
		/// organization.
		case noCredential
		/// The credential has expired, or the server rejected it. Only the app
		/// can fix either.
		case needsApp
		/// Another provider — or the app — is already on it.
		case coalesced
		case fetched(WidgetSummaryPayload)
		case failed
	}

	/// Fetch this organization's summary, unless there is a reason not to.
	///
	/// Writes a successful payload's snapshots into the App Group **before**
	/// returning, so a provider killed on the way to rendering still leaves the
	/// data behind for the next rebuild.
	public func fetch(
		organizationId: String,
		organizationName: String?,
		storedGeneratedAt: Date?,
		now: Date = Date()
	) async -> Attempt {
		if let storedGeneratedAt, now.timeIntervalSince(storedGeneratedAt) < Self.freshnessFloor {
			return .fresh
		}

		let state = fetchStates.load(organizationId: organizationId)
		// A rolled credential answers 401 forever. Retrying on every rebuild
		// would spend the entire refresh budget on failures and leave the widget
		// no fresher than not trying at all.
		if state.isCredentialRejected { return .needsApp }
		// The app and the extension are different processes and share nothing but
		// the App Group, so this is the only thing standing between them when a
		// foreground and a timeline rebuild land in the same second.
		if state.isInFlight(at: now, within: Self.attemptLock) { return .coalesced }

		guard let credential = credentials.load(organizationId: organizationId) else {
			return .noCredential
		}
		// Expiry is checked here rather than left to the 401: a credential the
		// app has simply not renewed yet is not a rejected one, and spending a
		// request to be told so helps nobody.
		if credential.isExpired(at: now) { return .needsApp }

		if let existing = inFlight[organizationId] {
			return await existing.value.map(Attempt.fetched) ?? .coalesced
		}

		// Stamped before the request goes out, so a second process starting in
		// the same second sees an attempt in progress rather than none.
		fetchStates.save(state.attempting(at: now), organizationId: organizationId)

		let task = Task<WidgetSummaryPayload?, Never> { [credentials, fetchStates, session] in
			let outcome = await Self.request(credential: credential, session: session)
			switch outcome {
			case .success(let payload):
				// The organization the credential is bound to is the one the
				// server answers for. A disagreement would write one
				// organization's numbers under another's name — invisible until
				// someone reads the wrong figure off their Home Screen.
				guard payload.organizationId == organizationId, payload.isSupported else {
					fetchStates.save(
						fetchStates.load(organizationId: organizationId)
							.recording(.undecodable, at: Date()),
						organizationId: organizationId
					)
					return nil
				}
				// Saved before the caller gets it back: a provider killed between
				// here and rendering still leaves the data for the next rebuild.
				WidgetSnapshotStore<IssuesSnapshot>
					.issues(organizationId: organizationId)
					.save(payload.issuesSnapshot(organizationName: organizationName))
				WidgetSnapshotStore<ThroughputSnapshot>
					.throughput(organizationId: organizationId)
					.save(payload.throughputSnapshot())
				fetchStates.save(
					fetchStates.load(organizationId: organizationId).recording(.success, at: Date()),
					organizationId: organizationId
				)
				_ = credentials
				return payload
			case .failure(let reason):
				fetchStates.save(
					fetchStates.load(organizationId: organizationId).recording(reason, at: Date()),
					organizationId: organizationId
				)
				return nil
			}
		}
		inFlight[organizationId] = task
		let payload = await task.value
		inFlight[organizationId] = nil
		return payload.map(Attempt.fetched) ?? .failed
	}

	private enum RequestOutcome {
		case success(WidgetSummaryPayload)
		case failure(WidgetFetchState.Outcome)
	}

	private static func request(
		credential: WidgetCredential,
		session: URLSession
	) async -> RequestOutcome {
		var request = URLRequest(
			url: credential.apiBaseURL.appendingPathComponent("v2/widget_summary"),
			timeoutInterval: deadline
		)
		request.httpMethod = "GET"
		request.setValue("Bearer \(credential.secret)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		// Deliberately no `x-maple-org-id`. An API key is already bound to one
		// organization and the server rejects a header that disagrees, so the
		// only way to get this wrong is to send it.

		do {
			let (data, response) = try await session.data(for: request)
			guard let http = response as? HTTPURLResponse else { return .failure(.server) }
			switch http.statusCode {
			case 200:
				// `WidgetJSON.decoder`, never a plain `.iso8601` one: the API sends
				// timestamps with milliseconds and `.iso8601` rejects those on the
				// deployment target. See WidgetJSON.
				guard let payload = try? WidgetJSON.decoder.decode(WidgetSummaryPayload.self, from: data)
				else {
					return .failure(.undecodable)
				}
				return .success(payload)
			// 403 belongs here too: a credential whose scopes no longer reach
			// this endpoint is as dead as one that was revoked, and the app is
			// the only thing that can mint a working replacement.
			case 401, 403:
				return .failure(.unauthorized)
			default:
				return .failure(.server)
			}
		} catch {
			// Offline, DNS, TLS, or the deadline. All the same to a widget: try
			// again sooner than a server error, and render what it has meanwhile.
			return .failure(.unreachable)
		}
	}
}

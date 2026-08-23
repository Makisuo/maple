import Foundation

/// Every `maple://` destination, as one value that can be built and parsed.
///
/// Building used to live in `WidgetKinds` and parsing in `AppNavigation`, in the
/// app target — which has no test bundle, so the two halves could drift with
/// nothing to catch it. They are one type here, in the module the app, the
/// widget extension and the Live Activity all link, and `swift test` covers the
/// round trip.
///
/// **The organization travels as a query item, never as a path segment.** Every
/// notification already sitting in Notification Center and every activity
/// already on a Lock Screen was built without one, and an absent `org` still
/// means exactly what it has always meant: whichever organization is active.
/// A path form (`maple://org/<id>/incident/<id>`) would have made all of those
/// unparseable.
public struct WidgetDeepLink: Hashable, Sendable {
	public enum Target: Hashable, Sendable {
		case incident(id: String)
		case issue(id: String)
		case service(name: String)
		case incidentsList
		case issuesList
		case servicesList
	}

	public var target: Target
	/// The organization the destination belongs to, or nil for "the active one".
	///
	/// Nil is not a missing value to be filled in later — it is the pre-multi-org
	/// meaning, and `DestinationResolver` deliberately never switches organization
	/// for it.
	public var organizationId: String?

	public init(target: Target, organizationId: String? = nil) {
		self.target = target
		self.organizationId = organizationId
	}

	public static let scheme = "maple"
	/// The query item carrying the organization. Short because it is user-visible
	/// in a copied link.
	public static let organizationQueryItem = "org"

	/// Parses a `maple://` URL, or nil for anything else.
	///
	/// Anything unrecognised is nil rather than a guess: a URL this app does not
	/// know landing the user on an arbitrary tab is worse than it doing nothing,
	/// and the scheme is ours alone.
	public init?(url: URL) {
		guard url.scheme == Self.scheme else { return nil }
		guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

		// The first real path component. `pathComponents` includes "/" for an
		// absolute path, and a host-only URL has none at all.
		let identifier = components.percentEncodedPath
			.split(separator: "/")
			.first
			.map(String.init)?
			.removingPercentEncoding

		// A host that takes an identifier falls back to its list when the
		// identifier is missing — a widget row whose issue disappeared should still
		// open the Errors list rather than do nothing.
		func resolve(_ make: (String) -> Target, orElse fallback: Target) -> Target {
			guard let identifier, !identifier.isEmpty else { return fallback }
			return make(identifier)
		}

		let target: Target
		switch components.host {
		case "incident":
			target = resolve({ .incident(id: $0) }, orElse: .incidentsList)
		case "incidents":
			target = .incidentsList
		case "issue":
			target = resolve({ .issue(id: $0) }, orElse: .issuesList)
		case "issues":
			target = .issuesList
		case "service":
			target = resolve({ .service(name: $0) }, orElse: .servicesList)
		case "services":
			target = .servicesList
		default:
			return nil
		}

		self.target = target
		let organizationId = components.queryItems?
			.first { $0.name == Self.organizationQueryItem }?
			.value
		self.organizationId = organizationId.flatMap { $0.isEmpty ? nil : $0 }
	}

	/// The URL form. Built with `URLComponents` rather than interpolation:
	/// service names carry characters — spaces, `/`, `#`, `?` — that have to be
	/// encoded differently in a path than in a query, and hand-rolling that once
	/// a query item exists is how a link silently stops resolving.
	public var url: URL? {
		var components = URLComponents()
		components.scheme = Self.scheme

		switch target {
		case .incident(let id):
			components.host = "incident"
			guard let path = Self.encodedSegment(id) else { return nil }
			components.percentEncodedPath = path
		case .issue(let id):
			components.host = "issue"
			guard let path = Self.encodedSegment(id) else { return nil }
			components.percentEncodedPath = path
		case .service(let name):
			components.host = "service"
			guard let path = Self.encodedSegment(name) else { return nil }
			components.percentEncodedPath = path
		case .incidentsList:
			components.host = "incidents"
		case .issuesList:
			components.host = "issues"
		case .servicesList:
			components.host = "services"
		}

		if let organizationId, !organizationId.isEmpty {
			components.queryItems = [URLQueryItem(name: Self.organizationQueryItem, value: organizationId)]
		}
		return components.url
	}

	/// One path segment, with `/` encoded rather than treated as a separator.
	///
	/// `.urlPathAllowed` permits `/`, so a service named `orders/v2` built through
	/// it produces a two-segment path that parses back as `orders` — the kind of
	/// break that only shows up for the one customer who names services that way.
	private static func encodedSegment(_ value: String) -> String? {
		var allowed = CharacterSet.urlPathAllowed
		allowed.remove(charactersIn: "/")
		return value.addingPercentEncoding(withAllowedCharacters: allowed).map { "/\($0)" }
	}
}

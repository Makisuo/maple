import Foundation
import Testing

@testable import MapleWidgetData

@Suite("WidgetDeepLink")
struct WidgetDeepLinkTests {
	private func roundTrip(_ link: WidgetDeepLink) -> WidgetDeepLink? {
		link.url.flatMap(WidgetDeepLink.init(url:))
	}

	@Test("every target survives build → parse")
	func roundTripsEveryTarget() {
		let targets: [WidgetDeepLink.Target] = [
			.incident(id: "inc_YofPTrK9782DWwcnXhpcCw"),
			.issue(id: "iss_123"),
			.service(name: "checkout-api"),
			.incidentsList,
			.issuesList,
			.servicesList,
		]
		for target in targets {
			let link = WidgetDeepLink(target: target, organizationId: "org_2abc")
			#expect(roundTrip(link) == link, "\(target) did not survive the round trip")
		}
	}

	@Test("an absent org stays absent — the pre-multi-org meaning")
	func absentOrganizationStaysNil() throws {
		let url = try #require(URL(string: "maple://incident/inc_1"))
		let link = try #require(WidgetDeepLink(url: url))
		#expect(link.organizationId == nil)
		#expect(link.target == .incident(id: "inc_1"))
	}

	@Test("an empty org query item reads as absent, not as an org named \"\"")
	func emptyOrganizationReadsAsNil() throws {
		let url = try #require(URL(string: "maple://incident/inc_1?org="))
		#expect(WidgetDeepLink(url: url)?.organizationId == nil)
	}

	/// Service names are user-authored and reach the URL verbatim.
	@Test(
		"awkward service names survive",
		arguments: ["orders/v2", "checkout?live", "api#edge", "billing service", "café-api", "a&b=c"]
	)
	func awkwardServiceNames(name: String) {
		let link = WidgetDeepLink(target: .service(name: name), organizationId: "org_2abc")
		#expect(roundTrip(link) == link)
	}

	@Test("the URL shape is pinned")
	func urlShapeIsPinned() {
		#expect(
			WidgetDeepLink(target: .incident(id: "inc_1"), organizationId: "org_2abc").url?.absoluteString
				== "maple://incident/inc_1?org=org_2abc"
		)
		#expect(
			WidgetDeepLink(target: .issuesList).url?.absoluteString == "maple://issues"
		)
	}

	@Test("an id-less host falls back to its list rather than to nothing")
	func missingIdentifierFallsBackToList() throws {
		let url = try #require(URL(string: "maple://issue?org=org_2abc"))
		let link = try #require(WidgetDeepLink(url: url))
		#expect(link.target == .issuesList)
		#expect(link.organizationId == "org_2abc")
	}

	@Test("unknown hosts and foreign schemes are refused, not guessed at")
	func refusesUnknownURLs() throws {
		#expect(WidgetDeepLink(url: try #require(URL(string: "maple://dashboard/1"))) == nil)
		#expect(WidgetDeepLink(url: try #require(URL(string: "https://maple.dev/issues"))) == nil)
		#expect(WidgetDeepLink(url: try #require(URL(string: "mapleX://issues"))) == nil)
	}

	@Test("WidgetKinds builds the same links")
	func widgetKindsAgree() {
		#expect(
			IssuesWidgetKind.issueURL(id: "iss_1", organizationId: "org_2abc")?.absoluteString
				== "maple://issue/iss_1?org=org_2abc"
		)
		#expect(
			ThroughputWidgetKind.serviceURL(name: nil, organizationId: "org_2abc")?.absoluteString
				== "maple://services?org=org_2abc"
		)
	}
}

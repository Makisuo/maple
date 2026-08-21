import Foundation
import Testing

@testable import MapleWidgetData

/// These assert the *wire shape*, not Swift behaviour. ActivityKit decodes the
/// server's `attributes` / `content-state` dictionaries with a plain
/// `JSONDecoder` and, on failure, does nothing at all — no activity, no log. So
/// the contract with `MobilePushService.renderLiveActivity*` is pinned here,
/// where a mismatch is a red test rather than a Lock Screen that stays empty.
@Suite("Incident Live Activity attributes")
struct IncidentActivityAttributesTests {
	private func object(_ json: String) throws -> [String: Any] {
		try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
	}

	@Test("Decodes the attributes the server sends")
	func decodesAttributes() throws {
		let json = """
			{
			  "incident_id": "inc_YofPTrK9782DWwcnXhpcCw",
			  "rule_name": "Checkout error rate",
			  "service": "checkout-api",
			  "signal_label": "Error Rate",
			  "started_at": 1800000000
			}
			"""
		let decoded = try JSONDecoder().decode(IncidentActivityAttributes.self, from: Data(json.utf8))
		#expect(decoded.incidentId == "inc_YofPTrK9782DWwcnXhpcCw")
		#expect(decoded.ruleName == "Checkout error rate")
		#expect(decoded.service == "checkout-api")
		#expect(decoded.signalLabel == "Error Rate")
		// Epoch seconds, not Apple's 2001 reference date.
		#expect(decoded.startedAt == Date(timeIntervalSince1970: 1_800_000_000))
	}

	@Test("An org-wide rule sends no service")
	func decodesNullService() throws {
		let json = """
			{
			  "incident_id": "inc_1",
			  "rule_name": "Latency",
			  "service": null,
			  "signal_label": "p95 Latency",
			  "started_at": 1800000000
			}
			"""
		let decoded = try JSONDecoder().decode(IncidentActivityAttributes.self, from: Data(json.utf8))
		#expect(decoded.service == nil)
	}

	@Test("Decodes both content states")
	func decodesContentState() throws {
		let firing = """
			{"value": "9.1%", "threshold": "> 5%", "status": "firing", "updated_at": 1800000060}
			"""
		let state = try JSONDecoder().decode(
			IncidentActivityAttributes.ContentState.self,
			from: Data(firing.utf8)
		)
		#expect(state.value == "9.1%")
		#expect(state.threshold == "> 5%")
		#expect(state.status == .firing)
		#expect(state.updatedAt == Date(timeIntervalSince1970: 1_800_000_060))

		let resolved = """
			{"value": "1.2%", "threshold": "> 5%", "status": "resolved", "updated_at": 1800000060}
			"""
		let end = try JSONDecoder().decode(
			IncidentActivityAttributes.ContentState.self,
			from: Data(resolved.utf8)
		)
		#expect(end.status == .resolved)
	}

	@Test("Reads the chart series and its threshold")
	func decodesSeries() throws {
		let json = """
			{
			  "value": "9.1%", "threshold": "> 5%", "status": "firing", "updated_at": 1800000060,
			  "series": [0.021, 0.048, 0.091], "threshold_value": 0.05
			}
			"""
		let state = try JSONDecoder().decode(
			IncidentActivityAttributes.ContentState.self,
			from: Data(json.utf8)
		)
		#expect(state.series == [0.021, 0.048, 0.091])
		#expect(state.thresholdValue == 0.05)
	}

	@Test("A state without a chart still decodes")
	func decodesWithoutSeries() throws {
		// The chart is additive. If a server that predates it — or one that could
		// not read the checks — omits these keys, the activity must still start:
		// a throw here is a Lock Screen that stays empty, with nothing logged.
		let json = """
			{"value": "9.1%", "threshold": "> 5%", "status": "firing", "updated_at": 1800000060}
			"""
		let state = try JSONDecoder().decode(
			IncidentActivityAttributes.ContentState.self,
			from: Data(json.utf8)
		)
		#expect(state.series.isEmpty)
		#expect(state.thresholdValue == nil)
	}

	@Test("Encodes back to the same keys")
	func encodesSnakeCase() throws {
		let encoded = try JSONEncoder().encode(IncidentActivityAttributes.sample)
		let json = try object(String(decoding: encoded, as: UTF8.self))
		#expect(
			Set(json.keys)
				== ["incident_id", "rule_name", "service", "signal_label", "started_at", "organization_id"]
		)
		#expect(json["started_at"] is NSNumber)

		let state = try JSONEncoder().encode(IncidentActivityAttributes.ContentState.sample)
		let stateJson = try object(String(decoding: state, as: UTF8.self))
		#expect(
			Set(stateJson.keys) == ["value", "threshold", "status", "updated_at", "series", "threshold_value"]
		)
	}

	@Test("A tap opens the incident, in its own organization")
	func deepLink() {
		#expect(
			IncidentActivityAttributes.sample.deepLinkURL?.absoluteString
				== "maple://incident/inc_YofPTrK9782DWwcnXhpcCw?org=org_sample"
		)
	}

	@Test("Decodes the organization when the server sends it")
	func decodesOrganization() throws {
		let json = """
			{
			  "incident_id": "inc_1",
			  "rule_name": "Latency",
			  "signal_label": "p95 Latency",
			  "started_at": 1800000000,
			  "organization_id": "org_2abc"
			}
			"""
		let decoded = try JSONDecoder().decode(IncidentActivityAttributes.self, from: Data(json.utf8))
		#expect(decoded.organizationId == "org_2abc")
		#expect(decoded.deepLinkURL?.absoluteString == "maple://incident/inc_1?org=org_2abc")
	}

	/// The case that must never regress: an activity started before the
	/// organization id existed, or by a server that has not deployed it yet.
	/// Attributes are the static half of an activity — a required field here
	/// would make iOS drop the start push in silence.
	@Test("Decodes attributes with no organization at all, and links without one")
	func decodesWithoutOrganization() throws {
		let json = """
			{
			  "incident_id": "inc_1",
			  "rule_name": "Latency",
			  "signal_label": "p95 Latency",
			  "started_at": 1800000000
			}
			"""
		let decoded = try JSONDecoder().decode(IncidentActivityAttributes.self, from: Data(json.utf8))
		#expect(decoded.organizationId == nil)
		#expect(decoded.deepLinkURL?.absoluteString == "maple://incident/inc_1")
	}
}

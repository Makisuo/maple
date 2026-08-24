import Foundation
import MapleWidgetData

/// The Home Screen widgets' one read.
///
/// This used to be four calls composed on the device — `listServices`, two
/// `queryTraceTimeseries`, and `listErrorIssues` — which is four round-trips to
/// land inside whatever seconds of background time iOS granted. It is now one,
/// and the shape it returns (`WidgetSummaryPayload`, in `MapleWidgetData`) is
/// the same one the widget extension decodes for itself, so the app and the
/// Home Screen cannot drift apart about what a row says.
extension MapleClient {
	/// Filtered to the client's environment scope, if it has one. The server
	/// echoes the filter it applied, and `payload(from:)` carries that echo —
	/// not the value asked for — into the snapshot, so a server that ignored
	/// the parameter cannot be mistaken for one that honoured it.
	public func widgetSummary() async throws -> WidgetSummaryPayload {
		try await mapping {
			let output = try await client.getWidgetSummary(
				.init(query: .init(deploymentEnvironment: environment))
			)
			return try Self.payload(from: output.ok.body.json)
		}
	}

	/// Generated wire type → the shared shape.
	///
	/// Mechanical, with one judgement call: a timestamp that will not parse.
	/// `generated_at` is the age every widget renders from, so a payload whose
	/// own timestamp is unreadable is rejected outright — rendering it would
	/// mean claiming an age that is not the data's. A single issue's
	/// `last_seen_at` is different: `.distantPast` keeps the row visible and
	/// sorts it last, which is the failure that loses least.
	static func payload(
		from summary: Components.Schemas.WidgetSummary
	) throws -> WidgetSummaryPayload {
		guard let generatedAt = ResolvedTimeWindow.parse(summary.generatedAt) else {
			throw MapleAPIError.decoding(WidgetSummaryDecodingError.unreadableGeneratedAt)
		}
		return WidgetSummaryPayload(
			schemaVersion: Int(summary.schemaVersion),
			generatedAt: generatedAt,
			organizationId: summary.organizationId,
			deploymentEnvironment: summary.deploymentEnvironment,
			issues: WidgetSummaryPayload.Issues(
				windowSeconds: Int(summary.issues.windowSeconds),
				hasMore: summary.issues.hasMore,
				data: summary.issues.data.map { issue in
					WidgetSummaryPayload.Issue(
						id: issue.id,
						exceptionType: issue.exceptionType,
						errorLabel: issue.errorLabel,
						exceptionMessage: issue.exceptionMessage,
						serviceName: issue.serviceName,
						severity: issue.severity?.rawValue,
						occurrenceCount: issue.occurrenceCount,
						lastSeenAt: ResolvedTimeWindow.parse(issue.lastSeenAt) ?? .distantPast,
						isRegressed: issue.isRegressed,
						hasOpenIncident: issue.hasOpenIncident
					)
				}
			),
			throughput: WidgetSummaryPayload.Throughput(
				windowSeconds: Int(summary.throughput.windowSeconds),
				bucketSeconds: summary.throughput.bucketSeconds.map(Int.init),
				services: summary.throughput.services.map { service in
					WidgetSummaryPayload.Service(
						name: service.name,
						throughputPerSecond: service.throughputPerSecond,
						errorRate: service.errorRate,
						p95LatencyMs: service.p95LatencyMs,
						points: service.points
					)
				},
				totalPoints: summary.throughput.totalPoints
			)
		)
	}
}

/// The credential the widget extension fetches with.
///
/// Minted by the app because only the app holds a session, and used by the
/// extension because only the extension is awake when WidgetKit rebuilds a
/// timeline. Everything that bounds it — the scopes, the TTL, the roles — is
/// chosen by the server, so there is nothing to get wrong here beyond calling
/// it at the right times.
///
/// Keyed on the **installation**, not the push token: a user who declines
/// notifications has no APNs token and still pins widgets, and hanging the
/// credential off push would have quietly meant "no widget refresh unless you
/// also accept alerts".
extension MapleClient {
	/// Mint or roll this device's credential for the client's organization.
	///
	/// Idempotent per installation: the server revokes whatever it had in the
	/// same transaction, so a roll cannot leave a live key behind on a phone.
	public func mintWidgetCredential(installationId: String) async throws -> WidgetCredential {
		try await mapping {
			let output = try await client.mintWidgetCredential(
				.init(path: .init(installationId: installationId))
			)
			let credential = try output.ok.body.json
			guard
				let expiresAt = ResolvedTimeWindow.parse(credential.expiresAt),
				let mintedAt = ResolvedTimeWindow.parse(credential.createdAt)
			else {
				// Without a readable expiry there is no way to know when to renew,
				// and a credential nobody renews is a Home Screen that goes quiet
				// with no signal. Better to have none and mint again.
				throw MapleAPIError.decoding(WidgetSummaryDecodingError.unreadableCredentialDates)
			}
			return WidgetCredential(
				organizationId: credential.organizationId,
				secret: credential.secret,
				// The host this client is pointed at, carried with the credential
				// it just issued. A credential minted against a local API is
				// worthless to production and vice versa; storing them apart makes
				// that mismatch look like an expiry to the widget.
				apiBaseURL: serverURL,
				expiresAt: expiresAt,
				mintedAt: mintedAt
			)
		}
	}

	/// Sign-out, leaving an organization, or unpinning the last widget.
	public func revokeWidgetCredential(installationId: String) async throws {
		try await mapping {
			_ = try await client.revokeWidgetCredential(
				.init(path: .init(installationId: installationId))
			).ok
		}
	}
}

public enum WidgetSummaryDecodingError: Error, Sendable {
	/// The payload's own `generated_at` did not parse, so nothing in it can be
	/// aged honestly.
	case unreadableGeneratedAt
	/// A minted credential arrived without a readable expiry, so nothing could
	/// decide when to renew it.
	case unreadableCredentialDates
}

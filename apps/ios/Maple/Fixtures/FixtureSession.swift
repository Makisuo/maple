import Foundation

enum FixtureSession {
	static let organizationId = "org_fixture"

	/// A syntactically valid Clerk publishable key whose frontend API host does
	/// not exist. `Clerk.configure` decodes the host from the base64 tail, so
	/// the SDK initialises and then simply fails to reach anything — which is
	/// what fixture mode wants.
	static let publishableKey: String = {
		let host = Data("fixtures.clerk.invalid$".utf8).base64EncodedString()
		return "pk_test_\(host)"
	}()
}

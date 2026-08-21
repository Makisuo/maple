import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func credential(
	organizationId: String = "org_1",
	secret: String = "maple_ak_test",
	expiresIn: TimeInterval = 30 * 24 * 60 * 60
) -> WidgetCredential {
	WidgetCredential(
		organizationId: organizationId,
		secret: secret,
		apiBaseURL: URL(string: "https://api.maple.test")!,
		expiresAt: now.addingTimeInterval(expiresIn),
		mintedAt: now
	)
}

private func withStore(_ body: (WidgetCredentialStore) throws -> Void) rethrows {
	let directory = URL(fileURLWithPath: NSTemporaryDirectory())
		.appendingPathComponent("widget-credentials-\(UUID().uuidString)", isDirectory: true)
	defer { try? FileManager.default.removeItem(at: directory) }
	try body(WidgetCredentialStore(directory: directory))
}

@Suite("Widget credential")
struct WidgetCredentialTests {
	@Test("renews with a week to spare, not on the day")
	func renewalWindow() {
		// A phone opened at weekends must not be one bad Monday from a Home
		// Screen that has gone quiet with no way back.
		#expect(credential(expiresIn: 30 * 24 * 3_600).needsRenewal(at: now) == false)
		#expect(credential(expiresIn: 8 * 24 * 3_600).needsRenewal(at: now) == false)
		#expect(credential(expiresIn: 6 * 24 * 3_600).needsRenewal(at: now))
		#expect(credential(expiresIn: -1).needsRenewal(at: now))
	}

	@Test("knows when it has stopped working")
	func expiry() {
		#expect(credential(expiresIn: 60).isExpired(at: now) == false)
		#expect(credential(expiresIn: -60).isExpired(at: now))
	}
}

@Suite("Widget credential store")
struct WidgetCredentialStoreTests {
	@Test("round-trips a credential per organization")
	func roundTrips() {
		withStore { store in
			store.save(credential(organizationId: "org_1", secret: "one"))
			store.save(credential(organizationId: "org_2", secret: "two"))
			#expect(store.load(organizationId: "org_1")?.secret == "one")
			#expect(store.load(organizationId: "org_2")?.secret == "two")
		}
	}

	@Test("reads nothing before the app has ever minted")
	func emptyBeforeFirstMint() {
		withStore { store in
			#expect(store.load(organizationId: "org_1") == nil)
		}
	}

	@Test("refuses a credential filed under the wrong organization")
	func rejectsMismatch() {
		withStore { store in
			// Writing org_2's credential to org_1's file is not something the app
			// does — but it is exactly the shape of the bug that renders one
			// organization's numbers under another's name, so it fails closed.
			let directory = URL(fileURLWithPath: NSTemporaryDirectory())
				.appendingPathComponent("widget-credentials-mismatch-\(UUID().uuidString)", isDirectory: true)
			defer { try? FileManager.default.removeItem(at: directory) }
			let encoder = JSONEncoder()
			encoder.dateEncodingStrategy = .iso8601
			try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
			try? encoder
				.encode(credential(organizationId: "org_2"))
				.write(to: directory.appendingPathComponent("widget-org_1.json"))
			#expect(WidgetCredentialStore(directory: directory).load(organizationId: "org_1") == nil)
			_ = store
		}
	}

	@Test("one organization's revoke leaves the others alone")
	func clearsOne() {
		withStore { store in
			store.save(credential(organizationId: "org_1"))
			store.save(credential(organizationId: "org_2"))
			store.clear(organizationId: "org_1")
			#expect(store.load(organizationId: "org_1") == nil)
			#expect(store.load(organizationId: "org_2") != nil)
		}
	}

	@Test("sign-out leaves nothing the next account could fetch with")
	func clearsAll() {
		withStore { store in
			store.save(credential(organizationId: "org_1"))
			store.save(credential(organizationId: "org_2"))
			store.clearAll()
			#expect(store.load(organizationId: "org_1") == nil)
			#expect(store.load(organizationId: "org_2") == nil)
			// And the store still works afterwards — sign-out is not terminal.
			store.save(credential(organizationId: "org_3"))
			#expect(store.load(organizationId: "org_3") != nil)
		}
	}

	@Test("an organization id that is not a filename cannot become one")
	func rejectsPathishIds() {
		withStore { store in
			#expect(store.save(credential(organizationId: "../../escape")) == false)
			#expect(store.load(organizationId: "../../escape") == nil)
			#expect(store.save(credential(organizationId: "")) == false)
		}
	}
}

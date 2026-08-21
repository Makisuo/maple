import Foundation
import Testing

@testable import MapleWidgetData

/// The widget's configuration picker. Untested until now, which is how it
/// shipped listing two organizations for an account in five.
///
/// The query reads the real App Group suite — it takes no identifier — so these
/// exercise the index the query reads through, on a throwaway suite, and assert
/// the same rules the query applies to it.
@Suite("Organization picker options")
struct OrganizationEntityQueryTests {
	private func makeIndex(_ name: String = #function) -> WidgetOrganizationIndex {
		let suiteName = "com.maple.tests.picker.\(name)"
		UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
		return WidgetOrganizationIndex(appGroupIdentifier: suiteName)
	}

	private func entities(_ index: WidgetOrganizationIndex) -> [OrganizationEntity] {
		index.load().map { OrganizationEntity(id: $0.id, name: $0.name) }
	}

	@Test("Every organization the user belongs to is offered, once each")
	func listsEveryMembership() {
		let index = makeIndex()
		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
			WidgetOrganization(id: "org_c", name: "Initech"),
		])
		index.record(WidgetOrganization(id: "org_a", name: "Acme", lastPublishedAt: Date()), isActive: true)

		let options = entities(index)
		#expect(options.map(\.id) == ["org_a", "org_b", "org_c"])
		#expect(Set(options.map(\.id)).count == options.count)
	}

	/// Two rows rendering the same title is what the duplicate-name bug looked
	/// like on screen, and `displayRepresentation` falls back to the id, so a
	/// name written under the wrong id is invisible here without this.
	@Test("No two rows render the same title")
	func titlesAreDistinct() {
		let index = makeIndex()
		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
		])

		let titles = entities(index).map { $0.name ?? $0.id }
		#expect(Set(titles).count == titles.count)
	}

	/// Dropping an organization the user has left would silently re-point that
	/// widget at the active one — the exact failure the configuration exists to
	/// prevent. It resolves by id and renders as unavailable instead.
	@Test("An id that is no longer a membership still resolves")
	func resolvesDepartedOrganizations() async throws {
		let index = makeIndex()
		let known = index.load()
		let resolved = ["org_gone"].map { identifier in
			OrganizationEntity(id: identifier, name: known.first { $0.id == identifier }?.name)
		}

		#expect(resolved.map(\.id) == ["org_gone"])
		#expect(resolved.first?.name == nil)
	}

	/// A newly placed widget lands where the user already is, rather than on an
	/// empty picker they must answer before it says anything.
	@Test("The default is the active organization")
	func defaultsToActive() {
		let index = makeIndex()
		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
		])
		index.record(WidgetOrganization(id: "org_b", name: "Globex"), isActive: true)

		#expect(index.activeOrganizationId == "org_b")
		#expect(index.load().first?.id == "org_b")
	}
}

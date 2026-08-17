import Foundation

/// Build-time configuration, injected via `Config/*.xcconfig` → Info.plist.
///
/// Nothing here is hardcoded in Swift: the Clerk publishable key comes from a
/// gitignored `Secrets.xcconfig`, and the API base URL defaults to the server
/// declared in the OpenAPI document.
enum AppConfig {
	/// The placeholder shipped in `Base.xcconfig`, so a checkout that never
	/// created `Secrets.xcconfig` fails with a useful message instead of a 401.
	private static let placeholderKey = "pk_test_replace_me"

	static let clerkPublishableKey: String = {
		let key = string(forKey: "MapleClerkPublishableKey") ?? ""
		guard !key.isEmpty, key != placeholderKey else {
			fatalError(
				"""
				Missing Clerk publishable key.

				Copy apps/ios/Config/Secrets.example.xcconfig to Secrets.xcconfig and set
				CLERK_PUBLISHABLE_KEY (the same value as VITE_CLERK_PUBLISHABLE_KEY in
				.env.local), then rebuild.
				"""
			)
		}
		return key
	}()

	/// Nil means "use the server declared in the OpenAPI document"
	/// (`https://api.maple.dev`), which is the normal case.
	static let apiBaseURL: URL? = {
		guard let value = string(forKey: "MapleAPIBaseURL"), !value.isEmpty else { return nil }

		// A hostless URL is almost always the xcconfig comment trap: `//` starts
		// a comment there, so `https://api.maple.dev` silently becomes `https:`.
		// URLSession then fails every request and the app reports "Can't reach
		// Maple", which sends you looking at the network instead of the config.
		guard let url = URL(string: value), url.host != nil else {
			fatalError(
				"""
				MAPLE_API_BASE_URL is not a usable URL: \(value)

				`//` starts a comment in xcconfig, so write the scheme separator with
				the escape: http:/$()/localhost:3472
				Or leave it empty to use the API declared in the OpenAPI document.
				"""
			)
		}
		return url
	}()

	private static func string(forKey key: String) -> String? {
		(Bundle.main.object(forInfoDictionaryKey: key) as? String)?
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}
}

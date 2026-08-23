// swift-tools-version:6.0
import PackageDescription

/// The Maple v2 API client, generated from `Sources/MapleAPI/openapi.json`.
///
/// The spec is produced by `bun run ios:openapi` at the repo root, which prunes
/// the 129-operation public contract to the handful the app calls and
/// normalizes Effect's union idioms. Generated Swift is a build product, not a
/// checked-in artifact — the plugin regenerates it on every clean build.
///
/// Everything here builds and tests with plain `swift test`: no simulator, no
/// code signing. That is deliberate — it is where the logic worth testing lives.
let package = Package(
	name: "MapleAPI",
	platforms: [.iOS(.v18), .macOS(.v15)],
	products: [
		.library(name: "MapleAPI", targets: ["MapleAPI"]),
		// What the Home Screen widget renders. Its own product because the
		// widget extension links it *without* MapleAPI: an extension has no
		// Clerk session and no business carrying a 30k-line generated client.
		.library(name: "MapleWidgetData", targets: ["MapleWidgetData"]),
	],
	dependencies: [
		.package(url: "https://github.com/apple/swift-openapi-generator", from: "1.10.0"),
		.package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.9.0"),
		.package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
	],
	targets: [
		.target(
			name: "MapleAPI",
			dependencies: [
				// One direction only. `MapleWidgetData` owns the shapes the Home
				// Screen renders and the mapping into them, so the app and the
				// widget extension cannot disagree about what a row says. The
				// reverse — the widget reaching for the generated client — is the
				// dependency this whole split exists to prevent.
				"MapleWidgetData",
				.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
				.product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
			],
			plugins: [
				.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
			]
		),
		// Zero dependencies, deliberately — see IssuesSnapshot.swift.
		.target(name: "MapleWidgetData"),
		.testTarget(name: "MapleAPITests", dependencies: ["MapleAPI"]),
		.testTarget(name: "MapleWidgetDataTests", dependencies: ["MapleWidgetData"]),
	]
)

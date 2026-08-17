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
		.library(name: "MapleAPI", targets: ["MapleAPI"])
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
				.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
				.product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
			],
			plugins: [
				.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
			]
		),
		.testTarget(name: "MapleAPITests", dependencies: ["MapleAPI"]),
	]
)

import Foundation

/// How this module reads and writes JSON, in one place.
///
/// It exists for the date strategy, and specifically for one trap.
/// `JSONDecoder.DateDecodingStrategy.iso8601` is backed by
/// `ISO8601DateFormatter` with its default options, which **reject fractional
/// seconds**. Maple's v2 API sends every timestamp as `toISOString()` output —
/// `2026-08-21T09:10:00.000Z`, milliseconds and all — so `.iso8601` fails to
/// decode every payload the widget fetches.
///
/// It does not fail everywhere, which is what makes it dangerous. The Swift
/// Foundation rewrite shipped in newer OS versions parses fractional seconds
/// happily, so this decodes fine on a current macOS and fails on iOS 18 — the
/// deployment target. It was caught by CI running macOS 15 against a laptop
/// running macOS 26, and would otherwise have shipped as "the widgets never
/// refresh on most phones", with no error anywhere: an undecodable payload is
/// indistinguishable from a fetch that failed.
///
/// So: parse both shapes explicitly, and keep writing the one without
/// fractional seconds. Sub-second precision means nothing to a surface whose
/// smallest unit is "1m ago".
enum WidgetJSON {
	static var encoder: JSONEncoder {
		let encoder = JSONEncoder()
		// ISO-8601 rather than seconds-since-reference-date: these are read by a
		// different process, possibly built from a different commit, and a dated
		// string survives inspection by eye.
		encoder.dateEncodingStrategy = .iso8601
		return encoder
	}

	static var decoder: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let text = try decoder.singleValueContainer().decode(String.self)
			guard let date = parse(text) else {
				throw DecodingError.dataCorrupted(
					DecodingError.Context(
						codingPath: decoder.codingPath,
						debugDescription: "Expected an ISO-8601 timestamp, got \(text)"
					)
				)
			}
			return date
		}
		return decoder
	}

	/// With fractional seconds first, because that is what the API sends.
	///
	/// Two formatters rather than one with both option sets: `ISO8601DateFormatter`
	/// treats `withFractionalSeconds` as *required*, not permitted, so a single
	/// formatter can read one shape or the other but never both.
	static func parse(_ text: String) -> Date? {
		(try? fractional.parse(text)) ?? (try? whole.parse(text))
	}

	private static let fractional = Date.ISO8601FormatStyle(
		includingFractionalSeconds: true,
		timeZone: .gmt
	)
	private static let whole = Date.ISO8601FormatStyle(
		includingFractionalSeconds: false,
		timeZone: .gmt
	)
}

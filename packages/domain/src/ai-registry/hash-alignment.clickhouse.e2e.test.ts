// `AiSessionKeyHash`: the same 64 bits in Rust and in ClickHouse.
//
// The construction is `cityHash64(value)` over the winning session-key value, and the
// Rust side implements it in `apps/ingest/src/cityhash102.rs` (CityHash **1.0.2**, the
// variant ClickHouse's `cityHash64` still ships). The variant is the load-bearing part:
// CityHash 1.1 differs on inputs ≤ 32 bytes and > 64 bytes, so a crate tracking upstream
// would return different numbers for the same bytes and silently desync Rust from SQL.
//
// The chain asserted here closes on the row: the Rust generator proves
// `classification.session_key_hash() == cityhash102::city_hash64(value)` and that the
// value equals `row.ai_session_key_hash`; `./equivalence.clickhouse.e2e.test.ts` proves
// that hash survives the real INSERT into `traces.AiSessionKeyHash` unchanged; this suite
// proves ClickHouse computes the same number from the same value.
//
// Values are passed as `unhex(...)` rather than string literals so that embedded NULs,
// lone control characters and astral-plane UTF-8 reach the server as the exact bytes Rust
// hashed — a literal-escaping bug would otherwise show up as a hash mismatch and be misread
// as a variant mismatch. One ASCII vector is additionally checked as a plain literal to
// prove `unhex` is not itself the thing under test.
//
//   bun ch:up
//   CLICKHOUSE_E2E=1 bun run --cwd packages/domain test -- hash-alignment.clickhouse.e2e

import { describe, expect, it } from "vitest"
import {
	ANALYZER_STRICTNESS,
	clickhouseE2eEnabled,
	clickhouseExec,
	clickhouseSelect,
	loadSyntheticFixtures,
} from "./equivalence-support"

interface HashVector {
	readonly id: string
	readonly valueHex: string
	readonly expected: string
}

const vectors: ReadonlyArray<HashVector> = loadSyntheticFixtures().flatMap((record) => {
	const key = record.rust?.session_key_hex
	if (key === null || key === undefined) return []
	return [
		{
			id: record.id,
			valueHex: key,
			expected: record.rust?.session_key_hash ?? "",
		},
	]
})

const decode = (hex: string): string => Buffer.from(hex, "hex").toString("utf8")

describe.skipIf(!clickhouseE2eEnabled)("AiSessionKeyHash Rust↔ClickHouse alignment", () => {
	it("covers the adversarial value shapes, not just ASCII", () => {
		// A guard on the guard: if the fixture ever stops producing resolved session keys
		// with these shapes, the rest of this suite silently proves much less.
		expect(vectors.length).toBeGreaterThan(40)
		const values = vectors.map((vector) => decode(vector.valueHex))
		expect(values.some((value) => value.includes(" "))).toBe(true)
		expect(values.some((value) => /[\u{10000}-\u{10FFFF}]/u.test(value))).toBe(true)
		expect(values.some((value) => value.length > 60_000)).toBe(true)
		expect(values.some((value) => value.includes("'") || value.includes("\\"))).toBe(true)
		expect(values.some((value) => value.includes("\0"))).toBe(true)
	})

	it("computes cityHash64(value) identically to the Rust writer", async () => {
		const rows = vectors
			.map((vector) => `('${vector.id.replace(/'/g, "''")}', '${vector.valueHex}')`)
			.join(",\n\t")
		const results = await clickhouseSelect<{ readonly id: string; readonly hash: string }>(
			`SELECT
	id,
	toString(cityHash64(unhex(value_hex))) AS hash
FROM values('id String, value_hex String',
	${rows}
)`,
			"default",
			ANALYZER_STRICTNESS,
		)

		expect(results).toHaveLength(vectors.length)
		const byId = new Map(results.map((row) => [row.id, row.hash]))
		const mismatches = vectors
			.filter((vector) => byId.get(vector.id) !== vector.expected)
			.map(
				(vector) =>
					`${vector.id}: rust=${vector.expected} clickhouse=${byId.get(vector.id)} value=${JSON.stringify(decode(vector.valueHex).slice(0, 120))}`,
			)
		expect(mismatches, `hash construction diverges:\n${mismatches.join("\n")}`).toEqual([])
	})

	it("agrees when the same bytes are written as a plain SQL literal", async () => {
		// `unhex` is the transport, not the claim. One pure-ASCII vector, spelled out.
		const vector = vectors.find((candidate) => decode(candidate.valueHex) === "sess-claude")
		expect(vector, "fixture no longer contains the ASCII control vector").toBeDefined()
		const body = await clickhouseExec(
			`SELECT toString(cityHash64('sess-claude')) FORMAT TabSeparated`,
			"default",
			ANALYZER_STRICTNESS,
		)
		expect(body.trim()).toBe((vector as HashVector).expected)
	})

	it("pins the negative: multi-argument cityHash64 is a different function", async () => {
		// Why any SQL that recomputes this column must pass exactly one argument.
		// `cityHash64(a, b)` combines per-argument hashes rather than hashing the
		// concatenation, so a rebuild written that way would produce a column that never
		// matches a stored one.
		const body = await clickhouseExec(
			`SELECT
	toString(cityHash64('ab')) AS single,
	toString(cityHash64('a', 'b')) AS multi
FORMAT TabSeparated`,
			"default",
			ANALYZER_STRICTNESS,
		)
		const [single, multi] = body.trim().split("\t")
		// The same number `cityhash102.rs`'s `single_argument_form_is_the_reproducible_one`
		// pins on the Rust side.
		expect(single).toBe("1725057946192985918")
		expect(multi).not.toBe(single)
	})
})

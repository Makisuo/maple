// The hash contract: `cityHash64(x)` in ClickHouse equals `city_hash64(x)` in the ingest
// writer, for every byte string. `WHERE AiSessionKeyHash = cityHash64({sessionId})` and
// repairing the column from the plaintext key in `SpanAttributes` both depend on it, and
// a divergence goes unnoticed everywhere else in the stack.
//
// The variant is the trap: ClickHouse vendors CityHash **1.0.2**, and 1.1 changed the
// mixing for inputs <= 32 bytes and > 64 bytes — hence the frozen in-crate port in
// `apps/ingest/src/cityhash102.rs` and the length bands exercised here.
//
// Vectors are the adversarial fixture's `session_key_hex` (astral-plane UTF-8, embedded
// NULs, quotes/backslashes, 64 KiB). They travel as `unhex(...)` so the bytes reach the
// server exactly as Rust hashed them; one ASCII vector also goes as a plain literal so a
// literal-escaping bug can't masquerade as a variant mismatch.
//
//   bun ch:up
//   CLICKHOUSE_E2E=1 bun run --cwd packages/domain test -- hash-alignment.clickhouse.e2e

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const clickhouseE2eEnabled = process.env.CLICKHOUSE_E2E === "1"
const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL ?? "http://127.0.0.1:8123"
const clickhouseUser = process.env.CLICKHOUSE_E2E_USER ?? "maple"
const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD ?? "maple"

/**
 * Managed Tinybird is ClickHouse 24.12 with `use_variant_as_common_type = 0`, where a
 * type mismatch between branches is a hard error; modern servers default it on and
 * quietly resolve the same expression to a `Variant`. Pinned for the same reason the
 * apps/api harness pins it.
 */
const ANALYZER_STRICTNESS: Readonly<Record<string, string>> = { use_variant_as_common_type: "0" }

const clickhouseExec = async (sql: string): Promise<string> => {
	const query = new URLSearchParams({ database: "default", ...ANALYZER_STRICTNESS })
	const response = await fetch(`${clickhouseUrl.replace(/\/$/, "")}/?${query.toString()}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "text/plain",
			"X-ClickHouse-User": clickhouseUser,
			"X-ClickHouse-Key": clickhousePassword,
			"X-ClickHouse-Database": "default",
		},
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.slice(0, 1500)}`)
	return body
}

const clickhouseSelect = async <A>(sql: string): Promise<ReadonlyArray<A>> => {
	const body = await clickhouseExec(`${sql}\nFORMAT JSONEachRow`)
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as A)
}

/** Walk up to the workspace root rather than counting `../` segments. */
const repoRoot = ((): string => {
	let dir = dirname(fileURLToPath(import.meta.url))
	while (!existsSync(join(dir, "turbo.json"))) {
		const parent = dirname(dir)
		if (parent === dir)
			throw new Error("Could not locate the workspace root: no turbo.json above this file")
		dir = parent
	}
	return dir
})()

interface FixtureRecord {
	readonly id: string
	readonly rust?: {
		/** A decimal string: a UInt64 hash above 2^53 does not survive `JSON.parse`. */
		readonly session_key_hash: string
		/** Hex of the raw winning session-key value, or null below state 5. */
		readonly session_key_hex: string | null
	}
}

interface HashVector {
	readonly id: string
	readonly valueHex: string
	readonly expected: string
}

const vectors: ReadonlyArray<HashVector> = readFileSync(
	join(repoRoot, "apps/ingest/fixtures/adversarial/adversarial-spans.jsonl"),
	"utf8",
)
	.split("\n")
	.filter((line) => line.trim().length > 0)
	.flatMap((line) => {
		const record = JSON.parse(line) as FixtureRecord
		const valueHex = record.rust?.session_key_hex
		if (valueHex === null || valueHex === undefined) return []
		return [{ id: record.id, valueHex, expected: record.rust?.session_key_hash ?? "" }]
	})

const decode = (hex: string): string => Buffer.from(hex, "hex").toString("utf8")

describe.skipIf(!clickhouseE2eEnabled)("AiSessionKeyHash Rust↔ClickHouse hash contract", () => {
	it("covers the adversarial value shapes, not just ASCII", () => {
		// If the fixture stops producing resolved session keys with these shapes, the
		// rest of this suite silently proves much less.
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
		const body = await clickhouseExec(`SELECT toString(cityHash64('sess-claude')) FORMAT TabSeparated`)
		expect(body.trim()).toBe((vector as HashVector).expected)
	})

	it("pins the negative: multi-argument cityHash64 is a different function", async () => {
		// `cityHash64(a, b)` combines per-argument hashes rather than hashing the
		// concatenation, so SQL recomputing this column must pass exactly one argument
		// or it will never match a stored value.
		const body = await clickhouseExec(
			`SELECT
	toString(cityHash64('ab')) AS single,
	toString(cityHash64('a', 'b')) AS multi
FORMAT TabSeparated`,
		)
		const [single, multi] = body.trim().split("\t")
		expect(single).toBe("1725057946192985918")
		expect(multi).not.toBe(single)
	})
})

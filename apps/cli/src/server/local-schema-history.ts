/**
 * Append-only structural identity history for the local store.
 *
 * These values are literals on purpose. The schema gate compares the current
 * identity to the last entry and, in CI, verifies that entries already present
 * on the base branch remain byte-for-byte unchanged. A new structural schema
 * therefore appends an identity and must also ship a registered migration edge
 * (or an explicit unsupported boundary) to reach it.
 */
export interface LocalSchemaHistoryEntry {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest: string
	readonly projectRevision: string
}

export const LOCAL_SCHEMA_HISTORY: ReadonlyArray<LocalSchemaHistoryEntry> = Object.freeze([
	Object.freeze({
		version: 0,
		fingerprint: "428701854f9fd30e",
		digest: "",
		manifestDigest: "",
		projectRevision: "d58ce4a83d3ad3f3a29b9bb972272b757547ae793c050194354454634f3abccd",
	}),
	Object.freeze({
		version: 1,
		fingerprint: "06ac009495b54395",
		digest: "06ac009495b543953779fb91ed3ac1692607d274c34fab4b169bd5674ef8220a",
		manifestDigest: "24a7e52d4ae31f479db97c091d0db5c32bdf8e018e04ed00abcd53124b1f9de3",
		projectRevision: "b6569235f05a5981ffe47f25d22fd90a8783f3200410a519fcf25577b445275b",
	}),
] as const)

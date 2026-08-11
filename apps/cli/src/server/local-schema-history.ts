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
		fingerprint: "718581a523cbf01c",
		digest: "718581a523cbf01c216bf930cc3ffca72921c387c926c3c2c0cf1861b00c4ceb",
		manifestDigest: "ff947e1536a5931593d33f78d15a46156b7467fc6254182ab57bd84fcf39ba06",
		projectRevision: "53294ef75d1afb2e4c9ce6ba2e80e9900e4996e6731838a1ce1902803588c58d",
	}),
	Object.freeze({
		version: 2,
		fingerprint: "d8d37ab33e5c1324",
		digest: "d8d37ab33e5c132492490f982f2bd577012c076fb4c20cf35e5cbe4a21bba843",
		manifestDigest: "3986594890e0b57ea88bea484dd0f0550142a7b6795f09e254f98d34b3c6450c",
		projectRevision: "0d3c004e5b20b6c7055934e4dd054957b8d49094df79f97db9055de0bee4267a",
	}),
	Object.freeze({
		version: 3,
		fingerprint: "0d7e8c2f7857a351",
		digest: "0d7e8c2f7857a3510beb2bf5ab6f214551274986e513592c6dd22d4eb83aa3ca",
		manifestDigest: "2fb3a1d1b97d238c118ecad39fbb4626cd8c9eb1fa0358834f5e2977bc424a6f",
		projectRevision: "1cae45c53763c56d990888ed6722a709f9415b4754faa801f8ebcfaba904e858",
	}),
	Object.freeze({
		version: 4,
		fingerprint: "75ac856927d88d56",
		digest: "75ac856927d88d56518f12c68407a8f2a199d000b6eeb8576f9c97000138f5a4",
		manifestDigest: "826f9363db5dd7722debd0c87a5b74a5b66387f4752abc219d4cc0ce76358a9e",
		projectRevision: "27015e7036e9cacaa5156bcc10a3aead96cb4fa2fcb7c615c272c691f2cbf54a",
	}),
	Object.freeze({
		version: 5,
		fingerprint: "3099929d42b2ce8b",
		digest: "3099929d42b2ce8b18c06a428a8e32a51ce9724300138241110e08a3f09e8193",
		manifestDigest: "99d834ae3baab1d0a753f18a96b96a0130bb0af8964a0b119f1f4203e3bc6d0f",
		projectRevision: "7637e9d59858fd4d8b7c019e1be7feac249120a6728d7ad4314de1276531677a",
	}),
] as const)

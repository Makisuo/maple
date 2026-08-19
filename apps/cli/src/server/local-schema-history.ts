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
		fingerprint: "c36c52a95568eb68",
		digest: "c36c52a95568eb68f8ebc98d7d36b552f21fb09b888bb310c68f0ad52d529fe4",
		manifestDigest: "9d3b16f4f882049d40cf5bb31b9224243fcdade009c34b833212788f8cd9cc1d",
		projectRevision: "3bf63ab19fcba1a20ebaf6a97b49acfc2ecf00f1589c11438349bb87d21f77b7",
	}),
	Object.freeze({
		version: 6,
		fingerprint: "febb73ca0c1522a3",
		digest: "febb73ca0c1522a3585faf1e9e84a414fd761a5f2119a09aa68f57d8679619c8",
		manifestDigest: "de9dd6b82ce13c69bcabda663575ec0faeab0028d6d2fb68c346b838d3c89d83",
		projectRevision: "4f1aaee422dbfba94513ed400e545accd644903b21a26dd240fb62c25d6bb101",
	}),
	Object.freeze({
		version: 7,
		fingerprint: "a7af048e80aca54a",
		digest: "a7af048e80aca54a28dc113401da08a7d2d130792241e3012864cadf303d65e5",
		manifestDigest: "1b2f0f4fd4cf1d9653dc14f62aa99c628e1431e57e9c97ecaf93bf790ff28996",
		projectRevision: "5d24e4511fb65afbb0bc90a4e6e31fe78a5b7389ba5807fb48eada2b04f7d7d8",
	}),
] as const)

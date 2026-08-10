import { execFileSync } from "node:child_process"
import {
	CURRENT_LOCAL_SCHEMA,
	LOCAL_SCHEMA_HISTORY,
	LOCAL_SCHEMA_MANIFEST,
	LOCAL_SCHEMA_MANIFEST_DIGEST,
	LOCAL_SCHEMA_V1,
	LOCAL_SCHEMA_V1_MANIFEST_DIGEST,
	LOCAL_SCHEMA_V1_SQL,
	LOCAL_SCHEMA_V2,
	LOCAL_SCHEMA_V2_MANIFEST_DIGEST,
	LOCAL_SCHEMA_V2_SQL,
	LOCAL_SCHEMA_V3,
	LOCAL_SCHEMA_V3_MANIFEST_DIGEST,
	LOCAL_SCHEMA_V3_SQL,
	LOCAL_SCHEMA_V4,
	LOCAL_SCHEMA_V4_MANIFEST_DIGEST,
	LOCAL_SCHEMA_V4_SQL,
	LOCAL_SCHEMA_VERSION,
} from "../apps/cli/src/server/schema-identity"
import { resolveMigrationChain } from "../apps/cli/src/server/local-store-migrations"
import { schemaDigest, schemaFingerprint } from "../apps/cli/src/server/store-version"

const fail = (message: string): never => {
	console.error(message)
	process.exit(1)
	throw new Error(message)
}

const sameIdentity = (
	a: Pick<
		(typeof LOCAL_SCHEMA_HISTORY)[number],
		"version" | "fingerprint" | "digest" | "manifestDigest" | "projectRevision"
	>,
	b: Pick<
		typeof CURRENT_LOCAL_SCHEMA,
		"version" | "fingerprint" | "digest" | "manifestDigest" | "projectRevision"
	>,
): boolean =>
	a.version === b.version &&
	a.fingerprint === b.fingerprint &&
	a.digest === b.digest &&
	a.manifestDigest === b.manifestDigest &&
	a.projectRevision === b.projectRevision

if (LOCAL_SCHEMA_HISTORY.length === 0) fail("local schema identity history is empty")
for (let index = 1; index < LOCAL_SCHEMA_HISTORY.length; index += 1) {
	if (LOCAL_SCHEMA_HISTORY[index]!.version <= LOCAL_SCHEMA_HISTORY[index - 1]!.version)
		fail("local schema identity history must be strictly increasing by schema version")
}

const latest = LOCAL_SCHEMA_HISTORY[LOCAL_SCHEMA_HISTORY.length - 1]!
if (!sameIdentity(latest, CURRENT_LOCAL_SCHEMA)) {
	fail(
		`current local schema identity is not the append-only history tip (current v${LOCAL_SCHEMA_VERSION} ${LOCAL_SCHEMA_MANIFEST_DIGEST}; history tip v${latest.version} ${latest.manifestDigest}). Append a new versioned identity and migration edge before changing the schema.`,
	)
}

const v1 = LOCAL_SCHEMA_HISTORY.find((entry) => entry.version === LOCAL_SCHEMA_V1.version)
if (
	!v1 ||
	LOCAL_SCHEMA_V1_MANIFEST_DIGEST !== v1.manifestDigest ||
	schemaFingerprint(LOCAL_SCHEMA_V1_SQL) !== v1.fingerprint ||
	schemaDigest(LOCAL_SCHEMA_V1_SQL) !== v1.digest ||
	LOCAL_SCHEMA_V1.fingerprint !== v1.fingerprint ||
	LOCAL_SCHEMA_V1.digest !== v1.digest
) {
	fail("the immutable local schema v1 snapshot no longer matches its historical identity")
}

const v2 = LOCAL_SCHEMA_HISTORY.find((entry) => entry.version === LOCAL_SCHEMA_V2.version)
if (
	!v2 ||
	LOCAL_SCHEMA_V2_MANIFEST_DIGEST !== v2.manifestDigest ||
	schemaFingerprint(LOCAL_SCHEMA_V2_SQL) !== v2.fingerprint ||
	schemaDigest(LOCAL_SCHEMA_V2_SQL) !== v2.digest ||
	LOCAL_SCHEMA_V2.fingerprint !== v2.fingerprint ||
	LOCAL_SCHEMA_V2.digest !== v2.digest
) {
	fail("the immutable local schema v2 snapshot no longer matches its historical identity")
}

const v3 = LOCAL_SCHEMA_HISTORY.find((entry) => entry.version === LOCAL_SCHEMA_V3.version)
if (
	!v3 ||
	LOCAL_SCHEMA_V3_MANIFEST_DIGEST !== v3.manifestDigest ||
	schemaFingerprint(LOCAL_SCHEMA_V3_SQL) !== v3.fingerprint ||
	schemaDigest(LOCAL_SCHEMA_V3_SQL) !== v3.digest ||
	LOCAL_SCHEMA_V3.fingerprint !== v3.fingerprint ||
	LOCAL_SCHEMA_V3.digest !== v3.digest
) {
	fail("the immutable local schema v3 snapshot no longer matches its historical identity")
}

const v4 = LOCAL_SCHEMA_HISTORY.find((entry) => entry.version === LOCAL_SCHEMA_V4.version)
if (
	!v4 ||
	LOCAL_SCHEMA_V4_MANIFEST_DIGEST !== v4.manifestDigest ||
	schemaFingerprint(LOCAL_SCHEMA_V4_SQL) !== v4.fingerprint ||
	schemaDigest(LOCAL_SCHEMA_V4_SQL) !== v4.digest ||
	LOCAL_SCHEMA_V4.fingerprint !== v4.fingerprint ||
	LOCAL_SCHEMA_V4.digest !== v4.digest
) {
	fail("the immutable local schema v4 snapshot no longer matches its historical identity")
}

const names = LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name)
if (new Set(names).size !== names.length)
	fail("local structural schema manifest contains duplicate object names")

for (const entry of LOCAL_SCHEMA_HISTORY) {
	try {
		resolveMigrationChain(
			{
				version: entry.version,
				fingerprint: entry.fingerprint,
				digest: entry.digest,
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
			},
			CURRENT_LOCAL_SCHEMA,
		)
	} catch (error) {
		fail(
			`local schema history entry v${entry.version} cannot reach current v${CURRENT_LOCAL_SCHEMA.version} through the registered migration graph: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

const historyPath = "apps/cli/src/server/local-schema-history.ts"
const parseHistorySource = (source: string) => {
	const entries: Array<Record<string, string | number>> = []
	const pattern =
		/version:\s*(\d+),\s*fingerprint:\s*"([^"]*)",\s*digest:\s*"([^"]*)",\s*manifestDigest:\s*"([^"]*)",\s*projectRevision:\s*"([^"]*)"/g
	for (const match of source.matchAll(pattern)) {
		entries.push({
			version: Number(match[1]),
			fingerprint: match[2]!,
			digest: match[3]!,
			manifestDigest: match[4]!,
			projectRevision: match[5]!,
		})
	}
	return entries
}

const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main"
const baseRefExists = ((): boolean => {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
			stdio: ["ignore", "ignore", "ignore"],
		})
		return true
	} catch {
		return false
	}
})()
// `git show <missing-ref>:<path>` and `git show <ref>:<missing-path>` both exit
// 128, so without this the append-only comparison would silently no-op whenever
// the base ref was never fetched — the exact case the gate exists to catch. On a
// PR the workflow fetches it explicitly, so its absence there is a real failure;
// a push build or a local run has no base to compare against and only warns.
if (!baseRefExists) {
	if (process.env.GITHUB_BASE_REF)
		fail(`${baseRef} is not available; fetch the base branch before running this gate`)
	console.warn(`skipping the append-only history comparison: ${baseRef} is not available`)
}

if (baseRefExists) {
	try {
		const baseSource = execFileSync("git", ["show", `${baseRef}:${historyPath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
		const baseHistory = parseHistorySource(baseSource)
		if (baseSource.includes("LOCAL_SCHEMA_HISTORY") && baseHistory.length === 0)
			fail("could not parse the base branch's local schema identity history")
		const currentHistory = LOCAL_SCHEMA_HISTORY.map((entry) => ({ ...entry }))
		if (
			baseHistory.length > currentHistory.length ||
			JSON.stringify(currentHistory.slice(0, baseHistory.length)) !== JSON.stringify(baseHistory)
		)
			fail(
				"local schema identity history is not append-only; existing base identities must remain unchanged",
			)
	} catch (error) {
		// The base ref exists, so a 128 here means the first commit that introduces the
		// history has no base file. A later run takes the strict prefix path above.
		if (
			typeof error !== "object" ||
			error === null ||
			!("status" in error) ||
			(error as { readonly status?: unknown }).status !== 128
		)
			throw error
	}
}

console.log(
	`local structural schema manifest is up to date (schema v${LOCAL_SCHEMA_VERSION}, ${LOCAL_SCHEMA_MANIFEST.objects.length} objects, ${LOCAL_SCHEMA_MANIFEST_DIGEST}; ${LOCAL_SCHEMA_HISTORY.length} historical identities)`,
)

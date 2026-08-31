/**
 * Scaffold a local-store schema version bump.
 *
 * Everything the append-only gate demands except the DDL itself is a pure
 * function of one integer: the snapshot copy, the version constant, four edit
 * sites in `schema-identity.ts`, the history entry's four hashes, the migration
 * registry, and the pinned literals in both the bun test and the native probe.
 * This script writes all of them, then leaves the migration edge's `apply` for
 * a human — which is the only part that was ever real work.
 *
 * Run it AFTER `bun run clickhouse:schema` has regenerated the local DDL, so
 * `schema/local-schema.sql` already holds the schema being bumped to.
 *
 *   bun run local-schema:bump <slug> [--description "..."]
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildLocalSchemaManifest } from "../apps/cli/src/server/schema-manifest"
import { schemaDigest, schemaFingerprint } from "../apps/cli/src/server/store-version"

const SERVER_DIR = "apps/cli/src/server"
const MIGRATIONS_DIR = `${SERVER_DIR}/local-store-migrations`
const SCHEMA_DIR = `${SERVER_DIR}/schema`
const TEST_FILE = "apps/cli/test/local-store-migrations.test.ts"
const NATIVE_PROBE = "apps/cli/test/native-local-store-migration.sh"

// The annotation is on the variable, not just the arrow: TypeScript narrows
// control flow through a `never`-returning const only when it is declared this
// way, which is what lets the guards below act as assertions.
const fail: (message: string) => never = (message) => {
	console.error(`\n${message}\n`)
	process.exit(1)
	throw new Error(message)
}

const read = (path: string): string => readFileSync(path, "utf8")

/** Every edit is anchored. A patch that stops matching must stop the bump, not silently no-op. */
const patch = (path: string, edits: ReadonlyArray<readonly [string | RegExp, string]>): void => {
	let source = read(path)
	for (const [needle, replacement] of edits) {
		const matches =
			typeof needle === "string"
				? source.split(needle).length - 1
				: [...source.matchAll(new RegExp(needle.source, `${needle.flags.replace("g", "")}g`))].length
		if (matches === 0) fail(`${path}: anchor did not match, so the bump was not applied:\n  ${needle}`)
		if (typeof needle === "string" && matches > 1)
			fail(`${path}: anchor matched ${matches} times, expected exactly one:\n  ${needle}`)
		source =
			typeof needle === "string"
				? source.replace(needle, replacement)
				: source.replace(new RegExp(needle.source, `${needle.flags.replace("g", "")}g`), replacement)
	}
	writeFileSync(path, source)
}

const pascal = (slug: string): string =>
	slug
		.split("-")
		.filter((part) => part.length > 0)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("")

const pad = (version: number): string => String(version).padStart(4, "0")

// ---------------------------------------------------------------------------
// Arguments and current state
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const descriptionIndex = args.findIndex((arg) => arg === "--description")
const description = descriptionIndex === -1 ? undefined : args[descriptionIndex + 1]
// Guard the -1 case: with no `--description`, `descriptionIndex + 1` is 0, which
// would skip the slug itself.
const slug = args.find(
	(arg, index) => !arg.startsWith("--") && !(descriptionIndex !== -1 && index === descriptionIndex + 1),
)

if (!slug || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug))
	fail(
		'usage: bun run local-schema:bump <kebab-case-slug> [--description "..."]\n\ne.g. bun run local-schema:bump service-operations-discriminators',
	)

const versionSource = read(`${SERVER_DIR}/local-schema-version.ts`)
const versionMatch = /export const LOCAL_SCHEMA_VERSION = (\d+) as const/.exec(versionSource)
if (!versionMatch) fail("could not read LOCAL_SCHEMA_VERSION")
const from = Number(versionMatch[1])
const to = from + 1

const snapshotPath = `${SCHEMA_DIR}/local-schema-v${to}.sql`
const modulePath = `${MIGRATIONS_DIR}/v${from}-to-v${to}-${slug}.ts`
if (existsSync(snapshotPath)) fail(`${snapshotPath} already exists; v${to} looks already bumped`)
if (existsSync(modulePath)) fail(`${modulePath} already exists`)

// The identity is computed from the generated DDL directly rather than through
// `schema-identity.ts`, which cannot even be imported until the v{to} snapshot
// it statically imports exists.
const currentSql = read(`${SCHEMA_DIR}/local-schema.sql`)
const identity = {
	version: to,
	fingerprint: schemaFingerprint(currentSql),
	digest: schemaDigest(currentSql),
	manifestDigest: buildLocalSchemaManifest(currentSql).digest,
	projectRevision: (() => {
		const source = read(`${SERVER_DIR}/schema-identity.ts`)
		const match = /export const CURRENT_SCHEMA_PROJECT_REVISION =\s*"([0-9a-f]{64})"/.exec(source)
		if (!match) fail("could not read CURRENT_SCHEMA_PROJECT_REVISION")
		return match[1]
	})(),
}

const historySource = read(`${SERVER_DIR}/local-schema-history.ts`)
if (historySource.includes(`fingerprint: "${identity.fingerprint}"`))
	fail(
		`the generated schema still hashes to an identity already in the history (${identity.fingerprint}).\nEdit the schema and run \`bun run clickhouse:schema\` before bumping.`,
	)

// ---------------------------------------------------------------------------
// The previous migration module is the template: it is always the closest
// example of the shape, and it never drifts the way a checked-in one would.
// ---------------------------------------------------------------------------

const previousModuleFile = readdirSync(MIGRATIONS_DIR).find((name) =>
	name.startsWith(`v${from - 1}-to-v${from}-`),
)
if (!previousModuleFile) fail(`no v${from - 1} -> v${from} migration module to derive the new edge from`)
const previousSlug = previousModuleFile.replace(`v${from - 1}-to-v${from}-`, "").replace(/\.ts$/, "")
const previousModuleId = `local-${pad(from - 1)}-to-${pad(from)}-${previousSlug}`
const moduleId = `local-${pad(from)}-to-${pad(to)}-${slug}`
const previousExport = `v${from - 1}ToV${from}${pascal(previousSlug)}Module`
const newExport = `v${from}ToV${to}${pascal(slug)}Module`

// `from - 1 -> from` and `from -> to` must be remapped in one pass; done in two
// passes the first rewrite's output would be caught by the second.
const versionMap = new Map([
	[from - 1, from],
	[from, to],
])
const remap = (value: string): number => versionMap.get(Number(value)) ?? Number(value)
// `v<n> -> v<m>` prose is all-or-nothing. The previous module's own edge label
// remaps; a back-reference to an OLDER edge ("the ordering v11 -> v12 needed")
// has only its right half in the map, and remapping that half alone invents an
// edge that never existed.
const derivedModule = read(join(MIGRATIONS_DIR, previousModuleFile))
	.replace(
		/LOCAL_SCHEMA_V(\d+)|([vV])(\d+)ToV(\d+)|local-(\d{4})-to-(\d{4})-|v(\d+) -> v(\d+)|\bv(\d+)\b/g,
		(match, a, prefix, b, c, d, e, pairLeft, pairRight, f) => {
			if (a !== undefined) return `LOCAL_SCHEMA_V${remap(a)}`
			if (b !== undefined) return `${prefix}${remap(b)}ToV${remap(c)}`
			if (d !== undefined) return `local-${pad(remap(d))}-to-${pad(remap(e))}-`
			if (pairLeft !== undefined)
				return versionMap.has(Number(pairLeft)) && versionMap.has(Number(pairRight))
					? `v${remap(pairLeft)} -> v${remap(pairRight)}`
					: match
			if (f !== undefined) return `v${remap(f)}`
			return match
		},
	)
	.replaceAll(previousSlug, slug)
	.replaceAll(pascal(previousSlug), pascal(slug))
	// The registry's own description is edge-specific prose; carrying the
	// previous edge's forward silently would mislabel the migration in the CLI.
	.replace(
		/(\tmoduleVersion: \d+,\n\tdescription:\s*)"(?:[^"\\]|\\.)*"/,
		`$1${JSON.stringify(description ?? `TODO(v${from} -> v${to}): what this edge does, in one line`)}`,
	)

const todoBanner = `// TODO(v${from} -> v${to}): derived from ${previousModuleFile}. Version plumbing, the
// module id and the registry entry are already correct. Still to write by hand:
//   1. the doc comment below — what changes, and what is NOT backfilled
//   2. \`apply\` — the DDL for this edge, plus any view drops it needs
//   3. \`preflight\`/\`verify\` row counts for the tables this edge touches
//   4. \`operations\` and \`dispositions\` descriptions
// \`verify\` asserts the v${to} manifest, so leaving \`apply\` unedited fails the
// native migration probe rather than shipping a wrong edge.
`

writeFileSync(
	modulePath,
	derivedModule.replace(/^(\/\*\*\n \* The local mirror of ClickHouse migration)/m, `${todoBanner}\n$1`),
)

// ---------------------------------------------------------------------------
// The mechanical edits
// ---------------------------------------------------------------------------

copyFileSync(`${SCHEMA_DIR}/local-schema.sql`, snapshotPath)

patch(`${SERVER_DIR}/local-schema-version.ts`, [
	[
		`export const LOCAL_SCHEMA_VERSION = ${from} as const`,
		`export const LOCAL_SCHEMA_VERSION = ${to} as const`,
	],
])

patch(`${SERVER_DIR}/schema-identity.ts`, [
	[
		`import schemaV${from}Sql from "./schema/local-schema-v${from}.sql" with { type: "text" }`,
		`import schemaV${from}Sql from "./schema/local-schema-v${from}.sql" with { type: "text" }\nimport schemaV${to}Sql from "./schema/local-schema-v${to}.sql" with { type: "text" }`,
	],
	[`\tschemaV${from}Sql,\n]`, `\tschemaV${from}Sql,\n\tschemaV${to}Sql,\n]`],
	[
		`export const LOCAL_SCHEMA_V${from}_MANIFEST = snapshotAt(${from}).manifest`,
		`export const LOCAL_SCHEMA_V${from}_MANIFEST = snapshotAt(${from}).manifest\nexport const LOCAL_SCHEMA_V${to}_SQL = snapshotAt(${to}).sql\nexport const LOCAL_SCHEMA_V${to}_MANIFEST = snapshotAt(${to}).manifest`,
	],
	[
		`export const LOCAL_SCHEMA_V${from} = identityAt(${from})`,
		`export const LOCAL_SCHEMA_V${from} = identityAt(${from})\nexport const LOCAL_SCHEMA_V${to} = identityAt(${to})`,
	],
])

patch(`${SERVER_DIR}/local-schema-history.ts`, [
	[
		"] as const)",
		`\tObject.freeze({
		// TODO(v${to}): what changed, whether any part is rewritten or any row
		// moves, and what this edge does NOT backfill.
		//
		// projectRevision is carried forward deliberately — it is a hardcoded
		// constant that no longer tracks the generator's header, and the identity
		// this gate compares is the fingerprint/digest pair.
		version: ${identity.version},
		fingerprint: "${identity.fingerprint}",
		digest: "${identity.digest}",
		manifestDigest: "${identity.manifestDigest}",
		projectRevision: "${identity.projectRevision}",
	}),
] as const)`,
	],
])

patch(`${SERVER_DIR}/local-store-migrations.ts`, [
	[
		`import { ${previousExport} } from "./local-store-migrations/${previousModuleFile.replace(/\.ts$/, "")}"`,
		`import { ${previousExport} } from "./local-store-migrations/${previousModuleFile.replace(/\.ts$/, "")}"\nimport { ${newExport} } from "./local-store-migrations/v${from}-to-v${to}-${slug}"`,
	],
	[`\t${previousExport},\n]`, `\t${previousExport},\n\t${newExport},\n]`],
])

patch(TEST_FILE, [
	[`\tLOCAL_SCHEMA_V${from},\n`, `\tLOCAL_SCHEMA_V${from},\n\tLOCAL_SCHEMA_V${to},\n`],
	[/matches the generated v\d+ revision/, `matches the generated v${to} revision`],
	[
		/expect\(SCHEMA_FINGERPRINT\)\.toBe\("[0-9a-f]+"\)/,
		`expect(SCHEMA_FINGERPRINT).toBe("${identity.fingerprint}")`,
	],
	[/expect\(SCHEMA_DIGEST\)\.toBe\("[0-9a-f]+"\)/, `expect(SCHEMA_DIGEST).toBe("${identity.digest}")`],
	[
		`expect(CURRENT_LOCAL_SCHEMA.version).toBe(${from})`,
		`expect(CURRENT_LOCAL_SCHEMA.version).toBe(${to})`,
	],
	[
		`expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V${from})`,
		`expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V${to})`,
	],
	// The future-store guard is pinned one past the tip on purpose.
	[
		`{ ...CURRENT_LOCAL_SCHEMA, version: ${to}, fingerprint: "future", digest: SCHEMA_DIGEST }`,
		`{ ...CURRENT_LOCAL_SCHEMA, version: ${to + 1}, fingerprint: "future", digest: SCHEMA_DIGEST }`,
	],
	// Both resolved-chain assertions end at the previous tip.
	[new RegExp(`(\\t+)"${previousModuleId}",\\n`), `$1"${previousModuleId}",\n$1"${moduleId}",\n`],
])

patch(NATIVE_PROBE, [
	[
		/\.schemaVersion == \d+ and \.schema == "[0-9a-f]+"/,
		`.schemaVersion == ${to} and .schema == "${identity.fingerprint}"`,
	],
])

try {
	execFileSync("git", ["add", "--intent-to-add", snapshotPath, modulePath], { stdio: "ignore" })
} catch {
	// A bump outside a git checkout is still a valid bump.
}

console.log(`bumped local schema v${from} -> v${to} (${identity.fingerprint})

  ${snapshotPath}
  ${modulePath}  <- write the DDL here

edited: local-schema-version.ts, schema-identity.ts, local-schema-history.ts,
        local-store-migrations.ts, ${TEST_FILE}, ${NATIVE_PROBE}

next:
  1. write \`apply\` and the doc comments in the new module (see its TODO banner)
  2. bun run clickhouse:schema:check
  3. bun run --cwd apps/cli test
`)

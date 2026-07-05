#!/usr/bin/env bun
/**
 * Per-PR Electric Cloud environment lifecycle for the PR-preview deploy.
 * Sibling of scripts/planetscale-pr-branch.ts and scripts/tinybird-pr-branch.ts
 * with the same up/down contract.
 *
 *   bun scripts/electric-pr-branch.ts up   <pr-number>
 *   bun scripts/electric-pr-branch.ts down <pr-number>
 *
 * `up` (re)creates an Electric Cloud **environment** `pr-<n>` and a Postgres
 * **service** (the sync "source") inside it, pointed at this PR's PlanetScale
 * branch — deleting any existing environment first so every deploy starts fresh
 * (exact parity with the PlanetScale reset: each push recreates the branch, so
 * the previous source now points at a deleted DB with rotated credentials). It
 * then exports `ELECTRIC_URL` / `ELECTRIC_SOURCE_ID` / `ELECTRIC_SECRET` to
 * $GITHUB_ENV so the subsequent `alchemy:deploy:pr` binds the standalone
 * apps/electric-sync worker to this source (see apps/electric-sync/alchemy.run.ts).
 *
 * `down` deletes the `pr-<n>` environment (called on PR close, after
 * `alchemy:destroy:pr`). Environment deletion cascades its service. Each source
 * counts against the Electric plan's max-databases cap and holds a PlanetScale
 * replication slot, so `down` on close is mandatory.
 *
 * Depends on the PlanetScale `up` step having exported MAPLE_PG_URL (the direct
 * 5432 connection string) and the `drizzle-kit migrate` step having applied
 * `0009_electric_publication` (creates `electric_publication_default`).
 *
 * Auth: the Electric CLI (`@electric-sql/cli`) reads ELECTRIC_API_TOKEN
 * (`sv_live_...`) from the environment. Config:
 *   ELECTRIC_API_TOKEN            CLI auth token (required; also the workflow gate)
 *   ELECTRIC_PROJECT_ID           parent project id for the per-PR environment (required)
 *   MAPLE_PG_URL                  PR branch direct connection string (required on `up`)
 *   ELECTRIC_CLOUD_URL            Cloud shape API base to export as ELECTRIC_URL (default
 *                                 https://api.electric-sql.cloud); deliberately NOT the
 *                                 local-dev `ELECTRIC_URL` (docker), which would be wrong here
 *   ELECTRIC_REGION              source region (default us-east-1)
 *   ELECTRIC_PUBLICATION         if set, passed as `--publication <name>` to `services create`
 *                                 (prod uses `electric_publication_default` in manual-publishing mode)
 *   ELECTRIC_SERVICE_EXTRA_ARGS  extra space-separated flags for `services create postgres`
 *                                 (escape hatch for e.g. a manual-table-publishing flag)
 *   ELECTRIC_CLI                  override the CLI invocation (default `bunx @electric-sql/cli`)
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down"

const FAILURE = 1
const GONE_TIMEOUT_MS = 2 * 60 * 1000
const GONE_POLL_MS = 5_000
const DEFAULT_ELECTRIC_URL = "https://api.electric-sql.cloud"
const DEFAULT_REGION = "us-east-1"

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const parseArgs = (): { subcommand: Subcommand; environmentName: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down") {
		fail(`Usage: bun scripts/electric-pr-branch.ts <up|down> <pr-number> (got "${rawSubcommand ?? ""}")`)
	}
	// PR number is digits only and the only untrusted input that lands in a name.
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand as Subcommand, environmentName: `pr-${prNumber}` }
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		return fail(`Missing required env: ${key}`)
	}
	return value
}

interface CliResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

// The CLI reads ELECTRIC_API_TOKEN from the inherited environment; we never pass
// it as a flag (keeps it out of the process arg list / logs).
const cliInvocation = (): [string, string[]] => {
	const [program, ...prefix] = (process.env.ELECTRIC_CLI?.trim() || "bunx @electric-sql/cli").split(/\s+/)
	return [program as string, prefix]
}

// Flags whose VALUE is a credential and must never be echoed. `--database-url`
// carries MAPLE_PG_URL (postgres://user:password@host/db); GitHub `::add-mask::`
// on the raw password alone is unreliable (the URL-encoded form won't match — see
// planetscale-pr-branch.ts), so we redact the value from the command echo outright.
const SECRET_ARG_FLAGS = new Set(["--database-url"])

const redactArgsForLog = (args: ReadonlyArray<string>): string =>
	args.map((arg, i) => (i > 0 && SECRET_ARG_FLAGS.has(args[i - 1] as string) ? "***" : arg)).join(" ")

/**
 * Run an `electric` CLI command. Returns the captured output; never throws
 * (callers decide how to treat failures). `secret` suppresses stdout logging —
 * JSON credential output must never reach the CI log. The command echo redacts
 * credential-bearing arg values (e.g. `--database-url`) unconditionally.
 */
const runElectric = (args: string[], opts?: { secret?: boolean }): CliResult => {
	const [program, prefix] = cliInvocation()
	const proc = spawnSync(program, [...prefix, ...args], { encoding: "utf8" })
	if (proc.error) {
		fail(`Failed to invoke the Electric CLI (\`${program}\`): ${proc.error.message}`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	console.log(`$ electric ${redactArgsForLog(args)}`)
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
		if (stderr) console.error(stderr)
	} else if (stderr) {
		console.error(stderr)
	}
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isNotFound = (result: CliResult): boolean =>
	/not found|does not exist|no such|unknown environment/i.test(`${result.stdout}\n${result.stderr}`)

const isAlreadyExists = (result: CliResult): boolean =>
	/already exists|already been taken|name is taken|duplicate/i.test(`${result.stdout}\n${result.stderr}`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const parseJson = (stdout: string, context: string): unknown => {
	try {
		return JSON.parse(stdout)
	} catch {
		return fail(`Could not parse \`electric ${context} --json\` output as JSON`)
	}
}

/** First non-empty string value among `keys` on a JSON object (CLI field names drift). */
const pick = (value: unknown, ...keys: string[]): string | undefined => {
	if (typeof value !== "object" || value === null) return undefined
	const record = value as Record<string, unknown>
	for (const key of keys) {
		const candidate = record[key]
		if (typeof candidate === "string" && candidate.length > 0) return candidate
	}
	return undefined
}

/** Coerce `electric ... list --json` output to an array, tolerating a wrapper object. */
const asArray = (value: unknown): ReadonlyArray<unknown> => {
	if (Array.isArray(value)) return value
	if (typeof value === "object" && value !== null) {
		for (const key of ["environments", "data", "items", "results"]) {
			const nested = (value as Record<string, unknown>)[key]
			if (Array.isArray(nested)) return nested
		}
	}
	return []
}

/** Resolve the id of the environment named `environmentName`, or undefined if none. */
const findEnvironmentId = (projectId: string, environmentName: string): string | undefined => {
	// `list` may or may not accept `--project`; fall back to an unscoped list.
	let listed = runElectric(["environments", "list", "--project", projectId, "--json"], { secret: true })
	if (listed.exitCode !== 0) {
		listed = runElectric(["environments", "list", "--json"], { secret: true })
	}
	if (listed.exitCode !== 0) {
		return isNotFound(listed)
			? undefined
			: fail(`Failed to list Electric environments (exit ${listed.exitCode})`)
	}
	const match = asArray(parseJson(listed.stdout, "environments list")).find(
		(entry) => pick(entry, "name") === environmentName,
	)
	return match ? pick(match, "id", "environment_id", "env_id") : undefined
}

const waitUntilEnvironmentGone = async (projectId: string, environmentName: string): Promise<void> => {
	const deadline = Date.now() + GONE_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (!findEnvironmentId(projectId, environmentName)) {
			console.log(`✓ Environment ${environmentName} deleted`)
			return
		}
		console.log(`… waiting for environment ${environmentName} to finish deleting`)
		await sleep(GONE_POLL_MS)
	}
	fail(`Timed out waiting for environment ${environmentName} to delete`)
}

// Register a value with GitHub Actions' log masker. Only emitted in CI — locally
// (no GITHUB_ENV) it would just print the secret to the developer's terminal.
const maskSecret = (value: string): void => {
	if (value && process.env.GITHUB_ENV?.trim()) console.log(`::add-mask::${value}`)
}

const maskAndExport = (entries: Record<string, string>, secrets: ReadonlyArray<string>): void => {
	for (const secret of secrets) {
		maskSecret(secret)
	}
	const githubEnv = process.env.GITHUB_ENV?.trim()
	const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`)
	if (!githubEnv) {
		// Local run: print (masked values omitted) so a developer can wire them up.
		console.log("\nResolved Electric env (GITHUB_ENV unset — printing keys only):")
		for (const key of Object.keys(entries)) console.log(`  ${key}=…`)
		return
	}
	appendFileSync(githubEnv, `${lines.join("\n")}\n`)
	console.log(`✓ Exported ${Object.keys(entries).join(", ")} to GITHUB_ENV`)
}

const up = async (environmentName: string): Promise<void> => {
	requireEnv("ELECTRIC_API_TOKEN")
	const projectId = requireEnv("ELECTRIC_PROJECT_ID")
	const databaseUrl = requireEnv("MAPLE_PG_URL")
	// Defense-in-depth: mask the connection string so any incidental echo (CLI
	// output, error text) is scrubbed in CI. The command echo already redacts it.
	maskSecret(databaseUrl)
	// The exported endpoint must be the Electric Cloud API base (where the source
	// we just provisioned lives) — NOT the plain `ELECTRIC_URL`, which is the
	// local-dev docker value (`http://localhost:3473` in .env.example) and would
	// be wrong if Infisical `dev` happens to carry it. Read a dedicated
	// `ELECTRIC_CLOUD_URL` override, defaulting to the Cloud base.
	const electricUrl = process.env.ELECTRIC_CLOUD_URL?.trim() || DEFAULT_ELECTRIC_URL
	const region = process.env.ELECTRIC_REGION?.trim() || DEFAULT_REGION

	// 1. Reset: delete any existing `pr-<n>` environment first. Its source points
	//    at the now-recreated PlanetScale branch (deleted DB + rotated creds), so a
	//    reused environment would sync nothing. Recreate for a clean, valid source.
	const existingId = findEnvironmentId(projectId, environmentName)
	if (existingId) {
		const deleted = runElectric(["environments", "delete", existingId, "--force"])
		if (deleted.exitCode !== 0 && !isNotFound(deleted)) {
			fail(`Failed to reset (delete) existing environment ${environmentName}`)
		}
		await waitUntilEnvironmentGone(projectId, environmentName)
	}

	// 2. Create the per-PR environment under the project.
	const createdEnv = runElectric(
		["environments", "create", "--project", projectId, "--name", environmentName, "--json"],
		{ secret: true },
	)
	if (createdEnv.exitCode !== 0) {
		fail(
			isAlreadyExists(createdEnv)
				? `Environment ${environmentName} still exists after reset — delete it manually and retry`
				: `Failed to create Electric environment ${environmentName}`,
		)
	}
	const environmentId = pick(parseJson(createdEnv.stdout, "environments create"), "id", "environment_id", "env_id")
	if (!environmentId) {
		fail("`electric environments create --json` returned no environment id")
	}

	// 3. Create the Postgres source pointed at the PR branch's direct connection.
	//    ELECTRIC_PUBLICATION / ELECTRIC_SERVICE_EXTRA_ARGS let ops select the
	//    existing `electric_publication_default` / manual-publishing mode (matching
	//    prod) once the exact flags are confirmed — see docs/electric-sync.md.
	const publicationArgs = process.env.ELECTRIC_PUBLICATION?.trim()
		? ["--publication", process.env.ELECTRIC_PUBLICATION.trim()]
		: []
	const extraArgs = (process.env.ELECTRIC_SERVICE_EXTRA_ARGS?.trim() || "").split(/\s+/).filter(Boolean)
	const createdSvc = runElectric(
		[
			"services",
			"create",
			"postgres",
			"--environment",
			environmentId as string,
			"--database-url",
			databaseUrl,
			"--region",
			region,
			...publicationArgs,
			...extraArgs,
			"--json",
		],
		{ secret: true },
	)
	if (createdSvc.exitCode !== 0) {
		fail(`Failed to create Electric Postgres source in environment ${environmentName}`)
	}
	const service = parseJson(createdSvc.stdout, "services create postgres")
	const serviceId = pick(service, "id", "service_id")
	let sourceId = pick(service, "source_id", "sourceId")
	let secret = pick(service, "secret", "source_secret", "sourceSecret")

	// 4. Fetch the source secret if `create` didn't already return it.
	if ((!sourceId || !secret) && serviceId) {
		const fetched = runElectric(["services", "get-secret", serviceId, "--json"], { secret: true })
		if (fetched.exitCode !== 0) {
			fail(`Failed to fetch the source secret for service ${serviceId}`)
		}
		const secretJson = parseJson(fetched.stdout, "services get-secret")
		sourceId = sourceId ?? pick(secretJson, "source_id", "sourceId", "id")
		secret = secret ?? pick(secretJson, "secret", "source_secret", "sourceSecret")
	}
	if (!sourceId || !secret) {
		fail("Could not resolve the Electric source_id + secret from the CLI output")
	}

	// 5. Hand the source creds to the rest of the workflow. alchemy binds these to
	//    the electric-sync worker; the proxy forwards them to {ELECTRIC_URL}/v1/shape.
	maskAndExport(
		{ ELECTRIC_URL: electricUrl, ELECTRIC_SOURCE_ID: sourceId as string, ELECTRIC_SECRET: secret as string },
		[secret as string],
	)
	console.log(`✓ Electric environment ${environmentName} ready; preview electric-sync will bind to it.`)
}

const down = (environmentName: string): void => {
	requireEnv("ELECTRIC_API_TOKEN")
	const projectId = requireEnv("ELECTRIC_PROJECT_ID")
	const environmentId = findEnvironmentId(projectId, environmentName)
	if (!environmentId) {
		console.log(`✓ Environment ${environmentName} removed (or already gone)`)
		return
	}
	const removed = runElectric(["environments", "delete", environmentId, "--force"])
	if (removed.exitCode !== 0 && !isNotFound(removed)) {
		fail(`Failed to delete Electric environment ${environmentName}`)
	}
	console.log(`✓ Environment ${environmentName} removed (or already gone)`)
}

const main = async (): Promise<void> => {
	const { subcommand, environmentName } = parseArgs()
	if (subcommand === "up") {
		await up(environmentName)
	} else {
		down(environmentName)
	}
}

await main()

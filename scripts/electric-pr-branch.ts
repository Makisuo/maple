#!/usr/bin/env bun
/**
 * Per-PR Electric Cloud environment lifecycle for the PR-preview deploy.
 * Sibling of scripts/planetscale-pr-branch.ts and scripts/tinybird-pr-branch.ts
 * with the same up/down contract.
 *
 *   bun scripts/electric-pr-branch.ts up   <pr-number>
 *   bun scripts/electric-pr-branch.ts down <pr-number>
 *
 * `up` ensures an Electric Cloud **environment** for this PR and (re)creates the
 * Postgres **service** (the sync "source") inside it, pointed at this PR's
 * PlanetScale branch. The environment is REUSED across deploys; only the
 * services are reset (deleted + recreated) each run — the service is what points
 * at the now-dropped tables/rotated creds after the PlanetScale in-place reset.
 * Environments are NOT delete+recreated because Electric soft-deletes them:
 * a deleted environment disappears from `environments list` immediately but its
 * name stays reserved (observed >13 min, possibly forever), so recreating
 * `pr-<n>` right after deleting it fails with "name already exists". If the
 * base name is stuck from an earlier delete, `up` falls back to a suffixed name
 * `pr-<n>-r<run-id>`; matching everywhere is by exact name OR `pr-<n>-` prefix.
 * It then exports `ELECTRIC_URL` / `ELECTRIC_SOURCE_ID` / `ELECTRIC_SECRET` to
 * $GITHUB_ENV so the subsequent `alchemy:deploy:pr` binds the standalone
 * apps/electric-sync worker to this source (see apps/electric-sync/alchemy.run.ts).
 *
 * `down` deletes every `pr-<n>`/`pr-<n>-*` environment (called on PR close,
 * after `alchemy:destroy:pr`). Environment deletion cascades its services. Each
 * source counts against the Electric plan's max-databases cap and holds a
 * PlanetScale replication slot, so `down` on close is mandatory.
 *
 * Depends on the PlanetScale `up` step having exported MAPLE_PG_URL (the direct
 * 5432 connection string) and the `drizzle-kit migrate` step having applied
 * `0009_electric_publication` (creates `electric_publication_default`).
 *
 * Auth: the Electric CLI (`@electric-sql/cli`) reads ELECTRIC_API_TOKEN
 * (`sv_live_...`) from the environment. Config:
 *   ELECTRIC_API_TOKEN            CLI auth token (required; also the workflow gate)
 *   ELECTRIC_PROJECT_ID           parent project id for the per-PR environment (required)
 *   MAPLE_PG_ELECTRIC_URL         PR branch connection string via the replication-
 *                                 attribute role (preferred; minted by planetscale-pr-branch.ts)
 *   MAPLE_PG_URL                  fallback connection string (required on `up` if the above is unset)
 *   ELECTRIC_CLOUD_URL            Cloud shape API base to export as ELECTRIC_URL (default
 *                                 https://api.electric-sql.cloud); deliberately NOT the
 *                                 local-dev `ELECTRIC_URL` (docker), which would be wrong here
 *   ELECTRIC_REGION               source region (default us-east-1; CLI accepts
 *                                 us-east-1 | eu-west-1 | ca-west-1)
 *   ELECTRIC_MANUAL_TABLE_PUBLISHING
 *                                 "false"/"0" disables the `--manual-table-publishing` flag
 *                                 (default ON — Electric must never need to own the tables
 *                                 on PlanetScale). NOTE: Electric Cloud does NOT read
 *                                 `electric_publication_default`; each Cloud source creates
 *                                 its own publication (`cloud_electric_pub_svc_<name>`) and
 *                                 manual publishing means WE must add the synced tables to
 *                                 THAT publication. After the source activates, this script
 *                                 mirrors the table list from the migration-owned
 *                                 `electric_publication_default` (0009/0011/0014) into the
 *                                 Cloud source's publication.
 *   ELECTRIC_SERVICE_EXTRA_ARGS   extra space-separated flags for `services create postgres`
 *   ELECTRIC_CLI                  override the CLI invocation (default pins the interface
 *                                 this script was written against: `bunx @electric-sql/cli@0.0.10`)
 *
 * CLI interface notes (verified against @electric-sql/cli 0.0.10 — bump the pin
 * only after re-verifying these):
 *   - `--json` / `-q` are GLOBAL options (root command); subcommands read them from
 *     the root, and commander accepts them before or after the subcommand.
 *   - `--json` errors go to STDERR as {"error","message","exitCode"}; exit codes are
 *     1 generic, 2 auth, 3 not-found, 4 validation, 5 conflict.
 *   - `environments create --json` prints { environmentId } (NOT `id`).
 *   - `environments list --project <id> --json` prints { environments: [{ id, name, createdAt }] }.
 *   - `environments delete <id> --force` (--force mandatory: --json mode and
 *     token-auth non-interactive mode both refuse to prompt).
 *   - `services create postgres --environment <id> --database-url <url> --region <r>`
 *     supports --manual-table-publishing (no `--publication <name>` flag exists; the
 *     Cloud source generates its own publication named `cloud_electric_pub_svc_<name>`) and
 *     --wait (poll until active, 300s default). Its --json result carries
 *     { id, status, sourceSecret } — the service id IS the shape-API source_id.
 *   - `services get-secret <id> --json` prints { secret }.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down"

const FAILURE = 1
// Short grace for eventual consistency on env-name conflicts before falling
// back to a suffixed name (the base name may be soft-delete-reserved for good).
const CREATE_RETRY_ATTEMPTS = 3
const CREATE_RETRY_MS = 5_000
// Own activation poll (the CLI's --wait caps at 300s and discards state on timeout).
const ACTIVE_TIMEOUT_MS = 10 * 60 * 1000
const ACTIVE_POLL_MS = 10_000
// The Cloud source creates its publication around activation; brief poll for it.
const PUBLICATION_TIMEOUT_MS = 2 * 60 * 1000
const PUBLICATION_POLL_MS = 5_000
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
	const [program, ...prefix] = (process.env.ELECTRIC_CLI?.trim() || "bunx @electric-sql/cli@0.0.10").split(
		/\s+/,
	)
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

// CLI exit codes (v0.0.10): 3 = not found, 5 = conflict. Text matching kept as a
// fallback for messages surfaced with a generic exit code.
const EXIT_NOT_FOUND = 3
const EXIT_CONFLICT = 5

const isNotFound = (result: CliResult): boolean =>
	result.exitCode === EXIT_NOT_FOUND ||
	/"error":\s*"NOT_FOUND"|not found|does not exist|no such|unknown environment/i.test(
		`${result.stdout}\n${result.stderr}`,
	)

const isAlreadyExists = (result: CliResult): boolean =>
	result.exitCode === EXIT_CONFLICT ||
	/"error":\s*"CONFLICT"|already exists|already been taken|name is taken|duplicate/i.test(
		`${result.stdout}\n${result.stderr}`,
	)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface SqlClient {
	(strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>>
	end: () => Promise<void>
}

// Bun's built-in Postgres client — avoids a workspace dep from a root script.
// Non-literal specifier so tsc doesn't require bun-types to resolve it.
const openSql = async (url: string): Promise<SqlClient> => {
	const bunSpecifier = "bun"
	const { SQL } = (await import(bunSpecifier)) as { SQL: new (url: string) => SqlClient }
	return new SQL(url)
}

/** Log the branch's replication slots — tells us whether Electric ever got one in. */
const logReplicationSlots = async (databaseUrl: string): Promise<void> => {
	try {
		const sql = await openSql(databaseUrl)
		try {
			const slots = await sql`
				SELECT slot_name, slot_type, active, failover, synced,
				       wal_status, invalidation_reason
				FROM pg_replication_slots`
			console.log(`ℹ replication slots: ${JSON.stringify(slots)}`)
		} finally {
			await sql.end()
		}
	} catch (error) {
		console.log(`ℹ slot inspection failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}

/**
 * Mirror the synced-table list into Electric Cloud's per-service publication.
 *
 * With `--manual-table-publishing`, Electric Cloud does NOT read
 * `electric_publication_default` — each Cloud source creates its own publication
 * (`cloud_electric_pub_svc_<name>`) and refuses to add tables to it, so a shape
 * request for an unpublished table fails with `Database table "public.<t>" is
 * missing from the publication "cloud_electric_pub_svc_..." and the
 * ELECTRIC_MANUAL_TABLE_PUBLISHING setting prevents Electric from adding it`.
 * The drizzle migrations (0009/0011/0014) keep `electric_publication_default`
 * as the source of truth for which tables sync, so we copy its membership into
 * every cloud publication here. We connect as the same role Electric does (the
 * URL handed to `services create`), so we own the cloud publication. Adding a
 * table additionally requires OWNING the table, and the synced tables are owned
 * by the ephemeral migrate-step pscale role — so the block first assumes each
 * table-owner role via `GRANT <owner> TO CURRENT_USER` (the same trick
 * reset-preview-branch.ts uses; it works because every pscale role inherits
 * `postgres`, which holds admin over the ephemeral roles). The whole copy runs
 * server-side in one DO block (identifier quoting via format(%I), no string
 * interpolation) and is idempotent.
 */
const publishTablesToCloudPublications = async (databaseUrl: string): Promise<void> => {
	const sql = await openSql(databaseUrl)
	try {
		const wanted = await sql`
			SELECT schemaname, tablename FROM pg_publication_tables
			WHERE pubname = 'electric_publication_default'`
		if (wanted.length === 0) {
			fail(
				"electric_publication_default has no tables — did the drizzle migrations (0009_electric_publication et al.) run against this branch?",
			)
		}
		// The cloud publication appears when the source finishes provisioning;
		// poll briefly in case activation raced ahead of it.
		const deadline = Date.now() + PUBLICATION_TIMEOUT_MS
		let publications: Array<Record<string, unknown>> = []
		for (;;) {
			publications = await sql`
				SELECT pubname FROM pg_publication WHERE pubname LIKE 'cloud\\_electric\\_pub\\_%'`
			if (publications.length > 0) break
			if (Date.now() >= deadline) {
				return fail(
					"Electric Cloud never created its cloud_electric_pub_svc_* publication on the branch — cannot publish the synced tables",
				)
			}
			await sleep(PUBLICATION_POLL_MS)
		}
		await sql`
			DO $$
			DECLARE own record; pub record; tbl record;
			BEGIN
				-- Assume every role owning a synced table that we don't already hold
				-- (directly or by inheritance) — ALTER PUBLICATION ... ADD TABLE
				-- requires table ownership. Best-effort per role; a genuinely missing
				-- grant surfaces as the ALTER's own error below.
				FOR own IN
					SELECT DISTINCT r.rolname
					FROM pg_publication_tables pt
					JOIN pg_namespace n ON n.nspname = pt.schemaname
					JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pt.tablename
					JOIN pg_roles r ON r.oid = c.relowner
					WHERE pt.pubname = 'electric_publication_default'
						AND NOT pg_has_role(current_user, r.oid, 'USAGE')
						AND r.rolname NOT LIKE 'pg\\_%'
				LOOP
					BEGIN
						EXECUTE format('GRANT %I TO CURRENT_USER', own.rolname);
						RAISE NOTICE 'assumed table-owner role %', own.rolname;
					EXCEPTION WHEN OTHERS THEN
						RAISE NOTICE 'could not assume table-owner role %: %', own.rolname, SQLERRM;
					END;
				END LOOP;

				FOR pub IN SELECT pubname FROM pg_publication WHERE pubname LIKE 'cloud\\_electric\\_pub\\_%' LOOP
					FOR tbl IN
						SELECT schemaname, tablename FROM pg_publication_tables
						WHERE pubname = 'electric_publication_default'
						EXCEPT
						SELECT schemaname, tablename FROM pg_publication_tables
						WHERE pubname = pub.pubname
					LOOP
						EXECUTE format('ALTER PUBLICATION %I ADD TABLE %I.%I', pub.pubname, tbl.schemaname, tbl.tablename);
					END LOOP;
				END LOOP;
			END $$`
		const membership = await sql`
			SELECT pubname, count(*)::int AS tables FROM pg_publication_tables
			WHERE pubname LIKE 'cloud\\_electric\\_pub\\_%' GROUP BY pubname`
		console.log(
			`✓ Published ${wanted.length} synced tables to the cloud publication(s): ${JSON.stringify(membership)}`,
		)
	} catch (error) {
		fail(
			`Failed to publish synced tables to the Electric Cloud publication: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		await sql.end()
	}
}

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
		for (const key of ["environments", "services", "data", "items", "results"]) {
			const nested = (value as Record<string, unknown>)[key]
			if (Array.isArray(nested)) return nested
		}
	}
	return []
}

/** `pr-<n>` itself plus suffix-fallback names (`pr-<n>-r123`); never `pr-<n>7`. */
const matchesEnvironmentName = (base: string, name: string | undefined): boolean =>
	name === base || (name !== undefined && name.startsWith(`${base}-`))

/** All environments whose name is `base` or `base-*`, oldest-listed first. */
const findEnvironments = (projectId: string, base: string): ReadonlyArray<{ id: string; name: string }> => {
	// `--project` is a required option; output shape: { environments: [{ id, name, createdAt }] }.
	const listed = runElectric(["environments", "list", "--project", projectId, "--json"], { secret: true })
	if (listed.exitCode !== 0) {
		return isNotFound(listed)
			? []
			: fail(`Failed to list Electric environments (exit ${listed.exitCode})`)
	}
	return asArray(parseJson(listed.stdout, "environments list")).flatMap((entry) => {
		const id = pick(entry, "id", "environmentId")
		const name = pick(entry, "name")
		return id && matchesEnvironmentName(base, name) ? [{ id, name: name as string }] : []
	})
}

const deleteEnvironment = (env: { id: string; name: string }): void => {
	const removed = runElectric(["environments", "delete", env.id, "--force"])
	if (removed.exitCode !== 0 && !isNotFound(removed)) {
		fail(`Failed to delete Electric environment ${env.name} (${env.id})`)
	}
}

/** Delete every service in the environment (the reused env's stale sources). */
const resetServices = (environmentId: string): void => {
	const listed = runElectric(["services", "list", "--environment", environmentId, "--json"], {
		secret: true,
	})
	if (listed.exitCode !== 0) {
		if (isNotFound(listed)) return
		fail(`Failed to list services in environment ${environmentId}`)
	}
	for (const entry of asArray(parseJson(listed.stdout, "services list"))) {
		const serviceId = pick(entry, "id", "serviceId")
		if (!serviceId) continue
		const removed = runElectric(["services", "delete", serviceId, "--force"])
		if (removed.exitCode !== 0 && !isNotFound(removed)) {
			fail(`Failed to delete stale Electric service ${serviceId}`)
		}
	}
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
	// Prefer the replication-attribute credential (MAPLE_PG_ELECTRIC_URL, minted
	// separately because the main CI role must stay non-replication for the
	// in-place reset to work); fall back to MAPLE_PG_URL for older wiring.
	// Electric Cloud's create-source input validation wants the long
	// `postgresql://` scheme and accepts `?sslmode=require` — NOT `verify-full`
	// (rejected as "Input validation failed") and not a bare URL either (passes
	// input validation, then the server's TLS-less probe of PlanetScale draws
	// "Database validation failed"). See electric.ax/docs/sync/integrations/planetscale.
	// planetscale-pr-branch.ts emits `postgres://...?sslmode=verify-full`.
	const databaseUrl = (process.env.MAPLE_PG_ELECTRIC_URL?.trim() || requireEnv("MAPLE_PG_URL"))
		.replace(/^postgres:\/\//, "postgresql://")
		.replace(/([?&])sslmode=[^&]*/, "$1sslmode=require")
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

	// 1.+2. Resolve the per-PR environment: REUSE an existing one (resetting its
	//    services — they point at the now-recreated PlanetScale branch with dropped
	//    tables + rotated creds), or create a fresh one. Never delete+recreate the
	//    environment itself: deletion soft-reserves the name (see header) and the
	//    recreate would conflict.
	const existing = findEnvironments(projectId, environmentName)
	let environmentId: string
	if (existing.length > 0) {
		const [reused, ...extras] = existing as [{ id: string; name: string }, ...typeof existing]
		environmentId = reused.id
		console.log(`✓ Reusing Electric environment ${reused.name}; resetting its services`)
		// Extras are leftovers from earlier suffix fallbacks — free their caps/slots.
		for (const extra of extras) deleteEnvironment(extra)
		resetServices(environmentId)
	} else {
		// Create the base name; brief retry for eventual consistency, then fall back
		// to a unique suffixed name if the base is soft-delete-reserved.
		let createdEnv = runElectric(
			["environments", "create", "--project", projectId, "--name", environmentName, "--json"],
			{ secret: true },
		)
		for (let attempt = 0; createdEnv.exitCode !== 0 && isAlreadyExists(createdEnv); attempt++) {
			if (attempt >= CREATE_RETRY_ATTEMPTS) {
				const fallbackName = `${environmentName}-r${process.env.GITHUB_RUN_ID?.trim() || Date.now()}`
				console.log(`… name ${environmentName} is reserved by a deleted environment; using ${fallbackName}`)
				createdEnv = runElectric(
					["environments", "create", "--project", projectId, "--name", fallbackName, "--json"],
					{ secret: true },
				)
				break
			}
			console.log(`… name ${environmentName} reported as existing but not listed; retrying create`)
			await sleep(CREATE_RETRY_MS)
			createdEnv = runElectric(
				["environments", "create", "--project", projectId, "--name", environmentName, "--json"],
				{ secret: true },
			)
		}
		if (createdEnv.exitCode !== 0) {
			fail(`Failed to create Electric environment ${environmentName}`)
		}
		// v0.0.10 prints { environmentId } — the bare `id` spellings are kept as fallbacks
		// in case a future CLI aligns with its own README (which documents `.id`).
		const created = pick(
			parseJson(createdEnv.stdout, "environments create"),
			"environmentId",
			"id",
			"environment_id",
		)
		if (!created) {
			fail("`electric environments create --json` returned no environment id")
		}
		environmentId = created as string
	}

	// 3. Create the Postgres source pointed at the PR branch's direct connection.
	//    Manual table publishing (Electric must never need to own the tables on
	//    PlanetScale) is the default; set ELECTRIC_MANUAL_TABLE_PUBLISHING=false
	//    to let Electric auto-manage publishing. Note the Cloud source creates its
	//    OWN publication (cloud_electric_pub_svc_<name>) — step 3c mirrors the
	//    migration-owned table list into it. `--wait` blocks until the service is active so the
	//    alchemy deploy right after binds to a live source (CLI default 300s cap).
	// Electric's create-source probe requires the connecting role to carry the
	// REPLICATION *attribute* (never inherited through role membership — the
	// `--inherited-roles postgres` grant alone leaves rolreplication=false and
	// Electric answers a bare "Database validation failed"). The credential is
	// minted with `pscale role create --with-replication` in
	// planetscale-pr-branch.ts; verify here so a regression fails with a precise
	// message instead of Electric's opaque one. In-place ALTER is NOT possible:
	// both direct ALTER and SET ROLE postgres get "permission denied to alter
	// role" on PlanetScale.
	{
		const sql = await openSql(databaseUrl)
		try {
			const [row] = await sql`SELECT rolreplication FROM pg_roles WHERE rolname = current_user`
			if (row?.rolreplication !== true) {
				fail(
					"CI role lacks the REPLICATION attribute — ensure planetscale-pr-branch.ts mints it with `--with-replication` (Electric's database validation rejects the source otherwise)",
				)
			}
			console.log("✓ CI role carries REPLICATION")
			// Electric creates FAILOVER-enabled slots; PlanetScale demands these two
			// settings for that (electric.ax/docs/integrations/planetscale). Log the
			// full checklist so a rejected/stuck source is explainable from the step
			// log alone.
			const [settings] = await sql`
				SELECT current_setting('wal_level') AS wal_level,
				       current_setting('sync_replication_slots') AS sync_replication_slots,
				       current_setting('hot_standby_feedback') AS hot_standby_feedback,
				       current_setting('max_connections') AS max_connections,
				       (SELECT count(*)::int FROM pg_publication WHERE pubname = 'electric_publication_default') AS publication`
			console.log(`ℹ cluster settings: ${JSON.stringify(settings)}`)
			// Dry-run the thing Electric actually needs: create (and drop) a logical
			// slot. If this fails, its error text is the real reason behind
			// Electric's opaque "Database validation failed".
			try {
				await sql`SELECT pg_create_logical_replication_slot('maple_ci_probe', 'pgoutput')`
				await sql`SELECT pg_drop_replication_slot('maple_ci_probe')`
				console.log("✓ logical replication slot probe succeeded")
			} catch (error) {
				console.log(
					`⚠ logical slot probe failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} catch (error) {
			fail(
				`Could not verify REPLICATION on the branch role: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			await sql.end()
		}
	}

	const manualPublishing = !/^(false|0)$/i.test(process.env.ELECTRIC_MANUAL_TABLE_PUBLISHING?.trim() ?? "")
	const extraArgs = (process.env.ELECTRIC_SERVICE_EXTRA_ARGS?.trim() || "").split(/\s+/).filter(Boolean)
	// Create WITHOUT the CLI's `--wait` (hard 300s cap that discards the service
	// state on timeout — run 30037847577); capture id+secret immediately, then
	// poll `services get` ourselves with a longer budget, logging status
	// transitions and dumping the non-secret service state if it never activates.
	const createdSvc = runElectric(
		[
			"services",
			"create",
			"postgres",
			"--environment",
			environmentId,
			"--database-url",
			databaseUrl,
			"--region",
			region,
			...(manualPublishing ? ["--manual-table-publishing"] : []),
			// Electric's default pool is 20 connections; the PR branch may be stuck
			// at PlanetScale's max_connections=25 (raising it needs a branch resize
			// the CI token may not be allowed to make), so keep the pool small.
			"--db-pool-size",
			process.env.ELECTRIC_DB_POOL_SIZE?.trim() || "5",
			...extraArgs,
			"--json",
		],
		{ secret: true },
	)
	if (createdSvc.exitCode !== 0) {
		fail(`Failed to create Electric Postgres source in environment ${environmentName}`)
	}
	// v0.0.10 result: { id, status, sourceSecret } — the postgres service IS the
	// shape-API source, so its id is the `source_id` the sync worker forwards.
	const service = parseJson(createdSvc.stdout, "services create postgres")
	const sourceId = pick(service, "id", "serviceId", "sourceId")
	let secret = pick(service, "sourceSecret", "secret", "source_secret")

	// 3b. Wait for the service to become active before the alchemy deploy binds it.
	if (sourceId) {
		const deadline = Date.now() + ACTIVE_TIMEOUT_MS
		let lastStatus = pick(service, "status") ?? "unknown"
		console.log(`… service ${sourceId} status: ${lastStatus}`)
		while (lastStatus !== "active") {
			if (lastStatus === "error" || Date.now() >= deadline) {
				await logReplicationSlots(databaseUrl)
				const got = runElectric(["services", "get", sourceId, "--json"], { secret: true })
				const detail = got.exitCode === 0 ? parseJson(got.stdout, "services get") : undefined
				const summary = ["status", "name", "type", "region", "error", "errorMessage", "statusMessage"]
					.map((key) => [key, pick(detail, key)] as const)
					.filter(([, value]) => value !== undefined)
					.map(([key, value]) => `${key}=${value}`)
					.join(" ")
				fail(
					lastStatus === "error"
						? `Electric source ${sourceId} entered error state (${summary})`
						: `Timed out waiting for Electric source ${sourceId} to activate (last: ${summary || lastStatus})`,
				)
			}
			await sleep(ACTIVE_POLL_MS)
			const polled = runElectric(["services", "get", sourceId, "--json"], { secret: true })
			const status = polled.exitCode === 0 ? pick(parseJson(polled.stdout, "services get"), "status") : undefined
			if (status && status !== lastStatus) {
				console.log(`… service ${sourceId} status: ${status}`)
				lastStatus = status
			} else if (status) {
				lastStatus = status
			}
		}
		console.log(`✓ Electric source ${sourceId} is active`)
	}

	// 3c. Manual table publishing: add the synced tables to the Cloud source's
	//     own publication (it ignores `electric_publication_default` — see the
	//     helper's doc comment). Without this every shape request 400s with
	//     "missing from the publication cloud_electric_pub_svc_...".
	if (manualPublishing) {
		await publishTablesToCloudPublications(databaseUrl)
	}

	// 4. Fetch the source secret if `create` didn't already return it.
	if (!secret && sourceId) {
		const fetched = runElectric(["services", "get-secret", sourceId, "--json"], { secret: true })
		if (fetched.exitCode !== 0) {
			fail(`Failed to fetch the source secret for service ${sourceId}`)
		}
		secret = pick(parseJson(fetched.stdout, "services get-secret"), "secret", "sourceSecret")
	}
	if (!sourceId || !secret) {
		fail("Could not resolve the Electric source_id + secret from the CLI output")
	}

	// 5. Hand the source creds to the rest of the workflow. alchemy binds these to
	//    the electric-sync worker; the proxy forwards them to {ELECTRIC_URL}/v1/shape.
	maskAndExport(
		{
			ELECTRIC_URL: electricUrl,
			ELECTRIC_SOURCE_ID: sourceId as string,
			ELECTRIC_SECRET: secret as string,
		},
		[secret as string],
	)
	console.log(`✓ Electric environment ${environmentName} ready; preview electric-sync will bind to it.`)
}

const down = (environmentName: string): void => {
	requireEnv("ELECTRIC_API_TOKEN")
	const projectId = requireEnv("ELECTRIC_PROJECT_ID")
	// Delete the base env AND any suffix-fallback envs (`pr-<n>-r*`).
	for (const env of findEnvironments(projectId, environmentName)) {
		deleteEnvironment(env)
	}
	console.log(`✓ Environment(s) ${environmentName}* removed (or already gone)`)
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

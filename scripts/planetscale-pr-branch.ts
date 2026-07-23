#!/usr/bin/env bun
/**
 * Per-PR PlanetScale Postgres branch lifecycle for the PR-preview deploy.
 * Sibling of scripts/tinybird-pr-branch.ts with the same up/down contract.
 *
 *   bun scripts/planetscale-pr-branch.ts up    <pr-number>
 *   bun scripts/planetscale-pr-branch.ts down  <pr-number>
 *   bun scripts/planetscale-pr-branch.ts sweep
 *
 * `up` ensures an ephemeral PlanetScale branch `pr-<n>` exists and is EMPTY,
 * mints a branch credential, and exports `MAPLE_PG_URL` (one connection string,
 * direct 5432) to $GITHUB_ENV — alchemy.run.ts parses it into the pr Hyperdrive
 * origin, and the `drizzle-kit migrate` workflow step uses it as-is.
 *
 * Provisioning a PS-DEV Postgres branch takes ~9 minutes, so `up` only CREATES
 * the branch on the PR's first deploy. Subsequent deploys reuse the branch and
 * reset it in SQL (packages/db scripts/reset-preview-branch.ts — drops the
 * drizzle + public schemas, publications, and stale replication slots), which
 * takes seconds and leaves migrate replaying onto an effectively fresh DB. If
 * that reset fails for any reason we fall back to the old delete → recreate
 * path, so it can only cost time, never correctness.
 *
 * `pscale branch create --wait` enforces its OWN ~10-minute cap and exits
 * non-zero with "branch creation timed out" while the branch keeps provisioning
 * server-side — so a create timeout is treated as non-fatal and we keep polling
 * `branch show` ourselves.
 *
 * `down` deletes the branch (called on PR close, after `alchemy:destroy:pr`,
 * which removes the Hyperdrive config). Branch deletion also revokes its
 * credentials. PS-DEV branches bill for time used, so `down` on close is
 * mandatory.
 *
 * `sweep` deletes every `pr-<n>` branch whose PR is already closed. The
 * close-event teardown is best-effort only — GitHub silently creates NO
 * `pull_request: closed` run for a PR that conflicts with its base (so stale
 * PRs closed without merging never tear down), and close runs on old branches
 * execute the branch's own (possibly pre-fix) workflow version. The scheduled
 * cleanup-preview-orphans workflow runs `sweep` as the safety net for
 * everything the event-driven path misses.
 *
 * `up` additionally refuses to provision when the PR is already closed (when a
 * GitHub token is available to check) — a delayed/re-run deploy landing after
 * the close-event teardown would otherwise silently recreate the branch with
 * nothing left to ever delete it.
 *
 * Auth: PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN (the pscale
 * CLI reads both from the environment) + PLANETSCALE_ORG. The database name
 * comes from PLANETSCALE_DATABASE (default "maple").
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

type Subcommand = "up" | "down" | "sweep"

const FAILURE = 1
// Our own polling budget on top of `pscale branch create --wait`'s built-in
// ~10-minute cap: a PS-DEV branch usually provisions in ~9 minutes but has been
// observed to exceed 10, so give the show-poll another 15.
const READY_TIMEOUT_MS = 15 * 60 * 1000
const READY_POLL_MS = 10_000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const parseArgs = (): { subcommand: Subcommand; prNumber: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down" && rawSubcommand !== "sweep") {
		fail(
			`Usage: bun scripts/planetscale-pr-branch.ts <up|down> <pr-number> | sweep (got "${rawSubcommand ?? ""}")`,
		)
	}
	if (rawSubcommand === "sweep") {
		return { subcommand: "sweep", prNumber: "" }
	}
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand as Subcommand, prNumber }
}

interface CliResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

const runPscale = (args: string[], opts?: { secret?: boolean }): CliResult => {
	// `--org` only when set; otherwise use the CLI's configured org (`pscale org switch`).
	const org = process.env.PLANETSCALE_ORG?.trim()
	const orgArgs = org ? ["--org", org] : []
	const proc = spawnSync("pscale", [...args, ...orgArgs], { encoding: "utf8" })
	if (proc.error) {
		fail(`Failed to invoke \`pscale\` — is the PlanetScale CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	console.log(`$ pscale ${args.join(" ")}`)
	// `secret` suppresses stdout — credential JSON must never reach the CI log.
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
		if (stderr) console.error(stderr)
	} else if (stderr) {
		console.error(stderr)
	}
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isAlreadyExists = (result: CliResult): boolean =>
	// PlanetScale's message is "Name has already been taken"; also tolerate other phrasings.
	/already exists|already been taken|name is taken|duplicate/i.test(`${result.stdout}\n${result.stderr}`)

const isNotFound = (result: CliResult): boolean =>
	/not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)

// `pscale branch create --wait` gives up after ~10 minutes with this message
// while the branch continues provisioning server-side. Not a failure — we take
// over the waiting with our own `branch show` poll.
const isCreateWaitTimeout = (result: CliResult): boolean =>
	/timed out/i.test(`${result.stdout}\n${result.stderr}`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Cluster parameters Electric Cloud requires of the branch
 * (electric.ax/docs/integrations/planetscale): failover-capable replication
 * slots (Electric always creates its slot with failover=true) and headroom for
 * its 20-connection pool. Fresh PS-DEV branches ship sync_replication_slots=off,
 * hot_standby_feedback=off, max_connections=25 — Electric's source then hangs in
 * `pending` forever. Applied via `pscale branch resize --parameters` (queues a
 * change request; may restart the cluster), skipped when already satisfied.
 */
const ELECTRIC_PGCONF: ReadonlyArray<{ key: string; want: string; atLeast?: number }> = [
	{ key: "sync_replication_slots", want: "on" },
	{ key: "hot_standby_feedback", want: "on" },
	{ key: "max_connections", want: "100", atLeast: 100 },
]
const PARAMS_APPLY_TIMEOUT_MS = 5 * 60 * 1000
const PARAMS_POLL_MS = 10_000

// Bun's built-in Postgres client (non-literal specifier so tsc doesn't need bun-types).
const readSettings = async (connectionUrl: string): Promise<Map<string, string>> => {
	const bunSpecifier = "bun"
	const { SQL } = (await import(bunSpecifier)) as {
		SQL: new (url: string) => {
			(strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>>
			end: () => Promise<void>
		}
	}
	const sql = new SQL(connectionUrl)
	try {
		const [row] = await sql`
			SELECT current_setting('sync_replication_slots') AS sync_replication_slots,
			       current_setting('hot_standby_feedback') AS hot_standby_feedback,
			       current_setting('max_connections') AS max_connections`
		return new Map(Object.entries(row ?? {}).map(([key, value]) => [key, String(value)]))
	} finally {
		await sql.end()
	}
}

const unsatisfied = (settings: Map<string, string>) =>
	ELECTRIC_PGCONF.filter(({ key, want, atLeast }) => {
		const current = settings.get(key)
		if (current === undefined) return true
		return atLeast !== undefined ? Number(current) < atLeast : current !== want
	})

const ensureClusterParameters = async (
	database: string,
	branchName: string,
	connectionUrl: string,
): Promise<void> => {
	const missing = unsatisfied(await readSettings(connectionUrl))
	if (missing.length === 0) {
		console.log("✓ Electric cluster parameters already satisfied")
		return
	}
	console.log(`… applying cluster parameters: ${missing.map((p) => `${p.key}=${p.want}`).join(", ")}`)
	const resized = runPscale([
		"branch",
		"resize",
		database,
		branchName,
		...missing.flatMap((p) => ["--parameters", `pgconf.${p.key}=${p.want}`]),
		"--wait",
	])
	if (resized.exitCode === 0) {
		// The change may restart the cluster; poll until the live settings reflect it.
		const deadline = Date.now() + PARAMS_APPLY_TIMEOUT_MS
		for (;;) {
			try {
				if (unsatisfied(await readSettings(connectionUrl)).length === 0) {
					console.log("✓ Electric cluster parameters applied")
					return
				}
			} catch {
				// Transient connect failures during the restart window are expected.
			}
			if (Date.now() >= deadline) {
				return fail(`Cluster parameters did not take effect on branch ${branchName} in time`)
			}
			await sleep(PARAMS_POLL_MS)
		}
	}
	// The CI service token may lack branch-change permission ("User does not have
	// permission to perform this action"). Fall back to ALTER SYSTEM for the
	// SIGHUP-reloadable settings (works as `postgres`; max_connections needs a
	// restart and stays out of reach — the Electric source compensates with a
	// small --db-pool-size). Non-fatal: previews should deploy either way, and
	// granting the token resize access later self-heals this path.
	console.log("… branch resize not permitted; trying ALTER SYSTEM for reloadable settings")
	try {
		const bunSpecifier = "bun"
		const { SQL } = (await import(bunSpecifier)) as {
			SQL: new (opts: { url: string; max: number }) => {
				(strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>>
				unsafe: (query: string) => Promise<unknown>
				end: () => Promise<void>
			}
		}
		// max:1 pins a single session: SET ROLE must apply to the same connection
		// the ALTER SYSTEM statements run on (which also cannot be batched — an
		// implicit multi-statement transaction would reject ALTER SYSTEM).
		const sql = new SQL({ url: connectionUrl, max: 1 })
		try {
			await sql`SET ROLE postgres`
			for (const { key, want, atLeast } of missing) {
				if (atLeast !== undefined) continue // restart-required (max_connections) — skip
				await sql.unsafe(`ALTER SYSTEM SET ${key} = '${want}'`)
			}
			await sql`SELECT pg_reload_conf()`
		} finally {
			await sql.end()
		}
		await sleep(2_000)
		const still = unsatisfied(await readSettings(connectionUrl))
		console.log(
			still.length === 0
				? "✓ Electric cluster parameters applied via ALTER SYSTEM"
				: `⚠ cluster parameters still unsatisfied: ${still.map((p) => p.key).join(", ")} — Electric sync may stay pending (grant the PlanetScale service token branch-resize access to fix permanently)`,
		)
	} catch (error) {
		console.log(
			`⚠ ALTER SYSTEM fallback failed (${error instanceof Error ? error.message : String(error)}) — Electric sync may stay pending`,
		)
	}
}

const waitUntilReady = async (database: string, branchName: string): Promise<void> => {
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (Date.now() < deadline) {
		const show = runPscale(["branch", "show", database, branchName, "--format", "json"], { secret: true })
		if (show.exitCode === 0) {
			try {
				const parsed = JSON.parse(show.stdout) as { ready?: boolean; state?: string }
				if (parsed.ready === true || parsed.state === "ready") {
					console.log(`✓ Branch ${branchName} is ready`)
					return
				}
				console.log(`… branch ${branchName} not ready yet (state=${parsed.state ?? "unknown"})`)
			} catch {
				console.log("… could not parse branch state; retrying")
			}
		}
		await sleep(READY_POLL_MS)
	}
	fail(`Timed out waiting for branch ${branchName} to become ready`)
}

const waitUntilGone = async (database: string, branchName: string): Promise<void> => {
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (Date.now() < deadline) {
		const show = runPscale(["branch", "show", database, branchName, "--format", "json"], { secret: true })
		if (show.exitCode !== 0 && isNotFound(show)) {
			console.log(`✓ Branch ${branchName} deleted`)
			return
		}
		console.log(`… waiting for branch ${branchName} to finish deleting`)
		await sleep(READY_POLL_MS)
	}
	fail(`Timed out waiting for branch ${branchName} to delete`)
}

interface BranchCredential {
	readonly host: string
	readonly username: string
	readonly password: string
	/** Ready-made connection URL (connect dbname is `postgres`, not the PS resource name). */
	readonly url: string
}

/**
 * Mint a Postgres ROLE for the preview branch (`pscale password` is Vitess-only).
 * The CI credential runs migrations (DDL) AND backs the preview app, so it
 * inherits `postgres`. It must NOT carry `--with-replication`: PlanetScale does
 * not make replication-attribute roles grantable, so the NEXT deploy's role
 * cannot assume it ("permission denied to grant role") and the in-place reset
 * degrades to the ~9-min delete → recreate path on every push. Electric gets its
 * own replication-attribute role instead (mintReplicationCredential). The branch
 * is deleted on PR close, which revokes the roles — but a TTL is a safety net in
 * case `down` never runs. JSON field names have drifted across CLI releases, so
 * accept the known spellings.
 */
const createCredential = (
	database: string,
	branchName: string,
	opts?: { readonly replication?: boolean; readonly suffix?: string },
): BranchCredential => {
	// Unique per run so it never collides with a residual role on the freshly
	// recreated branch. Roles carry a 24h TTL and are revoked when the branch is
	// deleted (on the next deploy's reset, or on PR close).
	const roleName = `ci-${branchName}-${process.pid}-${Date.now()}${opts?.suffix ?? ""}`
	const result = runPscale(
		[
			"role",
			"create",
			database,
			branchName,
			roleName,
			"--inherited-roles",
			"postgres",
			...(opts?.replication ? ["--with-replication"] : []),
			"--ttl",
			"24h",
			"--format",
			"json",
		],
		{ secret: true },
	)
	if (result.exitCode !== 0) {
		fail(`Could not mint a role for branch ${branchName}`)
	}
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(result.stdout) as Record<string, unknown>
	} catch {
		return fail("Could not parse `pscale role create --format json` output")
	}
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = parsed[key]
			if (typeof value === "string" && value.length > 0) return value
		}
		return undefined
	}
	const host = pick("access_host_url", "host", "hostname")
	const username = pick("username", "user", "name")
	const password = pick("plain_text", "password", "plaintext")
	if (!host || !username || !password) {
		return fail(`role JSON missing connection fields (got keys: ${Object.keys(parsed).join(", ")})`)
	}
	// Connect-time dbname is `postgres` (cluster default), NOT the PS resource
	// name — prefer the URL the CLI returns, else build one with dbname=postgres.
	const url =
		pick("database_url", "connection_string") ??
		`postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=verify-full`
	return { host, username, password, url }
}

const maskAndExport = (entries: Record<string, string>, secrets: ReadonlyArray<string>) => {
	for (const secret of secrets) {
		console.log(`::add-mask::${secret}`)
	}
	const githubEnv = process.env.GITHUB_ENV
	if (!githubEnv) {
		fail("GITHUB_ENV is not set — this script is meant to run in GitHub Actions")
	}
	const lines = Object.entries(entries)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")
	appendFileSync(githubEnv as string, `${lines}\n`)
	console.log(`✓ Exported ${Object.keys(entries).join(", ")} to GITHUB_ENV`)
}

/**
 * PR state via the GitHub REST API. Returns "unknown" when no token/repo is
 * available (local runs) or the API call fails — callers must treat "unknown"
 * as "don't block", never as "closed".
 */
const fetchPrState = async (prNumber: string): Promise<"open" | "closed" | "unknown"> => {
	const repo = process.env.GITHUB_REPOSITORY?.trim()
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	if (!repo || !token) return "unknown"
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		})
		if (!response.ok) {
			console.log(`⚠ Could not look up PR #${prNumber} state (HTTP ${response.status})`)
			return "unknown"
		}
		const parsed = (await response.json()) as { state?: string }
		return parsed.state === "open" ? "open" : parsed.state === "closed" ? "closed" : "unknown"
	} catch (error) {
		console.log(
			`⚠ Could not look up PR #${prNumber} state (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
}

/**
 * Delete every `pr-<n>` branch whose PR is closed. Only branches matching the
 * exact `pr-<digits>` shape are considered — `main`, `stg`, and anything else
 * are never candidates. Branches whose PR state cannot be determined are
 * skipped (deleting on uncertainty risks tearing down a live preview).
 */
const sweepOrphanBranches = async (database: string): Promise<void> => {
	const list = runPscale(["branch", "list", database, "--format", "json"], { secret: true })
	if (list.exitCode !== 0) {
		fail(`Could not list branches of database ${database}`)
	}
	let branches: ReadonlyArray<{ name?: string }>
	try {
		branches = JSON.parse(list.stdout) as ReadonlyArray<{ name?: string }>
	} catch {
		return fail("Could not parse `pscale branch list --format json` output")
	}
	const candidates = branches
		.map((branch) => branch.name ?? "")
		.map((name) => ({ name, match: /^pr-(\d+)$/.exec(name) }))
		.filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
	console.log(`Found ${candidates.length} pr-* branch(es): ${candidates.map((c) => c.name).join(", ") || "—"}`)

	const failures: string[] = []
	for (const { name, match } of candidates) {
		const state = await fetchPrState(match[1] as string)
		if (state === "open") {
			console.log(`… keeping ${name} (PR #${match[1]} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${name} (PR #${match[1]} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${name} (PR #${match[1]} is closed)`)
		const remove = runPscale(["branch", "delete", database, name, "--force"])
		if (remove.exitCode !== 0 && !isNotFound(remove)) {
			failures.push(name)
		}
	}
	if (failures.length > 0) {
		fail(`Failed to delete orphan branch(es): ${failures.join(", ")}`)
	}
	console.log("✓ Sweep complete")
}

/**
 * Create the branch and wait until it's ready. Tolerates "already exists"
 * (a concurrent/earlier create) and the CLI's own `--wait` timeout — in both
 * cases the branch is (still) provisioning, so `waitUntilReady` takes over.
 */
const createAndAwaitBranch = async (database: string, branchName: string): Promise<void> => {
	const create = runPscale(["branch", "create", database, branchName, "--wait"])
	if (create.exitCode !== 0 && !isAlreadyExists(create) && !isCreateWaitTimeout(create)) {
		fail(`Failed to create branch ${branchName}`)
	}
	if (create.exitCode !== 0 && isCreateWaitTimeout(create)) {
		console.log(`… \`pscale branch create --wait\` hit its own timeout; polling until ready ourselves`)
	}
	await waitUntilReady(database, branchName)
}

/**
 * Fast path for a reused branch: reset it to empty via SQL (see
 * packages/db/scripts/reset-preview-branch.ts). Returns false on failure so the
 * caller can fall back to delete → recreate.
 */
const resetBranchInPlace = (connectionUrl: string): boolean => {
	const dbPackageDir = fileURLToPath(new URL("../packages/db", import.meta.url))
	console.log(`$ bun run --cwd packages/db db:reset-preview`)
	const proc = spawnSync("bun", ["run", "--cwd", dbPackageDir, "db:reset-preview"], {
		encoding: "utf8",
		stdio: "inherit",
		env: { ...process.env, DATABASE_URL: connectionUrl },
	})
	return proc.status === 0
}

const main = async () => {
	const { subcommand, prNumber } = parseArgs()
	const database = process.env.PLANETSCALE_DATABASE?.trim() || "maple"
	const branchName = `pr-${prNumber}`

	if (subcommand === "sweep") {
		return sweepOrphanBranches(database)
	}

	if (subcommand === "up") {
		// A deploy landing after the PR closed (delayed event, re-run, approval
		// released late) would recreate the branch right after the close-event
		// teardown deleted it — and nothing would ever delete it again.
		if ((await fetchPrState(prNumber)) === "closed") {
			fail(`PR #${prNumber} is already closed — refusing to provision branch ${branchName}`)
		}
		// Every deploy must start from an EMPTY branch (parity with the old
		// per-PR empty D1), but a full branch provision costs ~9 minutes — so the
		// branch is created once per PR and RESET in SQL on subsequent deploys.
		// The reset also solves the ownership problem that used to force delete →
		// recreate: the prior run's `drizzle`/`public` objects belong to that
		// run's ephemeral role (24h TTL), and the reset script assumes those
		// owner roles before dropping.
		const show = runPscale(["branch", "show", database, branchName, "--format", "json"], {
			secret: true,
		})
		const branchExists = show.exitCode === 0
		if (!branchExists && !isNotFound(show)) {
			fail(`Could not determine whether branch ${branchName} exists`)
		}

		if (branchExists) {
			// Reuse: wait out any in-flight provisioning, then reset in place.
			// Parameters go first — a cluster restart mid-reset would be worse, and
			// once set they persist, so this is a cheap no-op check on later deploys.
			await waitUntilReady(database, branchName)
			const credential = createCredential(database, branchName)
			await ensureClusterParameters(database, branchName, credential.url)
			if (resetBranchInPlace(credential.url)) {
				const electric = createCredential(database, branchName, { replication: true, suffix: "-repl" })
				maskAndExport(
					{ MAPLE_PG_URL: credential.url, MAPLE_PG_ELECTRIC_URL: electric.url },
					[credential.password, electric.password],
				)
				return
			}
			// Fallback: the old slow-but-certain path. Deleting the branch revokes
			// the credential minted above, so a fresh one is minted after recreate.
			console.log(`… in-place reset failed; falling back to delete → recreate`)
			const existing = runPscale(["branch", "delete", database, branchName, "--force"])
			if (existing.exitCode !== 0 && !isNotFound(existing)) {
				fail(`Failed to reset (delete) existing branch ${branchName}`)
			}
			if (existing.exitCode === 0) {
				// Deletion is async — wait until it's actually gone before recreating
				// the same name, otherwise `branch create` races the teardown.
				await waitUntilGone(database, branchName)
			}
		}

		await createAndAwaitBranch(database, branchName)

		const credential = createCredential(database, branchName)
		await ensureClusterParameters(database, branchName, credential.url)
		// MAPLE_PG_URL — alchemy.run.ts parses it into the Hyperdrive origin, the
		// migrate step + scripts use it as-is. MAPLE_PG_ELECTRIC_URL — the same
		// branch through a replication-attribute role, consumed only by
		// scripts/electric-pr-branch.ts (Electric requires REPLICATION of its
		// connecting role; the main role must stay non-replication to keep the
		// in-place reset's role assumption working).
		const electric = createCredential(database, branchName, { replication: true, suffix: "-repl" })
		maskAndExport(
			{ MAPLE_PG_URL: credential.url, MAPLE_PG_ELECTRIC_URL: electric.url },
			[credential.password, electric.password],
		)
		return
	}

	const remove = runPscale(["branch", "delete", database, branchName, "--force"])
	if (remove.exitCode !== 0 && !isNotFound(remove)) {
		fail(`Failed to delete branch ${branchName}`)
	}
	console.log(`✓ Branch ${branchName} removed (or already gone)`)
}

await main()

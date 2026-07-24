#!/usr/bin/env bun
/**
 * Per-PR Tinybird branch lifecycle for the PR-preview deploy.
 *
 *   bun scripts/tinybird-pr-branch.ts up    <pr-number>
 *   bun scripts/tinybird-pr-branch.ts down  <pr-number>
 *   bun scripts/tinybird-pr-branch.ts sweep
 *
 * `up` creates (or reuses) an ephemeral Tinybird branch `pr_<n>` seeded with the
 * latest production partition (`--last-partition`), deploys this PR's project
 * schema into it, then exports the branch's TINYBIRD_HOST / TINYBIRD_TOKEN to
 * $GITHUB_ENV so the subsequent `alchemy:deploy:pr` binds the whole preview stack
 * (api/web/alerting/chat-agent + Rust ingest) to the branch instead of prod.
 *
 * `down` removes the branch (called on PR close, after `alchemy:destroy:pr`).
 *
 * `sweep` removes every `pr_<n>` branch whose PR is already closed. The
 * close-event teardown is best-effort only (GitHub creates no `closed` run for
 * conflicted PRs; close runs execute the PR branch's own old workflow version;
 * post-close redeploys recreate resources) — the scheduled
 * cleanup-preview-orphans workflow runs `sweep` as the safety net, mirroring
 * scripts/planetscale-pr-branch.ts.
 *
 * Auth: the PARENT (prod) workspace host+token arrive via the incoming
 * TINYBIRD_HOST / TINYBIRD_TOKEN (Infisical `preview` environment). We use them to drive the
 * `tb` CLI for branch ops, then overwrite the same two vars with the branch's
 * values. `tb` is invoked flag-first (`--cloud --host --token`), matching
 * .github/workflows/tinybird-ci.yml — no `.tinyb` state needed.
 *
 * Branches share compute with production (Tinybird limitation), so `down` on PR
 * close is mandatory to avoid branch sprawl.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down" | "sweep"

const FAILURE = 1

const parseArgs = (): { subcommand: Subcommand; branchName: string; prNumber: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down" && rawSubcommand !== "sweep") {
		fail(
			`Usage: bun scripts/tinybird-pr-branch.ts <up|down> <pr-number> | sweep (got "${rawSubcommand ?? ""}")`,
		)
	}
	if (rawSubcommand === "sweep") {
		return { subcommand: "sweep", branchName: "", prNumber: "" }
	}
	// PR numbers are digits only; this is also the only untrusted input that ends
	// up in a branch name, so keep it strictly numeric.
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand as Subcommand, branchName: `pr_${prNumber}`, prNumber }
}

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		fail(`Missing required env: ${key}`)
	}
	return value as string
}

interface TbResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * Run a `tb` command with the right environment + auth flags prepended. Returns
 * the captured output; never throws (callers decide how to treat failures).
 *
 * `--cloud` and `--branch` are mutually exclusive environment flags, so:
 *  - workspace-level ops (branch create/rm) use `--cloud`;
 *  - branch-scoped ops (deploy, token) use `--branch=<name>` instead.
 * Auth flags (`--host`/`--token`) apply to both.
 */
const runTb = (
	parent: { host: string; token: string },
	args: string[],
	opts?: { branch?: string; secret?: boolean },
): TbResult => {
	const envFlag = opts?.branch ? `--branch=${opts.branch}` : "--cloud"
	const proc = spawnSync("tb", [envFlag, "--host", parent.host, "--token", parent.token, ...args], {
		encoding: "utf8",
	})
	if (proc.error) {
		fail(`Failed to invoke \`tb\` — is the Tinybird CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	// Log the env flag + subcommand only — never the auth flags/token.
	console.log(`$ tb ${envFlag} ${args.join(" ")}`)
	// `secret` suppresses the captured output entirely — `token ls` prints raw
	// token values, which must never reach the CI log.
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
		if (stderr) console.error(stderr)
	}
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isAlreadyExists = (result: TbResult): boolean =>
	/already (exist|being used)|already a branch|duplicated|name is taken|names should be unique|select another name/i.test(
		`${result.stdout}\n${result.stderr}`,
	)

const isNotFound = (result: TbResult): boolean =>
	/not found|does not exist|no branch|unknown branch/i.test(`${result.stdout}\n${result.stderr}`)

/**
 * Resolve the branch's admin token value directly from `tb token ls`, which prints
 * `name:` / `token:` line pairs. The branch mirrors the workspace's tokens with
 * fresh, branch-scoped values; we want the admin token (read + append).
 *
 * Parsing the value from `token ls` avoids `token copy`, which needs token-info
 * permissions the workspace token may lack. `token ls` can emit a trailing
 * "Forbidden" introspection warning yet still list the tokens and exit 0, so we
 * parse stdout regardless of exit status and only fail if no admin token is found.
 * `TB_BRANCH_ADMIN_TOKEN_NAME` pins an exact name if the default pick is wrong.
 */
const resolveBranchAdminToken = (parent: { host: string; token: string }, branchName: string): string => {
	const preferredName = process.env.TB_BRANCH_ADMIN_TOKEN_NAME?.trim()
	const listed = runTb(parent, ["token", "ls"], { branch: branchName, secret: true })

	const pairs: { name: string; token: string }[] = []
	let currentName = ""
	for (const raw of listed.stdout.split("\n")) {
		const line = raw.trim()
		const nameMatch = line.match(/^name:\s*(.+)$/)
		if (nameMatch) {
			currentName = nameMatch[1].trim()
			continue
		}
		const tokenMatch = line.match(/^token:\s*(\S+)$/)
		if (tokenMatch) {
			pairs.push({ name: currentName, token: tokenMatch[1] })
			currentName = ""
		}
	}

	if (pairs.length === 0) {
		fail(`Could not parse any tokens from branch ${branchName} (\`tb token ls\` output unrecognized).`)
	}

	const pick =
		(preferredName && pairs.find((p) => p.name === preferredName)) ||
		pairs.find((p) => p.name.toLowerCase() === "workspace admin token") ||
		pairs.find((p) => p.name.toLowerCase().includes("admin"))
	if (!pick) {
		fail(
			`No admin token found in branch ${branchName}. ` +
				`Set TB_BRANCH_ADMIN_TOKEN_NAME to the exact token name.`,
		)
	}
	return pick.token
}

const exportToGithubEnv = (vars: Record<string, string>): void => {
	const githubEnv = process.env.GITHUB_ENV?.trim()
	const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`)
	if (!githubEnv) {
		// Local run: just print so a developer can copy them.
		console.log("\nResolved branch env (GITHUB_ENV unset — printing instead):")
		for (const line of lines) console.log(`  ${line}`)
		return
	}
	appendFileSync(githubEnv, `${lines.join("\n")}\n`)
}

const up = (branchName: string): void => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }

	// 1. Create the branch with the latest production partition. Idempotent across
	//    `synchronize` events: a pre-existing branch is fine.
	const created = runTb(parent, ["branch", "create", branchName, "--last-partition"])
	if (created.exitCode !== 0 && !isAlreadyExists(created)) {
		fail(`Failed to create Tinybird branch ${branchName}.`)
	}

	// 2. Deploy this PR's datasources/MVs into the branch. The branch is ephemeral,
	//    so destructive schema iteration is acceptable.
	const deployed = runTb(parent, ["deploy", "--allow-destructive-operations"], { branch: branchName })
	if (deployed.exitCode !== 0) {
		fail(`Failed to deploy project schema to Tinybird branch ${branchName}.`)
	}

	// 3. Resolve the branch's admin token (read + append scopes) for the workers.
	const branchToken = resolveBranchAdminToken(parent, branchName)

	// Mask the token in CI logs before it can appear anywhere downstream.
	console.log(`::add-mask::${branchToken}`)

	// 4. Hand the branch creds to the rest of the workflow. The branch is reached on
	//    the same regional host as its parent — the branch-scoped token does the
	//    routing — so only the token changes.
	exportToGithubEnv({ TINYBIRD_HOST: parent.host, TINYBIRD_TOKEN: branchToken })
	console.log(`✓ Tinybird branch ${branchName} ready; preview stack will bind to it.`)
}

const down = (branchName: string): void => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }
	const removed = runTb(parent, ["branch", "rm", branchName, "--yes"])
	if (removed.exitCode !== 0 && !isNotFound(removed)) {
		fail(`Failed to remove Tinybird branch ${branchName}.`)
	}
	console.log(`✓ Tinybird branch ${branchName} removed (or already gone).`)
}

/**
 * PR state via the GitHub REST API. Returns "unknown" when no token/repo is
 * available (local runs) or the API call fails — callers must treat "unknown"
 * as "don't block", never as "closed". Same contract as
 * scripts/planetscale-pr-branch.ts.
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
 * Remove every `pr_<n>` branch whose PR is closed. `tb branch ls` prints a
 * human-readable table (no JSON mode), so candidate names are extracted by the
 * exact `pr_<digits>` token shape — `main` and any other branch name are never
 * candidates. Branches whose PR state cannot be determined are skipped
 * (deleting on uncertainty risks tearing down a live preview).
 */
const sweep = async (): Promise<void> => {
	// The PR-state lookup is the sweep's only guard against deleting a LIVE
	// preview; without a token every branch resolves to "unknown" and the run
	// green-no-ops forever. Fail loudly instead — this is the safety net.
	if (!process.env.GITHUB_REPOSITORY?.trim() || !(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()) {
		fail("sweep requires GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) to check PR state")
	}
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }
	const listed = runTb(parent, ["branch", "ls"])
	if (listed.exitCode !== 0) {
		fail("Failed to list Tinybird branches.")
	}
	const candidates = [
		...new Map(
			[...listed.stdout.matchAll(/\bpr_(\d+)\b/g)].map((match) => [
				match[0],
				{ name: match[0], prNumber: match[1] as string },
			]),
		).values(),
	]
	console.log(`Found ${candidates.length} pr_* branch(es): ${candidates.map((c) => c.name).join(", ") || "—"}`)

	const failures: string[] = []
	for (const candidate of candidates) {
		const state = await fetchPrState(candidate.prNumber)
		if (state === "open") {
			console.log(`… keeping ${candidate.name} (PR #${candidate.prNumber} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${candidate.name} (PR #${candidate.prNumber} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${candidate.name} (PR #${candidate.prNumber} is closed)`)
		const removed = runTb(parent, ["branch", "rm", candidate.name, "--yes"])
		if (removed.exitCode !== 0 && !isNotFound(removed)) {
			failures.push(candidate.name)
		}
	}
	if (failures.length > 0) {
		fail(`Failed to remove orphan branch(es): ${failures.join(", ")}`)
	}
	console.log("✓ Sweep complete")
}

const { subcommand, branchName } = parseArgs()
if (subcommand === "up") {
	up(branchName)
} else if (subcommand === "sweep") {
	await sweep()
} else {
	down(branchName)
}

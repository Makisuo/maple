import { spawnSync } from "node:child_process"

const git = (cwd: string, ...args: string[]): string | undefined => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" })
	if (result.error || result.status !== 0) return undefined
	const value = result.stdout.trim()
	return value === "" ? undefined : value
}

/**
 * The subdomain prefix portless gives a checkout: empty in the main worktree,
 * `<branch>.` in a linked one (`fix-ui.api.localhost`). Mirrors `portless run`'s
 * own rule so routes registered here match the names portless would produce
 * for a process it managed itself.
 */
export const worktreePrefix = (cwd: string = process.cwd()): string => {
	const gitDir = git(cwd, "rev-parse", "--git-dir")
	const commonDir = git(cwd, "rev-parse", "--git-common-dir")
	// In the main worktree these are the same path; a linked worktree's git dir
	// lives under the common dir's `worktrees/`.
	if (!gitDir || !commonDir || gitDir === commonDir) return ""
	const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
	if (!branch || branch === "HEAD") return ""
	return `${branch.replaceAll("/", "-")}.`
}

/** The portless hostname a route is registered under. */
export const routeHostname = (name: string, prefix: string = worktreePrefix()): string => `${prefix}${name}`

/** The HTTPS URL a route answers at through the portless proxy. A plain string, usable at plan time. */
export const routeUrl = (name: string, prefix?: string): string =>
	`https://${routeHostname(name, prefix)}.localhost`

import { spawnSync } from "node:child_process"

const git = (cwd: string, ...args: string[]): string | undefined => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" })
	if (result.error || result.status !== 0) return undefined
	const value = result.stdout.trim()
	return value === "" ? undefined : value
}

/** Portless's worktree rule: empty in the main worktree, `<branch>.` in a linked one. */
export const worktreePrefix = (cwd: string = process.cwd()): string => {
	const gitDir = git(cwd, "rev-parse", "--git-dir")
	const commonDir = git(cwd, "rev-parse", "--git-common-dir")
	if (!gitDir || !commonDir || gitDir === commonDir) return ""
	const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
	if (!branch || branch === "HEAD") return ""
	return `${branch.replaceAll("/", "-")}.`
}

/** The portless hostname a route is registered under. */
export const routeHostname = (name: string, prefix: string = worktreePrefix()): string => `${prefix}${name}`

/** The route's URL through the portless proxy; a plain string, usable at plan time. */
export const routeUrl = (name: string, prefix?: string): string =>
	`https://${routeHostname(name, prefix)}.localhost`

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const run = (cmd: string[], cwd = process.cwd()) => {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const stdout = new TextDecoder().decode(proc.stdout).trim()
  const stderr = new TextDecoder().decode(proc.stderr).trim()

  if (proc.exitCode !== 0) {
    if (stdout) console.log(stdout)
    if (stderr) console.error(stderr)
    process.exit(proc.exitCode)
  }

  return { stdout, stderr }
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const wranglerBin = "./node_modules/.bin/wrangler"
const migrationSqlPath = "../../packages/db/.generated/d1-migrations.sql"

run(["bun", "run", "--cwd", "../../packages/db", "db:d1:migrations:sql"], appDir)

const check = run(
  [
    wranglerBin,
    "d1",
    "execute",
    "MAPLE_DB",
    "--local",
    "--persist-to",
    ".wrangler/state",
    "--command",
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dashboards'",
    "--json",
  ],
  appDir,
)

const parsed = JSON.parse(check.stdout) as Array<{
  readonly results?: ReadonlyArray<Record<string, unknown>>
}>

const alreadyInitialized = Array.isArray(parsed[0]?.results) && parsed[0]!.results!.length > 0

if (alreadyInitialized) {
  console.log("Local D1 already initialized")
  process.exit(0)
}

run(
  [
    wranglerBin,
    "d1",
    "execute",
    "MAPLE_DB",
    "--local",
    "--persist-to",
    ".wrangler/state",
    "--file",
    migrationSqlPath,
  ],
  appDir,
)

console.log("Local D1 initialized")

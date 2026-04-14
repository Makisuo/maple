import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const proc = Bun.spawnSync(
  [
    "./node_modules/.bin/wrangler",
    "d1",
    "migrations",
    "apply",
    "MAPLE_DB",
    "--local",
    "--persist-to",
    ".wrangler/state",
  ],
  {
    cwd: appDir,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
)

process.exit(proc.exitCode ?? 0)

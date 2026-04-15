import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface ResolveLocalD1Options {
  readonly persistTo?: string
  readonly cwd?: string
}

export interface EnsureLocalD1Options extends ResolveLocalD1Options {
  readonly bindingName: string
}

const DEFAULT_PERSIST_TO = ".wrangler/state"
const MINIFLARE_D1_SUBPATH = "v3/d1/miniflare-D1DatabaseObject"

export const resolveLocalD1SqlitePath = (
  opts: ResolveLocalD1Options = {},
): string => {
  const cwd = opts.cwd ?? process.cwd()
  const persistTo = opts.persistTo ?? DEFAULT_PERSIST_TO
  const dir = path.resolve(cwd, persistTo, MINIFLARE_D1_SUBPATH)

  if (!fs.existsSync(dir)) {
    throw new LocalD1NotBootstrappedError(dir)
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))
    .sort()

  if (files.length === 0) {
    throw new LocalD1NotBootstrappedError(dir)
  }
  if (files.length > 1) {
    throw new Error(
      `Found ${files.length} local D1 sqlite files under ${dir}: ${files.join(
        ", ",
      )}.\napps/api currently declares one D1 binding; pass an explicit sqlitePath to applyD1Migrations to disambiguate.`,
    )
  }

  return path.join(dir, files[0]!)
}

export const ensureLocalD1Sqlite = async (
  opts: EnsureLocalD1Options,
): Promise<string> => {
  try {
    return resolveLocalD1SqlitePath(opts)
  } catch (err) {
    if (!(err instanceof LocalD1NotBootstrappedError)) throw err
    await bootstrapLocalD1(opts)
    return resolveLocalD1SqlitePath(opts)
  }
}

class LocalD1NotBootstrappedError extends Error {
  constructor(dir: string) {
    super(`Local D1 sqlite not found under ${dir}`)
    this.name = "LocalD1NotBootstrappedError"
  }
}

const bootstrapLocalD1 = async (opts: EnsureLocalD1Options): Promise<void> => {
  const cwd = opts.cwd ?? process.cwd()
  const persistTo = opts.persistTo ?? DEFAULT_PERSIST_TO
  const args = [
    "wrangler",
    "d1",
    "execute",
    opts.bindingName,
    "--local",
    "--persist-to",
    persistTo,
    "--command",
    "SELECT 1",
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bunx", args, { cwd, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`bunx ${args.join(" ")} exited with code ${code}`))
    })
  })
}

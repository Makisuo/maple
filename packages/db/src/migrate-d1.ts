import fs from "node:fs"
import path from "node:path"
import { createClient, type Client, type InValue } from "@libsql/client"

export interface D1MigrationFile {
  readonly name: string
  readonly sql: string
}

export type D1Target =
  | { readonly kind: "local"; readonly sqlitePath: string }
  | {
      readonly kind: "remote"
      readonly accountId: string
      readonly databaseId: string
      readonly apiToken: string
    }

export interface ApplyD1MigrationsOptions {
  readonly target: D1Target
  readonly migrationsDir: string
  readonly migrationsTable?: string
}

export interface ApplyD1MigrationsResult {
  readonly applied: ReadonlyArray<string>
}

const DEFAULT_MIGRATIONS_TABLE = "d1_migrations"

export const readD1MigrationsDir = (
  dir: string,
): ReadonlyArray<D1MigrationFile> =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      name: f,
      sql: fs.readFileSync(path.join(dir, f), "utf8"),
    }))

export const applyD1Migrations = async (
  opts: ApplyD1MigrationsOptions,
): Promise<ApplyD1MigrationsResult> => {
  const table = opts.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE
  const migrations = readD1MigrationsDir(opts.migrationsDir)
  const exec = createExecutor(opts.target)

  try {
    await exec.run(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
    )

    const appliedRows = await exec.query(
      `SELECT name FROM ${quoteIdent(table)}`,
    )
    const appliedSet = new Set(appliedRows.map((row) => String(row.name)))

    const newlyApplied: string[] = []
    for (const migration of migrations) {
      if (appliedSet.has(migration.name)) continue

      const statements = splitSqlStatements(migration.sql)
      for (const statement of statements) {
        if (statement.trim().length === 0) continue
        await exec.run(statement)
      }
      await exec.run(
        `INSERT INTO ${quoteIdent(table)} (name) VALUES (?)`,
        [migration.name],
      )
      newlyApplied.push(migration.name)
    }

    return { applied: newlyApplied }
  } finally {
    await exec.close()
  }
}

type SqlParam = string | number | bigint | null

interface Executor {
  run(sql: string, params?: ReadonlyArray<SqlParam>): Promise<void>
  query(
    sql: string,
    params?: ReadonlyArray<SqlParam>,
  ): Promise<ReadonlyArray<Record<string, unknown>>>
  close(): Promise<void>
}

const createExecutor = (target: D1Target): Executor => {
  if (target.kind === "local") {
    return createLocalExecutor(target.sqlitePath)
  }
  return createRemoteExecutor(target)
}

const createLocalExecutor = (sqlitePath: string): Executor => {
  const client: Client = createClient({ url: `file:${sqlitePath}` })
  const toArgs = (params: ReadonlyArray<SqlParam> | undefined): Array<InValue> =>
    params ? [...params] : []
  return {
    async run(sql, params) {
      await client.execute({ sql, args: toArgs(params) })
    },
    async query(sql, params) {
      const result = await client.execute({ sql, args: toArgs(params) })
      return result.rows.map((row) => ({ ...row }))
    },
    async close() {
      client.close()
    },
  }
}

interface CloudflareQueryResponse {
  readonly success: boolean
  readonly errors?: ReadonlyArray<{ code?: number; message?: string }>
  readonly result?: ReadonlyArray<{
    readonly success?: boolean
    readonly results?: ReadonlyArray<Record<string, unknown>>
    readonly error?: string
  }>
}

const createRemoteExecutor = (target: {
  readonly accountId: string
  readonly databaseId: string
  readonly apiToken: string
}): Executor => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`

  const send = async (sql: string, params: ReadonlyArray<SqlParam>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    })
    const json = (await response.json()) as CloudflareQueryResponse
    if (!response.ok || !json.success) {
      const cfErrors = (json.errors ?? [])
        .map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
        .join("; ")
      throw new Error(
        `Cloudflare D1 query failed (HTTP ${response.status}): ${cfErrors || "no error detail"}\nSQL: ${sql.slice(0, 200)}${sql.length > 200 ? "..." : ""}`,
      )
    }
    return json
  }

  return {
    async run(sql, params) {
      await send(sql, params ?? [])
    },
    async query(sql, params) {
      const json = await send(sql, params ?? [])
      const first = json.result?.[0]
      return (first?.results ?? []).map((row) => ({ ...row }))
    },
    async close() {
      // fetch-based, nothing to close.
    },
  }
}

const quoteIdent = (ident: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`)
  }
  return `"${ident}"`
}

export const splitSqlStatements = (sql: string): ReadonlyArray<string> => {
  const statements: string[] = []
  let current = ""
  let i = 0
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (inLineComment) {
      current += ch
      if (ch === "\n") inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      current += ch
      if (ch === "*" && next === "/") {
        current += next
        i += 2
        inBlockComment = false
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'") {
        if (next === "'") {
          current += next
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      current += ch
      if (ch === '"') {
        if (next === '"') {
          current += next
          i += 2
          continue
        }
        inDouble = false
      }
      i++
      continue
    }

    if (ch === "-" && next === "-") {
      inLineComment = true
      current += ch
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true
      current += ch
      current += next
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      current += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      i++
      continue
    }
    if (ch === ";") {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(trimmed)
      current = ""
      i++
      continue
    }

    current += ch
    i++
  }

  const trailing = current.trim()
  if (trailing.length > 0) statements.push(trailing)
  return statements
}

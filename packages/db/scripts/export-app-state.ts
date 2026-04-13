import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import { resolveMapleDbConfig } from "../src/config"

type ExportedTable = {
  readonly name: string
  readonly columns: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const defaultOutFile = resolve(currentDir, "../.generated/d1-export.json")

const outArgIndex = process.argv.findIndex((arg) => arg === "--out")
const outFile =
  outArgIndex >= 0 && process.argv[outArgIndex + 1]
    ? resolve(process.cwd(), process.argv[outArgIndex + 1]!)
    : defaultOutFile

const config = resolveMapleDbConfig()
const client = createClient({
  url: config.url,
  ...(config.authToken ? { authToken: config.authToken } : {}),
})

const tablesResult = await client.execute(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    AND name != '__drizzle_migrations'
  ORDER BY name
`)

const tables: ExportedTable[] = []

for (const row of tablesResult.rows as Array<Record<string, unknown>>) {
  const tableName = String(row.name)
  const rowsResult = await client.execute(`SELECT * FROM "${tableName}"`)
  const typedRows = rowsResult.rows as Array<Record<string, unknown>>
  tables.push({
    name: tableName,
    columns: typedRows.length > 0 ? Object.keys(typedRows[0]!) : [],
    rows: typedRows,
  })
}

await client.close()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      source: config.url,
      tables,
    },
    null,
    2,
  ),
)

console.log(outFile)

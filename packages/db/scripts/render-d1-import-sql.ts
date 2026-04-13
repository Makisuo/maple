import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type ExportedTable = {
  readonly name: string
  readonly columns: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
}

type ExportPayload = {
  readonly exportedAt: string
  readonly source: string
  readonly tables: readonly ExportedTable[]
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const defaultInFile = resolve(currentDir, "../.generated/d1-export.json")
const defaultOutFile = resolve(currentDir, "../.generated/d1-import.sql")

const findArg = (name: string) => {
  const index = process.argv.findIndex((arg) => arg === name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const inFile = findArg("--in")
  ? resolve(process.cwd(), findArg("--in")!)
  : defaultInFile

const outFile = findArg("--out")
  ? resolve(process.cwd(), findArg("--out")!)
  : defaultOutFile

const payload = JSON.parse(readFileSync(inFile, "utf8")) as ExportPayload

const toSqlLiteral = (value: unknown): string => {
  if (value == null) return "NULL"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex").toUpperCase()}'`
  }
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`
}

const renderInsertStatements = (table: ExportedTable): string[] => {
  if (table.rows.length === 0) {
    return [`DELETE FROM "${table.name}";`]
  }

  const columnNames = table.columns.map((column) => `"${column}"`).join(", ")
  const rows = table.rows.map((row) =>
    `(${table.columns.map((column) => toSqlLiteral(row[column])).join(", ")})`,
  )

  const chunkSize = 50
  const chunks: string[] = [`DELETE FROM "${table.name}";`]

  for (let index = 0; index < rows.length; index += chunkSize) {
    const values = rows.slice(index, index + chunkSize).join(",\n  ")
    chunks.push(
      `INSERT OR REPLACE INTO "${table.name}" (${columnNames}) VALUES\n  ${values};`,
    )
  }

  return chunks
}

const sql = [
  `-- Generated from ${payload.source} at ${payload.exportedAt}`,
  "PRAGMA foreign_keys = OFF;",
  "BEGIN TRANSACTION;",
  ...payload.tables.flatMap(renderInsertStatements),
  "COMMIT;",
  "PRAGMA foreign_keys = ON;",
  "",
].join("\n\n")

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, sql)

console.log(outFile)

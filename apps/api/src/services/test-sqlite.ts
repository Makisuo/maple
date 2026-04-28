import { createClient, type InValue } from "@libsql/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const toDbUrl = (dbPath: string) => pathToFileURL(dbPath).href

export const cleanupTempDirs = (dirs: string[]) => {
	for (const dir of dirs.splice(0, dirs.length)) {
		rmSync(dir, { recursive: true, force: true })
	}
}

export const createTempDbUrl = (prefix: string, dirs: string[]) => {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	dirs.push(dir)

	const dbPath = join(dir, "maple.db")

	return {
		url: toDbUrl(dbPath),
		dbPath,
	}
}

export const executeSql = async (dbPath: string, sql: string, args: InValue[] = []) => {
	const client = createClient({ url: toDbUrl(dbPath) })
	try {
		await client.execute({ sql, args })
	} finally {
		client.close()
	}
}

export const queryFirstRow = async <T>(dbPath: string, sql: string, args: InValue[] = []) => {
	const client = createClient({ url: toDbUrl(dbPath) })
	try {
		const result = await client.execute({ sql, args })
		return result.rows[0] as T | undefined
	} finally {
		client.close()
	}
}

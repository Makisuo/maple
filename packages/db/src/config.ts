import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export interface MapleDbConfig {
	readonly url: string
	readonly authToken?: string
	readonly localPath?: string
}

const defaultLocalDbPath = () => {
	const currentDir = dirname(fileURLToPath(import.meta.url))
	return resolve(currentDir, "../../../apps/api/.data/maple.db")
}

const toLocalPath = (url: string): string | undefined => {
	if (!url.startsWith("file:")) {
		return undefined
	}

	try {
		return fileURLToPath(url)
	} catch {
		return undefined
	}
}

export const resolveMapleDbConfig = (
	env: Record<string, string | undefined> = process.env,
): MapleDbConfig => {
	const configuredUrl = env.MAPLE_DB_URL?.trim()
	const url =
		configuredUrl && configuredUrl.length > 0 ? configuredUrl : pathToFileURL(defaultLocalDbPath()).href

	const authToken = env.MAPLE_DB_AUTH_TOKEN?.trim()
	const localPath = toLocalPath(url)

	return {
		url,
		...(authToken && authToken.length > 0 ? { authToken } : {}),
		...(localPath ? { localPath } : {}),
	}
}

export const ensureMapleDbDirectory = (config: MapleDbConfig = resolveMapleDbConfig()): MapleDbConfig => {
	if (config.localPath) {
		mkdirSync(dirname(config.localPath), { recursive: true })
	}

	return config
}

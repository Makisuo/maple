import { randomBytes, timingSafeEqual } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { durableWrite } from "../durable-files"

const TOKEN_BYTES = 32

export const eventConsumerTokenPath = (dataDir: string): string => `${resolve(dataDir)}.event-consumer-token`

const readRealFile = (path: string): string => {
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new Error(`event consumer token is not a real file: ${path}`)
	return readFileSync(path, "utf8")
}

export const ensureEventConsumerToken = async (dataDir: string): Promise<string> => {
	const path = eventConsumerTokenPath(dataDir)
	try {
		readRealFile(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await durableWrite(path, `${randomBytes(TOKEN_BYTES).toString("hex")}\n`)
	}
	const token = readRealFile(path).trim()
	if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("event consumer token is malformed")
	return token
}

export const eventConsumerTokenMatches = (expected: string, supplied: string | null): boolean => {
	if (supplied === null) return false
	const left = Buffer.from(expected)
	const right = Buffer.from(supplied)
	return left.length === right.length && timingSafeEqual(left, right)
}

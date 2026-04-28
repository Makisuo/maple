import { createHmac, randomBytes } from "node:crypto"

export const API_KEY_PREFIX = "maple_ak_"

export const generateApiKey = (): string => `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`

export const hashApiKey = (rawKey: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(rawKey, "utf8").digest("base64url")

import type { ChatFlueEnv } from "./env"

export async function telemetryEnv(): Promise<ChatFlueEnv> {
	try {
		const { env } = await import("cloudflare:workers")
		return env as ChatFlueEnv
	} catch {
		return process.env as unknown as ChatFlueEnv
	}
}

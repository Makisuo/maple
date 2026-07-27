import type { ChatFlueEnv } from "./env"
import type { Context } from "hono"

export function appEnv(c: Context): ChatFlueEnv {
	if ("incoming" in c.env && "outgoing" in c.env) {
		return process.env as unknown as ChatFlueEnv
	}
	return c.env
}

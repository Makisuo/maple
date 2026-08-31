import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createMaplePgSocket } from "./client"

const defaultPgUrl = process.env.MAPLE_PG_URL ?? "postgres://maple:maple@127.0.0.1:5499/maple"
const defaultWsProxyUrl = process.env.MAPLE_PG_WS_PROXY ?? "ws://127.0.0.1:5498"

const sqlUrlFor = (wsProxyUrl: string): string => {
	if (wsProxyUrl.startsWith("wss://")) return `https://${wsProxyUrl.slice("wss://".length)}/sql`
	if (wsProxyUrl.startsWith("ws://")) return `http://${wsProxyUrl.slice("ws://".length)}/sql`
	return `${wsProxyUrl.replace(/\/$/, "")}/sql`
}

const isWsProxyUp = async (wsProxyUrl: string): Promise<boolean> => {
	try {
		const response = await fetch(sqlUrlFor(wsProxyUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "select 1", params: [], method: "execute" }),
			signal: AbortSignal.timeout(1_000),
		})
		return response.ok
	} catch {
		return false
	}
}

describe("createMaplePgSocket", () => {
	it("does not install a proxy client when wsProxyUrl is absent", async () => {
		const handle = createMaplePgSocket(defaultPgUrl)
		expect(handle.wrapClient).toBeUndefined()
		expect(handle.sql).toBeTruthy()
		await handle.end()
	})

	it("installs a neon-serverless wrapClient when wsProxyUrl is set", async () => {
		const handle = createMaplePgSocket(defaultPgUrl, {
			wsProxyUrl: defaultWsProxyUrl,
		})
		expect(typeof handle.wrapClient).toBe("function")
		const db = handle.wrapClient?.()
		expect(db).toBeDefined()
		expect(typeof db?.transaction).toBe("function")
		await handle.end()
	})

	it("runs a drizzle transaction over the neon websocket proxy when it is up", async (ctx) => {
		if (!(await isWsProxyUp(defaultWsProxyUrl))) {
			ctx.skip()
			return
		}
		const handle = createMaplePgSocket(defaultPgUrl, { wsProxyUrl: defaultWsProxyUrl })
		try {
			const db = handle.wrapClient?.()
			expect(db).toBeDefined()
			const result = await db!.transaction(async (tx) => {
				await tx.execute(sql`select 1::int as x`)
				return 41 + 1
			})
			expect(result).toBe(42)
		} finally {
			await handle.end()
		}
	})
})

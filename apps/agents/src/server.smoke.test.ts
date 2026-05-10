/**
 * End-to-end smoke test for the Maple Electric Agents integration.
 *
 * Skipped unless `RUN_ELECTRIC_SMOKE=1` because it spawns:
 *   1. A local Electric Agents runtime (`electric-ax agents start`)
 *   2. The Maple agents Node HTTP server (this app)
 *
 * It then drives a full `user_message` round trip via the runtime's
 * server-side client and asserts the entity's timeline ends with an
 * assistant `text` section. `testResponses` injects a deterministic
 * response so we don't need an OpenRouter key.
 *
 * Run with:
 *   RUN_ELECTRIC_SMOKE=1 bun --filter @maple/agents test
 */
import http from "node:http"
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
	createEntityRegistry,
	createEntityStreamDB,
	createRuntimeHandler,
	createRuntimeServerClient,
} from "@electric-ax/agents-runtime"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const SHOULD_RUN = process.env.RUN_ELECTRIC_SMOKE === "1"
const describeMaybe = SHOULD_RUN ? describe : describe.skip

const TEST_ENTITY_TYPE = "maple_smoke_chat"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Resolve the workspace-local `electric-ax` CLI so the test doesn't depend
// on the binary being on the user's PATH. Bun installs the binary in the
// nearest `node_modules/.bin` to each consumer — apps/agents in this case.
const ELECTRIC_AX_BIN = path.resolve(__dirname, "../node_modules/.bin/electric-ax")

const TestChatCreationSchema = z.object({ orgId: z.string(), tabId: z.string() })
const TestChatMessageSchema = z.object({ text: z.string() })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForRuntime = async (baseUrl: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/_electric/entity-types`, {
				signal: AbortSignal.timeout(2_000),
			})
			if (res.ok) return
		} catch (error) {
			lastError = error
		}
		await sleep(1_000)
	}
	throw new Error(
		`Electric runtime at ${baseUrl} not ready: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	)
}

const pickFreePort = (): Promise<number> =>
	new Promise((resolve) => {
		const server = http.createServer()
		server.listen(0, () => {
			const port = (server.address() as { port: number }).port
			server.close(() => resolve(port))
		})
	})

interface TextRow {
	readonly text: string
	readonly status: string
}

const waitForAssistantText = async (
	db: ReturnType<typeof createEntityStreamDB>,
	timeoutMs: number,
): Promise<string | null> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if ("collections" in db) {
			const rows = (db.collections.texts.toArray as unknown as Array<TextRow>).filter(
				(row) => row.status === "completed" && row.text.length > 0,
			)
			if (rows.length > 0) return rows.map((row) => row.text).join("")
		}
		await sleep(500)
	}
	return null
}

describeMaybe("Maple agents smoke test", () => {
	let runtimeProc: ChildProcess | null = null
	let server: http.Server | null = null
	let runtimeBaseUrl = ""
	let appServeUrl = ""

	beforeAll(async () => {
		const runtimePort = await pickFreePort()
		const appPort = await pickFreePort()
		runtimeBaseUrl = `http://localhost:${runtimePort}`
		appServeUrl = `http://localhost:${appPort}`

		runtimeProc = spawn(ELECTRIC_AX_BIN, ["agents", "start"], {
			env: { ...process.env, ELECTRIC_AGENTS_PORT: String(runtimePort) },
			stdio: "pipe",
		})
		runtimeProc.stdout?.on("data", (chunk) =>
			process.stderr.write(`[runtime] ${chunk.toString()}`),
		)
		runtimeProc.stderr?.on("data", (chunk) =>
			process.stderr.write(`[runtime] ${chunk.toString()}`),
		)

		await waitForRuntime(runtimeBaseUrl, 45_000)

		const registry = createEntityRegistry()
		registry.define(TEST_ENTITY_TYPE, {
			description: "Smoke test entity",
			creationSchema: TestChatCreationSchema,
			inboxSchemas: { user_message: TestChatMessageSchema.toJSONSchema() },
			async handler(ctx) {
				ctx.useAgent({
					systemPrompt: "test",
					model: "faux-1",
					tools: [...ctx.electricTools],
					testResponses: ["Pong from the smoke test."],
				})
				await ctx.agent.run()
			},
		})

		const runtime = createRuntimeHandler({
			baseUrl: runtimeBaseUrl,
			serveEndpoint: `${appServeUrl}/webhook`,
			webhookPath: "/webhook",
			registry,
		})
		server = http.createServer(async (req, res) => {
			if (req.url?.startsWith("/webhook")) {
				await runtime.onEnter(req, res)
				return
			}
			res.writeHead(404)
			res.end()
		})
		await new Promise<void>((resolve) => server!.listen(appPort, resolve))
		await runtime.registerTypes()
	}, 60_000)

	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
		if (runtimeProc && !runtimeProc.killed) {
			runtimeProc.kill("SIGTERM")
			await sleep(500)
			if (!runtimeProc.killed) runtimeProc.kill("SIGKILL")
		}
		spawn(ELECTRIC_AX_BIN, ["agents", "stop"], { stdio: "ignore" }).on("exit", () => undefined)
	})

	it("round-trips a user message into an assistant response", async () => {
		const client = createRuntimeServerClient({ baseUrl: runtimeBaseUrl })
		const entityId = `smoke-${Date.now()}`
		const entityUrl = `/${TEST_ENTITY_TYPE}/${entityId}`

		await client.spawnEntity({
			type: TEST_ENTITY_TYPE,
			id: entityId,
			args: { orgId: "org_test", tabId: entityId },
		})

		await client.sendEntityMessage({
			targetUrl: entityUrl,
			type: "user_message",
			payload: { text: "ping" },
		})

		const info = await client.getEntityInfo(entityUrl)
		const db = createEntityStreamDB(`${runtimeBaseUrl}${info.streamPath}`)
		await db.preload()

		const text = await waitForAssistantText(db, 30_000)
		expect(text).toBe("Pong from the smoke test.")
	}, 60_000)
})

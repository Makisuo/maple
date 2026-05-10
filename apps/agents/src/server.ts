import http from "node:http"
import { createEntityRegistry, createRuntimeHandler } from "@electric-ax/agents-runtime"
import { readAgentsEnv } from "./env"
import { registerMapleChatEntity } from "./maple-chat"

const env = readAgentsEnv()
const registry = createEntityRegistry()

registerMapleChatEntity(registry, env)

const runtime = createRuntimeHandler({
	baseUrl: env.ELECTRIC_AGENTS_URL,
	serveEndpoint: `${env.MAPLE_AGENTS_SERVE_URL}/webhook`,
	webhookPath: "/webhook",
	registry,
})

const server = http.createServer(async (req, res) => {
	if (req.url?.startsWith("/webhook")) {
		await runtime.onEnter(req, res)
		return
	}
	if (req.url === "/health") {
		res.writeHead(200, { "Content-Type": "text/plain" })
		res.end("OK")
		return
	}
	res.writeHead(404)
	res.end()
})

const printRuntimeStartupHelp = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`[maple-agents] Failed to register Electric entity types: ${message}`)
	console.error("")
	console.error("Maple agents need the Electric Agents runtime server running before this app starts.")
	console.error("The dev command starts it automatically. If you are running the production start command, run:")
	console.error("")
	console.error("  bun --filter @maple/agents runtime:start")
	console.error("  bun --filter @maple/agents start")
	console.error("")
	console.error(`Expected runtime URL: ${env.ELECTRIC_AGENTS_URL}`)
	if (!process.env.ELECTRIC_AGENTS_URL && process.env.DURABLE_STREAMS_WRITE_URL) {
		console.error("")
		console.error(
			"Note: DURABLE_STREAMS_WRITE_URL is not the same thing as ELECTRIC_AGENTS_URL. " +
				"Leave ELECTRIC_AGENTS_URL as http://localhost:4437 for local Electric Agents unless you are running a custom runtime server.",
		)
	}
}

server.listen(env.MAPLE_AGENTS_PORT, async () => {
	try {
		await runtime.registerTypes()
		console.log(
			`Maple agents ready on ${env.MAPLE_AGENTS_SERVE_URL} (runtime ${env.ELECTRIC_AGENTS_URL})`,
		)
	} catch (error) {
		printRuntimeStartupHelp(error)
		server.close(() => process.exit(1))
	}
})

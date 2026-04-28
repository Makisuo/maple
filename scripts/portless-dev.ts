import { spawn } from "node:child_process"
import { basename } from "node:path"

const prefix = basename(process.cwd())

const urls = {
	web: `https://${prefix}-web.localhost`,
	api: `https://${prefix}-api.localhost`,
	ingest: `https://${prefix}-ingest.localhost`,
	landing: `https://${prefix}-landing.localhost`,
} as const

const env = {
	...process.env,
	PORTLESS_PREFIX: prefix,
	VITE_API_BASE_URL: urls.api,
	VITE_INGEST_URL: urls.ingest,
	VITE_CHAT_AGENT_URL: `https://${prefix}-chat-agent.localhost`,
}

console.log(`\nportless dev — prefix "${prefix}"`)
for (const [name, url] of Object.entries(urls)) {
	console.log(`  ${name.padEnd(8)} ${url}`)
}
console.log("")

const child = spawn("bun", ["run", "dev"], { stdio: "inherit", env })

child.on("exit", (code) => {
	process.exit(code ?? 0)
})

const forward = (signal: NodeJS.Signals) => () => {
	if (!child.killed) child.kill(signal)
}
process.on("SIGINT", forward("SIGINT"))
process.on("SIGTERM", forward("SIGTERM"))

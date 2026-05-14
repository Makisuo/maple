import { spawn } from "node:child_process"
import { basename } from "node:path"
import { siblingUrl } from "../packages/infra/src/dev-urls.ts"

const overridesByApp: Record<string, Record<string, string>> = {
	"chat-agent": { MAPLE_API_URL: "api" },
	api: { MAPLE_APP_BASE_URL: "web" },
	alerting: { MAPLE_APP_BASE_URL: "web" },
}

const appName = basename(process.cwd())
const overrides = overridesByApp[appName] ?? {}

const varArgs: string[] = []
for (const [key, target] of Object.entries(overrides)) {
	const url = siblingUrl(target)
	if (url) varArgs.push("--var", `${key}:${url}`)
}

const passthrough = process.argv.slice(2)
const child = spawn("wrangler", ["dev", ...passthrough, ...varArgs], {
	stdio: "inherit",
})
child.on("exit", (code) => process.exit(code ?? 0))
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		if (!child.killed) child.kill(sig)
	})
}

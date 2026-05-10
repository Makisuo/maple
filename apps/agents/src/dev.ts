import { spawnSync } from "node:child_process"
import { readAgentsEnv } from "./env"

const skipRuntimeStart = process.env.MAPLE_AGENTS_SKIP_RUNTIME_START === "1"
const env = readAgentsEnv()

interface RuntimeReadiness {
	readonly ready: boolean
	readonly detail?: string
}

const checkRuntimeReady = async (): Promise<RuntimeReadiness> => {
	try {
		const url = new URL("/_electric/entity-types", env.ELECTRIC_AGENTS_URL)
		const response = await fetch(url, {
			signal: AbortSignal.timeout(1_500),
		})
		if (response.ok) return { ready: true }
		const body = await response.text().catch(() => "")
		return {
			ready: false,
			detail: `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
		}
	} catch (error) {
		return { ready: false, detail: error instanceof Error ? error.message : String(error) }
	}
}

const waitForRuntimeReady = async (timeoutMs = 30_000): Promise<RuntimeReadiness> => {
	const deadline = Date.now() + timeoutMs
	let last: RuntimeReadiness = { ready: false }
	while (Date.now() < deadline) {
		last = await checkRuntimeReady()
		if (last.ready) return last
		await new Promise((resolve) => setTimeout(resolve, 1_000))
	}
	return last
}

const runElectric = (args: string[], allowFailure = false): number => {
	const runtimeUrl = new URL(env.ELECTRIC_AGENTS_URL)
	const runtimePort = runtimeUrl.port || (runtimeUrl.protocol === "https:" ? "443" : "80")
	const result = spawnSync("electric-ax", ["agents", ...args], {
		env: {
			...process.env,
			ELECTRIC_AGENTS_PORT: process.env.ELECTRIC_AGENTS_PORT ?? runtimePort,
		},
		stdio: "inherit",
	})

	if (result.error) {
		console.error(
			`[maple-agents] Failed to run electric-ax agents ${args.join(" ")}: ${result.error.message}`,
		)
		if (!allowFailure) process.exit(1)
		return 1
	}
	const status = result.status ?? 1
	if (status !== 0 && !allowFailure) {
		console.error(`[maple-agents] electric-ax agents ${args.join(" ")} exited with code ${status}`)
		process.exit(status)
	}
	return status
}

if (!skipRuntimeStart && (await checkRuntimeReady()).ready) {
	console.log(`[maple-agents] Electric Agents runtime already running at ${env.ELECTRIC_AGENTS_URL}.`)
} else if (!skipRuntimeStart) {
	const initial = await checkRuntimeReady()
	if (initial.detail) {
		console.log(`[maple-agents] Electric Agents runtime is not registration-ready: ${initial.detail}`)
	}

	console.log("[maple-agents] Ensuring local Electric Agents runtime is running...")
	const startStatus = runElectric(["start"], true)
	let ready = await waitForRuntimeReady(startStatus === 0 ? 15_000 : 3_000)

	if (!ready.ready) {
		console.log("[maple-agents] Repairing local Electric Agents runtime...")
		runElectric(["stop"], true)
		runElectric(["start"])
		ready = await waitForRuntimeReady(45_000)
	}

	if (!ready.ready) {
		console.error(
			`[maple-agents] Electric Agents runtime did not become registration-ready at ${env.ELECTRIC_AGENTS_URL}.`,
		)
		if (ready.detail) console.error(`[maple-agents] Last readiness error: ${ready.detail}`)
		process.exit(1)
	}
} else {
	console.log("[maple-agents] Skipping Electric runtime auto-start.")
}

await import("./server")

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] ?? 250)
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 9897)
const benchDir = fileURLToPath(new URL("./service-binding-bench/", import.meta.url))
const baseUrl = `http://127.0.0.1:${port}`

const configs = ["router", "echo", "monolith", "telemetry"].flatMap((name) => [
	"-c",
	`${benchDir}${name}.wrangler.jsonc`,
])

const wrangler = spawn("bunx", ["wrangler", "dev", ...configs, "--port", String(port)], {
	cwd: fileURLToPath(new URL("../", import.meta.url)),
	stdio: ["ignore", "pipe", "pipe"],
})

let wranglerLog = ""
for (const stream of [wrangler.stdout, wrangler.stderr]) {
	stream.setEncoding("utf8")
	stream.on("data", (chunk: string) => {
		wranglerLog = `${wranglerLog}${chunk}`.slice(-16_000)
	})
}

const stop = async () => {
	if (wrangler.exitCode !== null) return
	wrangler.kill("SIGTERM")
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, 5_000)
		wrangler.once("exit", () => {
			clearTimeout(timeout)
			resolve()
		})
	})
}

const waitUntilReady = async () => {
	const deadline = Date.now() + 45_000
	while (Date.now() < deadline) {
		if (wrangler.exitCode !== null) throw new Error(`wrangler exited early\n${wranglerLog}`)
		try {
			const response = await fetch(`${baseUrl}/ready`)
			if (response.ok) return
		} catch {
			// The listener is not ready yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`wrangler did not become ready\n${wranglerLog}`)
}

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const summarize = (values: ReadonlyArray<number>) => ({
	medianMs: percentile(values, 0.5),
	p95Ms: percentile(values, 0.95),
	minMs: Math.min(...values),
})

const samplePath = async (pathname: string): Promise<ReadonlyArray<number>> => {
	const timings: Array<number> = []
	for (let index = 0; index < samples; index++) {
		const response = await fetch(`${baseUrl}${pathname}`)
		if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
		await response.arrayBuffer()
		const timing = Number(response.headers.get("x-service-binding-ms"))
		if (!Number.isFinite(timing)) throw new Error(`${pathname} omitted x-service-binding-ms`)
		timings.push(timing)
	}
	return timings
}

try {
	await waitUntilReady()
	// Warm both isolates and the local HTTP connection before collecting samples.
	await fetch(`${baseUrl}/direct`)
	await fetch(`${baseUrl}/bound`)

	const [direct, bound] = await Promise.all([samplePath("/direct"), samplePath("/bound")])
	const monolith = await (await fetch(`${baseUrl}/probe/monolith`)).json()
	const telemetry = await (await fetch(`${baseUrl}/probe/telemetry`)).json()
	const monolithWarm = await (await fetch(`${baseUrl}/probe/monolith`)).json()
	const telemetryWarm = await (await fetch(`${baseUrl}/probe/telemetry`)).json()

	console.log(
		JSON.stringify(
			{
				samples,
				warmRouter: {
					direct: summarize(direct),
					serviceBinding: summarize(bound),
				},
				coldModuleGraph: { monolith, telemetryIsland: telemetry },
				warmModuleGraph: { monolith: monolithWarm, telemetryIsland: telemetryWarm },
				notes: [
					"Service-binding timings are measured inside the router around binding.fetch().",
					"Module timings measure dynamic import/evaluation, not database or warehouse I/O.",
					"Local workerd numbers are relative evidence; production placement still needs a canary.",
				],
			},
			null,
			2,
		),
	)
} finally {
	await stop()
}

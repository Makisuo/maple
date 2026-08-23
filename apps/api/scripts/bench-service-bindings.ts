import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] ?? 250)
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 9897)
const benchDir = fileURLToPath(new URL("./service-binding-bench/", import.meta.url))
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url))
const baseUrl = `http://127.0.0.1:${port}`

const configs = ["router", "echo", "monolith", "telemetry"].flatMap((name) => [
	"-c",
	`${benchDir}${name}.wrangler.jsonc`,
])

// Run Wrangler's real CLI instead of its thin bin wrapper. The wrapper does
// not forward SIGTERM to the CLI process it spawns, which used to orphan both
// Wrangler and workerd after every benchmark run. A detached POSIX process
// group lets cleanup address the whole tree, including workerd descendants.
const wrangler = spawn("node", ["--no-warnings", wranglerCli, "dev", ...configs, "--port", String(port)], {
	cwd: fileURLToPath(new URL("../", import.meta.url)),
	detached: process.platform !== "win32",
	stdio: ["ignore", "pipe", "pipe"],
})

if (wrangler.pid === undefined) throw new Error("wrangler did not start")
const wranglerPid = wrangler.pid

let wranglerLog = ""
for (const stream of [wrangler.stdout, wrangler.stderr]) {
	stream.setEncoding("utf8")
	stream.on("data", (chunk: string) => {
		wranglerLog = `${wranglerLog}${chunk}`.slice(-16_000)
	})
}

const isMissingProcess = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"

const signalWranglerTree = (signal: NodeJS.Signals | 0): boolean => {
	try {
		if (process.platform === "win32") {
			return signal === 0 ? wrangler.kill(0) : wrangler.kill(signal)
		}
		process.kill(-wranglerPid, signal)
		return true
	} catch (error) {
		if (isMissingProcess(error)) return false
		throw error
	}
}

const waitForWranglerTreeExit = async (timeoutMs: number): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs
	while (signalWranglerTree(0) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	return !signalWranglerTree(0)
}

let stopPromise: Promise<void> | undefined
const stop = (): Promise<void> =>
	(stopPromise ??= (async () => {
		if (!signalWranglerTree(0)) return
		signalWranglerTree("SIGTERM")
		if (await waitForWranglerTreeExit(5_000)) return
		signalWranglerTree("SIGKILL")
		if (!(await waitForWranglerTreeExit(1_000))) {
			throw new Error(`wrangler process tree ${wranglerPid} did not stop`)
		}
	})())

const stopForSignal = (exitCode: number) => {
	void stop().finally(() => process.exit(exitCode))
}
const onSigint = () => stopForSignal(130)
const onSigterm = () => stopForSignal(143)
process.once("SIGINT", onSigint)
process.once("SIGTERM", onSigterm)

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
	process.off("SIGINT", onSigint)
	process.off("SIGTERM", onSigterm)
	await stop()
}

#!/usr/bin/env bun
/**
 * Predev hook for `bun dev`. Ensures the Electric Agents stack
 * (postgres + electric + agents-server) is reachable on AGENTS_URL.
 *
 * - If something is already serving on AGENTS_URL, exits 0 immediately
 *   (works regardless of which compose project owns the container).
 * - Otherwise brings up the checked-in compose project
 *   `apps/chat-agent/docker-compose.electric.yml`.
 *
 * Safe to run repeatedly. Non-fatal: if Docker isn't running or the user
 * intentionally points AGENTS_URL elsewhere, we print a warning and let
 * `bun dev` continue — chat-agent's preflight will retry on first request.
 */

const AGENTS_URL = process.env.AGENTS_URL ?? "http://localhost:4440"
const COMPOSE_FILE = "apps/chat-agent/docker-compose.electric.yml"
const PROJECT_NAME = "maple-electric-agents"

async function isReachable(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		})
		// Anything 2xx/3xx/4xx means a server is responding. Only 5xx and
		// network errors mean "down".
		return res.status < 500
	} catch {
		return false
	}
}

async function dockerAvailable(): Promise<boolean> {
	const proc = Bun.spawn(["docker", "info"], {
		stdout: "pipe",
		stderr: "pipe",
	})
	const code = await proc.exited
	return code === 0
}

async function bringUpStack(): Promise<number> {
	console.log(
		`[electric] bringing up ${PROJECT_NAME} stack (docker compose up -d)...`,
	)
	const proc = Bun.spawn(
		["docker", "compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "up", "-d"],
		{
			stdout: "inherit",
			stderr: "inherit",
			env: process.env as Record<string, string>,
		},
	)
	return await proc.exited
}

async function waitForReady(maxAttempts = 60): Promise<boolean> {
	process.stdout.write("[electric] waiting for agents-server")
	for (let i = 0; i < maxAttempts; i += 1) {
		if (await isReachable(AGENTS_URL)) {
			process.stdout.write(" ✓\n")
			return true
		}
		process.stdout.write(".")
		await new Promise((r) => setTimeout(r, 1000))
	}
	process.stdout.write(" ✗\n")
	return false
}

async function main(): Promise<void> {
	if (await isReachable(AGENTS_URL)) {
		console.log(`[electric] stack already up at ${AGENTS_URL} — skipping`)
		return
	}

	if (!(await dockerAvailable())) {
		console.warn(
			`[electric] Docker is not running. Start Docker Desktop / OrbStack, then re-run \`bun dev\`.\n` +
				`           (chat-agent will start in degraded mode and retry on first request)`,
		)
		return
	}

	const code = await bringUpStack()
	if (code !== 0) {
		console.warn(`[electric] docker compose exited ${code} — continuing anyway`)
		return
	}

	const ready = await waitForReady()
	if (!ready) {
		console.warn(
			`[electric] agents-server didn't become ready within 60s. Tail logs with \`bun electric:logs\`.`,
		)
	}
}

await main()

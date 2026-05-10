export interface AgentsEnv {
	readonly ELECTRIC_AGENTS_URL: string
	readonly MAPLE_AGENTS_PORT: number
	readonly MAPLE_AGENTS_SERVE_URL: string
	readonly OPENROUTER_API_KEY?: string
	readonly INTERNAL_SERVICE_TOKEN?: string
	readonly AUTUMN_SECRET_KEY?: string
	readonly AUTUMN_API_URL?: string
	readonly MAPLE_DEFAULT_ORG_ID?: string
	readonly [key: string]: string | number | undefined
}

const readPort = (): number => {
	const raw = process.env.MAPLE_AGENTS_PORT ?? process.env.PORT ?? "3480"
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 3480
}

export const readAgentsEnv = (): AgentsEnv => {
	const port = readPort()
	return {
		...process.env,
		ELECTRIC_AGENTS_URL: process.env.ELECTRIC_AGENTS_URL ?? "http://localhost:4438",
		MAPLE_AGENTS_PORT: port,
		MAPLE_AGENTS_SERVE_URL: process.env.MAPLE_AGENTS_SERVE_URL ?? `http://localhost:${port}`,
	}
}

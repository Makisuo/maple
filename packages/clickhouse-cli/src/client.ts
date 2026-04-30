/**
 * Tiny dependency-free ClickHouse HTTP client. Just enough to apply DDL +
 * read system tables. Mirrors the body shape of
 * `apps/api/src/services/OrgClickHouseSettingsService.ts:execClickHouse`
 * but without the Effect machinery — a CLI doesn't need it and pulling in
 * Effect would balloon the install footprint of `bunx @maple/clickhouse-cli`.
 */

export interface ClickHouseConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

/**
 * Run a single statement against ClickHouse via the HTTP interface.
 *
 * The `database` is sent as both the X-ClickHouse-Database header and a
 * `?database=` query parameter. The duplication is intentional — CH Cloud's
 * 24.x analyzer occasionally fails to resolve unqualified table names in
 * MV bodies if only the header is set, surfacing as `Code: 60. UNKNOWN_TABLE`.
 *
 * Throws a `ClickHouseError` (with .status + .body) on any non-2xx response.
 */
export async function exec(config: ClickHouseConfig, sql: string): Promise<string> {
	const url = `${config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(config.database)}`
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": config.user,
		"X-ClickHouse-Database": config.database,
	}
	if (config.password.length > 0) {
		headers["X-ClickHouse-Key"] = config.password
	}
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) {
		throw new ClickHouseError(response.status, body)
	}
	return body
}

export class ClickHouseError extends Error {
	readonly status: number
	readonly body: string
	constructor(status: number, body: string) {
		// Trim ClickHouse's stack-trace verbosity to one line for the headline.
		const headline = body.split("\n")[0]?.slice(0, 500) ?? ""
		super(`ClickHouse ${status}: ${headline}`)
		this.name = "ClickHouseError"
		this.status = status
		this.body = body
	}
}

/** Connectivity probe — returns the server version on success. */
export async function ping(config: ClickHouseConfig): Promise<string> {
	const text = await exec(config, "SELECT version() FORMAT TabSeparated")
	return text.trim()
}

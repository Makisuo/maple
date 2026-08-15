// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
/**
 * Apply-plan expansion: turn a migration's statements into an ordered list of
 * executable steps, splitting each {@link BackfillSpec} into time-windowed
 * chunks so no single statement exceeds the Cloudflare Worker subrequest budget.
 *
 * The driver (the schema-apply Workflow, or the standalone CLI) executes each
 * step's `sql` in order; the Workflow additionally wraps each in a durable
 * `step.do(step.name, …)` for resumability + progress.
 */
import {
	compileBackfillChunk,
	isBackfill,
	renderBackfillFull,
	renderStatementFull,
	type BackfillSpec,
} from "./backfill"
import type { ClickHouseMigration } from "./migrations"

export interface ApplyStep {
	/** Stable, unique step name — the Workflow's durable step key + UI label. */
	readonly name: string
	/** Executable SQL for this step. */
	readonly sql: string
	/** True for backfill chunks (long-running); false for structural DDL. */
	readonly backfill: boolean
}

/** Run a query, returning the raw text response. */
export type ExecFn = (sql: string) => Promise<string>

/** Smallest backfill chunk window. One day comfortably fits the Worker cap. */
const DAY_SECONDS = 24 * 60 * 60

/**
 * Upper bound on chunks per backfill. Keeps a workflow under Cloudflare's
 * free-tier 1,024-step cap even for multi-year retention; for long spans the
 * window grows (rounded up to whole days) so each chunk stays day-aligned and
 * still well under the per-request budget.
 */
const MAX_CHUNKS = 400

const chunkWindowSeconds = (spanSeconds: number): number => {
	if (spanSeconds <= 0) return DAY_SECONDS
	const days = Math.ceil(spanSeconds / MAX_CHUNKS / DAY_SECONDS)
	return Math.max(1, days) * DAY_SECONDS
}

const ident = (db: string, name: string): string => `\`${db}\`.\`${name}\``

/** Format unix seconds as a UTC ClickHouse datetime literal. */
const toChDateTime = (unixSeconds: number): string => {
	const d = new Date(unixSeconds * 1000)
	const p = (n: number): string => String(n).padStart(2, "0")
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

const parseFirstRow = (text: string): Record<string, unknown> | null => {
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			return JSON.parse(trimmed) as Record<string, unknown>
		} catch {
			// ignore — controlled query
		}
	}
	return null
}

/**
 * Expand one backfill into day-aligned chunk steps by reading the source's
 * `[min,max]` of `tsColumn`. Empty source → a single full (zero-row) step so the
 * statement still "runs" and the migration completes.
 */
export const expandBackfill = async (
	spec: BackfillSpec,
	database: string,
	exec: ExecFn,
): Promise<ReadonlyArray<ApplyStep>> => {
	const bounds = parseFirstRow(
		await exec(
			`SELECT toUnixTimestamp(min(${spec.tsColumn})) AS lo, toUnixTimestamp(max(${spec.tsColumn})) AS hi FROM ${ident(database, spec.from)} FORMAT JSONEachRow`,
		),
	)
	const lo = bounds ? Number(bounds.lo) : 0
	const hi = bounds ? Number(bounds.hi) : 0
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) {
		return [
			{
				name: `backfill:${spec.target}:empty`,
				sql: renderBackfillFull(spec, database),
				backfill: true,
			},
		]
	}

	const steps: ApplyStep[] = []
	const start = Math.floor(lo / DAY_SECONDS) * DAY_SECONDS
	const windowSeconds = chunkWindowSeconds(hi - start)
	for (let w = start; w <= hi; w += windowSeconds) {
		const from = toChDateTime(w)
		const to = toChDateTime(w + windowSeconds)
		steps.push({
			name: `backfill:${spec.target}:${from.slice(0, 10)}`,
			sql: compileBackfillChunk(spec, database, from, to),
			backfill: true,
		})
	}
	return steps
}

/**
 * Expand a migration into ordered, individually-executable steps. Structural
 * statements map 1:1; backfills expand into N day-window chunk steps.
 */
export const expandMigrationToSteps = async (
	migration: ClickHouseMigration,
	database: string,
	exec: ExecFn,
): Promise<ReadonlyArray<ApplyStep>> => {
	const steps: ApplyStep[] = []
	let index = 0
	for (const stmt of migration.statements) {
		if (isBackfill(stmt)) {
			steps.push(...(await expandBackfill(stmt, database, exec)))
		} else {
			steps.push({
				name: `m${migration.version}:stmt${index}`,
				sql: renderStatementFull(stmt, database),
				backfill: false,
			})
		}
		index += 1
	}
	return steps
}

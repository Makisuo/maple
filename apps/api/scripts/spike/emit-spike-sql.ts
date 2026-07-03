#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// spike/emit-spike-sql.ts — emit the sort-key spike SQL to stdout
//
// Dependency-free (plain bun + process.argv) so it runs in a fresh worktree
// without `bun install`. Pipe the output at a DEDICATED ClickHouse (docker or
// staging), never a Tinybird branch — see spike/SPIKE-SORTKEY.md.
//
//   bun run scripts/spike/emit-spike-sql.ts --org org_x --days 7 --mode setup   > setup.sql
//   bun run scripts/spike/emit-spike-sql.ts --org org_x --days 7 --mode backfill > backfill.sql
//   bun run scripts/spike/emit-spike-sql.ts --org org_x --mode probe             > probe.sql
//   bun run scripts/spike/emit-spike-sql.ts --mode drop                          > drop.sql
// ---------------------------------------------------------------------------

import {
	ALL_VARIANTS,
	LOGS_VARIANTS,
	TRACES_VARIANTS,
	backfillSQL,
	dropSQL,
	readInOrderProbeSQL,
	shadowTableDDL,
	type SortKeyVariant,
} from "./sortkey-variants"

type Mode = "setup" | "backfill" | "probe" | "drop"
type TableSet = "traces" | "logs" | "all"

interface Args {
	org: string
	days: number
	end: string // ClickHouse datetime "YYYY-MM-DD HH:MM:SS"
	tables: TableSet
	mode: Mode
}

const usage = `Usage: bun run scripts/spike/emit-spike-sql.ts [flags]
  --org <id>       Org to backfill/probe (required for backfill and probe)
  --days <N>       Backfill window in days (default 7)
  --end <dt>       Window end, "YYYY-MM-DD HH:MM:SS" UTC (default: now)
  --tables <set>   traces | logs | all (default all)
  --mode <mode>    setup | backfill | probe | drop (default setup)`

const pad = (n: number): string => String(n).padStart(2, "0")
const fmt = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
	`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

function parseArgs(argv: readonly string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag)
		return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
	}
	const mode = (get("--mode") ?? "setup") as Mode
	const tables = (get("--tables") ?? "all") as TableSet
	const days = Number(get("--days") ?? "7")
	const end = get("--end") ?? fmt(new Date())
	const org = get("--org") ?? ""
	if (!["setup", "backfill", "probe", "drop"].includes(mode)) throw new Error(`bad --mode "${mode}"\n${usage}`)
	if (!["traces", "logs", "all"].includes(tables)) throw new Error(`bad --tables "${tables}"\n${usage}`)
	if (!Number.isFinite(days) || days <= 0) throw new Error(`bad --days "${days}"\n${usage}`)
	if ((mode === "backfill" || mode === "probe") && org === "") throw new Error(`--org is required for --mode ${mode}\n${usage}`)
	return { org, days, end, tables, mode }
}

function variantsFor(tables: TableSet): readonly SortKeyVariant[] {
	if (tables === "traces") return TRACES_VARIANTS
	if (tables === "logs") return LOGS_VARIANTS
	return ALL_VARIANTS
}

/** Per-day windows [end - (i+1)d, end - i*d) for i in 0..days-1, oldest last. */
export function dayWindows(end: string, days: number): Array<{ start: string; end: string }> {
	const endMs = Date.parse(`${end.replace(" ", "T")}Z`)
	const dayMs = 86_400_000
	const windows: Array<{ start: string; end: string }> = []
	for (let i = 0; i < days; i++) {
		const winEnd = new Date(endMs - i * dayMs)
		const winStart = new Date(endMs - (i + 1) * dayMs)
		windows.push({ start: fmt(winStart), end: fmt(winEnd) })
	}
	return windows
}

export function emitSpikeSql(args: Args): string {
	const variants = variantsFor(args.tables)
	const header = `-- sort-key spike (${args.mode}) — tables=${args.tables}${args.org ? ` org=${args.org}` : ""}`
	const blocks: string[] = [header, ""]

	if (args.mode === "setup") {
		for (const v of variants) blocks.push(`-- ${v.name}: ${v.label}`, `${shadowTableDDL(v)};`, "")
	} else if (args.mode === "backfill") {
		const windows = dayWindows(args.end, args.days)
		blocks.push(`-- ${args.days}-day backfill, one INSERT per day per table (oldest last)`, "")
		for (const v of variants) {
			blocks.push(`-- ${v.name}`)
			for (const w of windows) {
				blocks.push(`${backfillSQL(v, { orgId: args.org, startInclusive: w.start, endExclusive: w.end })};`)
			}
			blocks.push("")
		}
	} else if (args.mode === "probe") {
		blocks.push("-- read_in_order probe: does ORDER BY <ts> DESC read straight from the sort key?", "")
		for (const v of variants) blocks.push(`-- ${v.name}: ${v.label}`, `${readInOrderProbeSQL(v, { orgId: args.org })};`, "")
	} else {
		for (const v of variants) blocks.push(`${dropSQL(v)};`)
	}

	return blocks.join("\n")
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2))
		process.stdout.write(emitSpikeSql(args) + "\n")
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
		process.exit(1)
	}
}

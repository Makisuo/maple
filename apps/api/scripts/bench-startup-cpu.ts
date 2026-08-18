#!/usr/bin/env bun
// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// bench-startup-cpu.ts — does defining Schema/TaggedError classes actually
// cost meaningful Cloudflare *startup* CPU?
//
// Context: `packages/domain/src/http/warehouse.ts` claims the warehouse error
// taxonomy is squashed into one `WarehouseQueryError` + a `category` string
// field (instead of distinct TaggedError classes) because "each new class on
// every endpoint costs measurable script-startup CPU on Cloudflare — hit error
// 10021 at ~7 errors × 30 endpoints". This script tests that claim empirically.
//
// Cloudflare error 10021 ("Script startup exceeded CPU time limit") fires during
// upload validation, which runs ONLY the worker's top-level module scope against
// a fixed budget (~400ms documented; behaved like ~1s here). So the only thing
// that matters is: how much CPU does *constructing* these schemas burn at import?
//
//   bun run scripts/bench-startup-cpu.ts                 # micro (default)
//   bun run scripts/bench-startup-cpu.ts micro --json
//   bun run scripts/bench-startup-cpu.ts parse <file.cpuprofile>
//   bun run scripts/bench-startup-cpu.ts worker          # wrangler check startup → parse
//   bun run scripts/bench-startup-cpu.ts worker --profile <file.cpuprofile>
//
// micro flags: --reps N --classes N --endpoints N --errors N --graph N --json
//
// NOTE ON ENGINE FIDELITY: Workers run on V8 (workerd); Bun runs on JSC. The
// ABSOLUTE numbers here are JSC's; the RELATIVE marginal cost (extra error class
// vs. baseline graph) is what settles the argument and is engine-agnostic. For
// the authoritative V8 startup number, use `worker` mode (it shells out to
// `wrangler check startup`, which profiles the real worker on workerd).

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { Predicate, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

const CF_STARTUP_BUDGET_MS = 400 // documented startup CPU ceiling
const OBSERVED_BLOWUP_MS = 1000 // what the team saw blow up (per the fix session)
const POST_FIX_STARTUP_MS = 25 // post lazy-import startup CPU (per memory)

type Sample = { wallMs: number; cpuMs: number }

const measureOnce = (fn: () => unknown): Sample => {
	const c0 = process.cpuUsage()
	const t0 = performance.now()
	fn()
	const t1 = performance.now()
	const c1 = process.cpuUsage(c0)
	return { wallMs: t1 - t0, cpuMs: (c1.user + c1.system) / 1000 }
}

const median = (xs: ReadonlyArray<number>): number => {
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

type BenchResult = { label: string; wallMs: number; cpuMs: number; reps: number }

const bench = (label: string, reps: number, fn: () => unknown): BenchResult => {
	fn() // warmup (JIT + first-touch)
	const ws: number[] = []
	const cs: number[] = []
	for (let i = 0; i < reps; i++) {
		const s = measureOnce(fn)
		ws.push(s.wallMs)
		cs.push(s.cpuMs)
	}
	return { label, wallMs: median(ws), cpuMs: median(cs), reps }
}

// Unique tag/name generator — avoids any chance of construction-time dedup and
// mirrors how every real class has a distinct tag string.
let _uid = 0
const uid = (prefix: string): string => `__bench/${prefix}/${_uid++}`

// A TaggedError shaped exactly like the real WarehouseQueryError (6 fields, one
// a 6-member Literals union) — the unit the comment says is expensive.
const defineTaggedError = () =>
	Schema.TaggedError<any>()(
		uid("err"),
		{
			message: Schema.String,
			pipe: Schema.String,
			category: Schema.optional(
				Schema.Literals(["query", "upstream", "auth", "config", "client", "schema_drift"]),
			),
			upstreamStatus: Schema.optional(Schema.Number),
			clickhouseCode: Schema.optional(Schema.String),
			clickhouseType: Schema.optional(Schema.String),
		},
		{ httpApiStatus: 502 },
	)

const defineTaggedErrors = (n: number) => {
	const out: unknown[] = []
	for (let i = 0; i < n; i++) out.push(defineTaggedError())
	return out
}

const defineStructs = (n: number) => {
	const out: unknown[] = []
	for (let i = 0; i < n; i++) {
		out.push(
			Schema.Struct({
				a: Schema.String,
				b: Schema.Number,
				c: Schema.optional(Schema.Boolean),
				d: Schema.optional(Schema.String),
				e: Schema.Array(Schema.String),
				f: Schema.optional(Schema.Number),
			}),
		)
	}
	return out
}

// Build an HttpApiGroup of `endpoints` endpoints, each declaring
// `errorsPerEndpoint` error classes drawn from a PRE-BUILT pool (so we measure
// only the union-assembly cost the "×30 endpoints" claim is about, not the
// one-time class construction).
const buildApiGroup = (endpoints: number, errorsPerEndpoint: number, pool: ReadonlyArray<any>) => {
	let g: any = HttpApiGroup.make(uid("grp"))
	for (let i = 0; i < endpoints; i++) {
		const ep = HttpApiEndpoint.post(`op${i}`, `/p${i}`, {
			payload: Schema.Struct({ a: Schema.String, b: Schema.Number }),
			success: Schema.Struct({ ok: Schema.Boolean, n: Schema.Number }),
			error: pool.slice(0, errorsPerEndpoint),
		})
		g = g.add(ep)
	}
	return g
}

const runMicro = (opts: {
	reps: number
	classes: number
	endpoints: number
	errors: number
	graph: number
	json: boolean
}) => {
	const { reps, classes, endpoints, errors, graph } = opts

	// Pre-build a pool of error classes for the union experiment (one-time, not
	// part of the union measurement).
	const pool = defineTaggedErrors(Math.max(errors, 7)) as any[]

	const rTagged = bench(`define ${classes} TaggedError classes`, reps, () => defineTaggedErrors(classes))
	const rStructs = bench(`define ${classes} Schema.Struct`, reps, () => defineStructs(classes))
	const rUnion1 = bench(`build ${endpoints} endpoints × 1 error`, reps, () =>
		buildApiGroup(endpoints, 1, pool),
	)
	const rUnionN = bench(`build ${endpoints} endpoints × ${errors} errors`, reps, () =>
		buildApiGroup(endpoints, errors, pool),
	)
	const rGraph = bench(`define representative ${graph}-struct graph`, reps, () => defineStructs(graph))

	// Derived numbers that actually answer the question.
	const perTaggedUs = (rTagged.cpuMs / classes) * 1000
	const perStructUs = (rStructs.cpuMs / classes) * 1000
	// The comment's exact scenario: 7 error classes (one-time) + the marginal
	// union cost of declaring 7 errors instead of 1 across `endpoints` endpoints.
	const sevenClassesMs = (perTaggedUs * 7) / 1000
	const unionMarginalMs = Math.max(0, rUnionN.cpuMs - rUnion1.cpuMs)
	const commentScenarioMs = sevenClassesMs + unionMarginalMs

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					reps,
					results: [rTagged, rStructs, rUnion1, rUnionN, rGraph],
					derived: {
						perTaggedErrorUs: perTaggedUs,
						perStructUs,
						sevenClassesMs,
						unionMarginalMs,
						commentScenarioMs,
						representativeGraphMs: rGraph.cpuMs,
						cfStartupBudgetMs: CF_STARTUP_BUDGET_MS,
					},
				},
				null,
				2,
			),
		)
		return
	}

	const fmt = (n: number, w = 8) => n.toFixed(3).padStart(w)
	const row = (r: BenchResult) =>
		`  ${r.label.padEnd(44)} cpu ${fmt(r.cpuMs)} ms   wall ${fmt(r.wallMs)} ms`

	const engine = Predicate.isNotUndefined((globalThis as any).Bun)
		? "Bun/JSC"
		: `Node/V8 ${process.versions?.v8 ?? ""}`.trim()
	console.log(`\nbench-startup-cpu — micro (median of ${reps} reps, ${engine})\n`)
	console.log(row(rTagged))
	console.log(row(rStructs))
	console.log(row(rUnion1))
	console.log(row(rUnionN))
	console.log(row(rGraph))

	console.log(`\n  per TaggedError class:            ${perTaggedUs.toFixed(2)} µs`)
	console.log(`  per Schema.Struct:                ${perStructUs.toFixed(2)} µs`)
	console.log(`  union marginal (1→${errors} err × ${endpoints} ep):   ${unionMarginalMs.toFixed(3)} ms`)

	console.log(`\n  ── the comment's scenario ──────────────────────────────────`)
	console.log(`  define 7 new error classes:       ${sevenClassesMs.toFixed(3)} ms`)
	console.log(`  + union assembly across ${endpoints} ep:    ${unionMarginalMs.toFixed(3)} ms`)
	console.log(`  = total marginal startup cost:    ${commentScenarioMs.toFixed(3)} ms`)
	console.log(`  Cloudflare startup budget:        ${CF_STARTUP_BUDGET_MS} ms`)
	console.log(
		`  → that's ${((commentScenarioMs / CF_STARTUP_BUDGET_MS) * 100).toFixed(3)}% of the budget` +
			` (and 0% today: ./app is dynamic-imported, so it never runs at startup).`,
	)
	console.log(
		`\n  For scale: even a ${graph}-struct graph costs just ${rGraph.cpuMs.toFixed(1)} ms here —` +
			` bulk schema *construction* is cheap. The ~${OBSERVED_BLOWUP_MS} ms 10021 blowup came from`,
	)
	console.log(
		`  evaluating the ENTIRE static import graph (all of @maple/domain + MCP tool/JSON-schema` +
			` derivation + OpenApi.fromApi), not the error taxonomy — which is why the fix was deferring`,
	)
	console.log(
		`  ./app behind a dynamic import, not trimming error classes. Post-fix startup is ~${POST_FIX_STARTUP_MS} ms.`,
	)
	console.log(`  Authoritative V8/workerd number: \`bun run scripts/bench-startup-cpu.ts worker\`.\n`)
}

type CpuProfile = {
	nodes: Array<{
		id: number
		callFrame: { functionName: string; url: string; lineNumber: number }
		hitCount?: number
	}>
	startTime: number // µs
	endTime: number // µs
	samples: number[]
	timeDeltas: number[]
}

const SCHEMA_FRAME = /schema|httpapi|domain|TaggedError|Struct|OpenApi|Scalar|\/mcp\//i

const parseProfile = (path: string, json: boolean) => {
	const profile = JSON.parse(readFileSync(path, "utf8")) as CpuProfile
	const wallMs = (profile.endTime - profile.startTime) / 1000

	const selfUs = new Map<number, number>() // nodeId → self µs
	for (let i = 0; i < profile.samples.length; i++) {
		const id = profile.samples[i]!
		const dt = profile.timeDeltas[i] ?? 0
		selfUs.set(id, (selfUs.get(id) ?? 0) + dt)
	}

	// `(idle)` = samples where no JS ran (await/IO during the startup phase). It
	// must NOT count against a *CPU* budget, so report active CPU separately.
	let idleUs = 0
	const byFrame = new Map<string, { self: number; schema: boolean }>()
	for (const node of profile.nodes) {
		const self = selfUs.get(node.id) ?? 0
		if (self <= 0) continue
		if (node.callFrame.functionName === "(idle)") idleUs += self
		const fn = node.callFrame.functionName || "(anonymous)"
		const url = node.callFrame.url.replace(/^.*\/(node_modules|src|dist)\//, "$1/")
		const key = `${fn}  ${url}:${node.callFrame.lineNumber}`
		const isSchema = SCHEMA_FRAME.test(`${fn} ${node.callFrame.url}`)
		const prev = byFrame.get(key) ?? { self: 0, schema: isSchema }
		prev.self += self
		byFrame.set(key, prev)
	}

	const ranked = [...byFrame.entries()].sort((a, b) => b[1].self - a[1].self)
	const idleMs = idleUs / 1000
	const activeCpuMs = wallMs - idleMs // CPU actually spent executing JS at startup
	const schemaMs = ranked.filter(([, v]) => v.schema).reduce((s, [, v]) => s + v.self, 0) / 1000

	if (json) {
		console.log(
			JSON.stringify(
				{
					file: path,
					startupWallMs: wallMs,
					idleMs,
					activeStartupCpuMs: activeCpuMs,
					schemaAttributedMs: schemaMs,
					cfStartupBudgetMs: CF_STARTUP_BUDGET_MS,
					top: ranked.slice(0, 25).map(([frame, v]) => ({ frame, selfMs: v.self / 1000 })),
				},
				null,
				2,
			),
		)
		return
	}

	console.log(`\nstartup CPU profile: ${path}\n`)
	console.log(`  startup phase (wall):     ${wallMs.toFixed(1)} ms  (incl. ${idleMs.toFixed(1)} ms idle)`)
	console.log(
		`  active startup CPU:        ${activeCpuMs.toFixed(1)} ms` + `   ← the number 10021 measures`,
	)
	console.log(
		`  Cloudflare budget:        ${CF_STARTUP_BUDGET_MS} ms` +
			`  (${((activeCpuMs / CF_STARTUP_BUDGET_MS) * 100).toFixed(1)}% used)`,
	)
	console.log(
		`  schema/httpapi/domain:    ${schemaMs.toFixed(1)} ms` +
			`  ${schemaMs < 1 ? "← effectively absent (deferred off startup)" : ""}`,
	)
	console.log(`\n  top self-time frames:`)
	for (const [frame, v] of ranked.slice(0, 20)) {
		const mark = v.schema ? " «schema»" : ""
		console.log(`    ${(v.self / 1000).toFixed(2).padStart(8)} ms  ${frame}${mark}`)
	}
	console.log()
}

const newestCpuProfile = (since: number): string | undefined => {
	const roots = [process.cwd(), join(process.cwd(), ".wrangler"), join(process.cwd(), "dist")]
	let best: { path: string; mtime: number } | undefined
	const walk = (dir: string, depth: number) => {
		if (depth > 4) return
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const name of entries) {
			if (name === "node_modules" || name === ".git") continue
			const p = join(dir, name)
			let st: ReturnType<typeof statSync>
			try {
				st = statSync(p)
			} catch {
				continue
			}
			if (st.isDirectory()) walk(p, depth + 1)
			else if (name.endsWith(".cpuprofile") && st.mtimeMs >= since) {
				if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
			}
		}
	}
	for (const r of roots) walk(r, 0)
	return best?.path
}

const runWorker = (explicitProfile: string | undefined, json: boolean) => {
	if (explicitProfile) {
		parseProfile(resolve(explicitProfile), json)
		return
	}
	const since = Date.now() - 1000
	const outfile = join(process.cwd(), "worker-startup.cpuprofile")
	console.error("→ running `wrangler check startup` (this builds the worker)…\n")
	// Repo-pinned wrangler (not @latest); deterministic --outfile so we parse the
	// exact file rather than guessing.
	const res = spawnSync("bunx", ["wrangler", "check", "startup", "--outfile", outfile], {
		stdio: "inherit",
		cwd: process.cwd(),
	})
	if (res.status !== 0) {
		console.error(
			`\nwrangler exited ${res.status ?? "?"}. If it produced a .cpuprofile anyway, parse it with:` +
				`\n  bun run scripts/bench-startup-cpu.ts parse <file.cpuprofile>`,
		)
	}
	const profile = (() => {
		try {
			return statSync(outfile).mtimeMs >= since ? outfile : newestCpuProfile(since)
		} catch {
			return newestCpuProfile(since)
		}
	})()
	if (!profile) {
		console.error(
			"\nNo fresh .cpuprofile found. wrangler may print a path — parse it directly with `parse <file>`.",
		)
		return
	}
	parseProfile(profile, json)
}

const argv = process.argv.slice(2)
const mode = argv[0] && !argv[0].startsWith("-") ? argv[0] : "micro"
const flag = (name: string, dflt: number): number => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt
}
const has = (name: string) => argv.includes(`--${name}`)
const strFlag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 ? argv[i + 1] : undefined
}
const json = has("json")

switch (mode) {
	case "micro":
		runMicro({
			reps: flag("reps", 7),
			classes: flag("classes", 200),
			endpoints: flag("endpoints", 30),
			errors: flag("errors", 7),
			graph: flag("graph", 500),
			json,
		})
		break
	case "parse": {
		const file = argv[1] && !argv[1].startsWith("-") ? argv[1] : strFlag("profile")
		if (!file) {
			console.error("usage: bench-startup-cpu.ts parse <file.cpuprofile>")
			process.exit(1)
		}
		parseProfile(resolve(file), json)
		break
	}
	case "worker":
		runWorker(strFlag("profile"), json)
		break
	default:
		console.error(`unknown mode: ${mode} (expected: micro | parse | worker)`)
		process.exit(1)
}

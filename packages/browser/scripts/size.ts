#!/usr/bin/env bun
/**
 * Measure what installing `@maple-dev/browser` actually costs a page.
 *
 * The number that matters is not the size of our `dist/` — that ships
 * unminified and with every dependency left external, so reading it tells you
 * almost nothing. What a visitor downloads is the *bundled, minified, gzipped*
 * graph their bundler produces, OpenTelemetry and rrweb included. This builds
 * exactly that and splits it two ways:
 *
 *   eager — the entry plus everything statically reachable from it. Paid by
 *           every visitor on every page load, before any sampling decision.
 *   lazy  — reachable only through `import()`. Paid only by visitors sampled
 *           into replay, which is the entire point of the code split.
 *
 * A regression in `eager` is the expensive kind: it hits 100% of page loads.
 * The budgets below fail CI so that cost has to be argued for in review rather
 * than discovered in a customer's Lighthouse report.
 */
import { gzipSync } from "node:zlib"

/** Ceilings in gzipped KB. Raise deliberately, with the reason in the commit. */
const BUDGET = {
	eager: 37,
	lazy: 68,
	/**
	 * Our own eager code, with OpenTelemetry and rrweb left external.
	 *
	 * Tracked separately because the headline `eager` number is dominated by
	 * OTel, which many host apps already ship — for them the marginal cost of
	 * this SDK is this line, not that one. It is also the only figure a change
	 * to our source can move — the other two are ~90% third-party and would
	 * absorb a doubling of our code without crossing a ceiling — so this is the
	 * one that makes a regression legible. Kept deliberately tight.
	 */
	firstParty: 5,
}

/** How close to a ceiling counts as worth warning about. */
const WARN_AT = 0.9

const KB = 1024
const kb = (bytes: number): number => bytes / KB
const fmt = (bytes: number): string => `${kb(bytes).toFixed(2)} kB`

const build = async (external: string[] = []) => {
	const result = await Bun.build({
		entrypoints: ["./src/index.ts"],
		target: "browser",
		format: "esm",
		minify: true,
		splitting: true,
		external,
		throw: false,
	})
	if (!result.success) {
		console.error("build failed:")
		for (const log of result.logs) console.error(log)
		process.exit(1)
	}
	return result
}

const result = await build()

interface Chunk {
	readonly name: string
	readonly raw: number
	readonly gzip: number
	readonly text: string
}

const measure = async (outputs: Array<{ path: string; text: () => Promise<string> }>): Promise<Chunk[]> =>
	Promise.all(
		outputs.map(async (output) => {
			const text = await output.text()
			const raw = Buffer.byteLength(text)
			return { name: output.path.replace(/^.*\//, ""), raw, gzip: gzipSync(text).length, text }
		}),
	)

const chunks = await measure(result.outputs)

const entry = chunks.find((chunk) => chunk.name.startsWith("index.")) ?? chunks[0]!

/**
 * Walk static imports from the entry. Anything reached this way lands in the
 * eager graph; everything else is behind an `import()` and only downloads when
 * that import runs.
 */
const eagerNames = new Set<string>([entry.name])
const queue = [entry]
while (queue.length > 0) {
	const chunk = queue.pop()!
	for (const match of chunk.text.matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)) {
		const name = match[1]!
		if (eagerNames.has(name)) continue
		const next = chunks.find((candidate) => candidate.name === name)
		if (!next) continue
		eagerNames.add(name)
		queue.push(next)
	}
}

const eager = chunks.filter((chunk) => eagerNames.has(chunk.name))
const lazy = chunks.filter((chunk) => !eagerNames.has(chunk.name))
const total = (group: Chunk[]): number => group.reduce((sum, chunk) => sum + chunk.gzip, 0)

// Same entry, dependencies left external: what a host app that already ships
// OpenTelemetry pays to add this SDK. The lazy chunk is rrweb-dominated and
// disappears entirely here, so only the eager side is meaningful.
const firstParty = await measure((await build(["@opentelemetry/*", "rrweb"])).outputs)
const firstPartyEager = firstParty.filter((chunk) => chunk.name.startsWith("index."))

const report = (label: string, group: Chunk[], budget: number): boolean => {
	const gzip = total(group)
	const ratio = kb(gzip) / budget
	const state = ratio > 1 ? "OVER" : ratio > WARN_AT ? "near" : "ok"
	console.log(`\n${label}  ${fmt(gzip)} gzipped  (budget ${budget} kB — ${state})`)
	for (const chunk of [...group].sort((a, b) => b.gzip - a.gzip)) {
		console.log(
			`    ${chunk.name.padEnd(32)} ${fmt(chunk.raw).padStart(11)} → ${fmt(chunk.gzip)} gzipped`,
		)
	}
	return ratio <= 1
}

console.log("@maple-dev/browser — bundled, minified, gzipped")
const eagerOk = report("eager  every page load ", eager, BUDGET.eager)
const lazyOk = report("lazy   sampled sessions", lazy, BUDGET.lazy)
const firstPartyOk = report("ours   eager, deps external", firstPartyEager, BUDGET.firstParty)

if (!eagerOk || !lazyOk || !firstPartyOk) {
	console.error("\nbundle size exceeds budget — raise it in scripts/size.ts if the cost is intended")
	process.exit(1)
}

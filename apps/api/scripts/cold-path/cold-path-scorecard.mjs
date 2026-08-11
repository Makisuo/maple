// cold-path-scorecard.mjs — one-shot local measurement of maple-api's cold-path cost.
// Usage: node cold-path-scorecard.mjs <bundle-dir>   (bundle built via alchemy rolldown, SEO off)
// Metrics: startup-graph size/eval/heap, full-graph eval/heap, registry reachability.
// Budgets (desktop-V8 proxies for workerd): startup eval <=150ms, startup heap <=40MB.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

const dir = process.argv[2]
if (!dir) { console.error('usage: node cold-path-scorecard.mjs <bundle-dir>'); process.exit(1) }
const js = readdirSync(dir).filter((f) => f.endsWith('.js'))
const src = Object.fromEntries(js.map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
const size = (f) => statSync(join(dir, f)).size
const staticImports = (f) => [...(src[f]?.matchAll(/from"\.\/([^"]+\.js)"/g) ?? [])].map((m) => m[1])
const allImports = (f) => [...staticImports(f), ...[...(src[f]?.matchAll(/import\([`"]\.\/([^`"]+\.js)[`"]\)/g) ?? [])].map((m) => m[1])]
const closure = (roots, edges) => { const seen = new Set(); const q = [...roots]; while (q.length) { const f = q.pop(); if (seen.has(f)) continue; seen.add(f); q.push(...edges(f)) } return seen }

const startup = closure(['worker.js'], staticImports)
const full = closure(['worker.js'], allImports)
const mb = (n) => Math.round(n / 1e4) / 100
const sum = (set) => mb([...set].reduce((a, f) => a + (src[f] ? size(f) : 0), 0))
const registry = js.find((f) => f.startsWith('registry-'))
const httpGraph = js.find((f) => f.startsWith('http-graph-'))

globalThis.caches ??= { open: async () => ({}), default: {} }
globalThis.HTMLRewriter ??= class {}
const base = 'file://' + resolve(dir) + '/'
global.gc?.()
const h0 = process.memoryUsage().heapUsed
let t = performance.now()
await import(new URL('worker.js', base).href).catch((e) => console.error('startup eval error:', String(e).slice(0, 120)))
const startupMs = Math.round(performance.now() - t)
global.gc?.()
const startupHeap = mb(process.memoryUsage().heapUsed - h0) * 10
t = performance.now()
if (httpGraph) await import(new URL(httpGraph, base).href).catch((e) => console.error('http-graph eval error:', String(e).slice(0, 120)))
const httpGraphMs = Math.round(performance.now() - t)
global.gc?.()
const fullHeap = mb(process.memoryUsage().heapUsed - h0) * 10

const startupHasRegistry = registry && startup.has(registry)
const budgets = { startupEvalMs: 150, startupHeapMB: 40 }
const result = {
  chunks: { total: js.length, startup: startup.size, dynamic: js.length - startup.size },
  sizeMB: { total: sum(new Set(js)), startupGraph: sum(startup), dynamicGraph: mb([...js].reduce((a, f) => a + size(f), 0) - [...startup].reduce((a, f) => a + size(f), 0)) },
  evalMs: { startupGraph: startupMs, plusHttpGraph: httpGraphMs },
  heapMB: { startupGraph: Math.round(startupHeap * 10) / 100, fullGraph: Math.round(fullHeap * 10) / 100 },
  registry: registry ? { file: registry, sizeMB: mb(size(registry)), inStartupGraph: !!startupHasRegistry } : null,
  verdict: {
    startupEvalBudget: `${startupMs}ms / ${budgets.startupEvalMs}ms desktop proxy (${startupMs <= budgets.startupEvalMs ? 'OK' : 'OVER'})`,
    startupHeapBudget: `${Math.round(startupHeap * 10) / 100}MB / ${budgets.startupHeapMB}MB (${startupHeap / 10 <= budgets.startupHeapMB ? 'OK' : 'OVER'})`,
  },
}
console.log(JSON.stringify(result, null, 2))

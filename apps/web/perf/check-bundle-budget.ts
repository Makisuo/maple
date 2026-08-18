// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { join } from "node:path"

interface ManifestChunk {
	file: string
	imports?: string[]
}

const DIST = join(import.meta.dirname, "..", "dist")
const manifest = JSON.parse(readFileSync(join(DIST, ".vite", "manifest.json"), "utf8")) as Record<
	string,
	ManifestChunk
>

const entryKey = "index.html"
if (!manifest[entryKey])
	throw new Error("Vite manifest has no index.html entry; run the production build first")

const staticGraph = new Set<string>()
const visit = (key: string) => {
	if (staticGraph.has(key)) return
	const chunk = manifest[key]
	if (!chunk) throw new Error(`Manifest import ${key} is missing`)
	staticGraph.add(key)
	for (const imported of chunk.imports ?? []) visit(imported)
}
visit(entryKey)

const chunks = [...staticGraph].map((key) => {
	const file = manifest[key]!.file
	const source = readFileSync(join(DIST, file))
	return { key, file, gzipBytes: gzipSync(source).byteLength }
})
const gzipBytes = chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0)
const maxGzipBytes = 650 * 1024

// Anything lazy-only: chat, replay, and every dev-only lab surface. The
// `src/routes/lab/*` shells are legitimately static (file-based routing has no
// per-environment tree), and `src/lab/registry.ts` is inlined into startup by
// design (the auth gate reads it) — only the routes' split chunks and any
// `src/lab/` module that becomes a chunk of its own are forbidden.
const forbiddenStartupPatterns = [
	/src\/lab\//,
	/src\/routes\/lab\/.*\?tsr-split/,
	/src\/components\/chat\/global-chat-(?:content|panel)/,
	/src\/routes\/chat\.tsx\?tsr-split/,
	/replay-player/,
	/replay-studio/,
	/effect-sdk\/dist\/replay-/,
]
const forbidden = [...staticGraph].filter((key) =>
	forbiddenStartupPatterns.some((pattern) => pattern.test(key)),
)

console.log(
	`Initial static JS: ${(gzipBytes / 1024).toFixed(1)} KB gzip across ${chunks.length} chunks (budget: 650.0 KB)`,
)
for (const chunk of chunks.sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 10)) {
	console.log(`  ${(chunk.gzipBytes / 1024).toFixed(1).padStart(7)} KB  ${chunk.file}`)
}

if (forbidden.length > 0) {
	throw new Error(`Lazy-only code (chat/replay/lab) leaked into startup:\n${forbidden.join("\n")}`)
}
if (gzipBytes > maxGzipBytes) {
	throw new Error(`Initial static JS is ${(gzipBytes / 1024).toFixed(1)} KB gzip; budget is 650.0 KB`)
}

#!/usr/bin/env node
// Every guide cites the test that backs its snippets, and that promise is the
// package's quality claim. It had already rotted in two places — a citation
// naming a test that does not exist reads as backed and is not.
//
// A script rather than a test: the citation lives in Markdown, and reading the
// filesystem from `src/` would mean putting Node's types on a package whose
// point is that it runs anywhere.
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const self = readFileSync(join(root, "src/docs-examples.test.ts"), "utf8")
const names = new Set([...self.matchAll(/it(?:\.effect)?\("([^"]+)"/g)].map((m) => m[1]))

const docs = join(root, "docs")
const files = [...readdirSync(docs).map((f) => join(docs, f)), join(root, "README.md")].filter((f) =>
	f.endsWith(".md"),
)

const dangling = []
for (const file of files) {
	for (const m of readFileSync(file, "utf8").matchAll(/Backed by `docs\/[^>]+> ([^`]+)`/g)) {
		if (!names.has(m[1])) dangling.push(`${file.slice(root.length + 1)}: "${m[1]}"`)
	}
}

if (dangling.length > 0) {
	console.error("Doc citations naming a test that does not exist:\n  " + dangling.join("\n  "))
	process.exit(1)
}
console.log(`doc citations ok (${files.length} files)`)

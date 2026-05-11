#!/usr/bin/env node
// Patch the Electric Agents runtime container's bundled
// `@electric-ax/durable-streams-server-beta` so spawning a stream no longer
// crashes with `TypeError: Cannot read properties of undefined (reading 'producers')`.
//
// Bug: `FileBackedStreamStore.create()` does `await this.db.put(key, streamMeta)`
// followed by `const updated = this.db.get(key)`, but under load the LMDB read
// occasionally returns `undefined`, then `streamMetaToStream(undefined)` throws.
// Net effect for Maple: every brand-new chat session 500s, postgres has an
// orphan entity row, and the durable stream never gets created.
//
// Fix: fall back to the in-memory `streamMeta` we already wrote. The data is
// still in LMDB; this just avoids depending on the racy read-after-write.
//
// The patch lives inside the container's filesystem. `docker compose down`
// removes the container, so we re-apply on every `runtime:start`. The script
// is idempotent — if a `MAPLE_PATCH_FBS` marker is present it does nothing.
// When the patch is newly applied we `docker restart` the container so the
// node process re-imports the patched file.

import { execSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CONTAINER = process.env.ELECTRIC_AGENTS_CONTAINER ?? "electric-agents-electric-agents-1"
const TARGET_FILE =
	"/prod/agents-server/node_modules/.pnpm/@electric-ax+durable-streams-server-beta@0.3.2_typescript@5.8.3/node_modules/@electric-ax/durable-streams-server-beta/dist/index.js"
const MARKER = "MAPLE_PATCH_FBS"

const sh = (cmd, opts = {}) =>
	execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })

const waitForContainer = (timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const state = sh(`docker inspect -f '{{.State.Running}}' ${CONTAINER}`).trim()
			if (state === "true") return true
		} catch {
			// container doesn't exist yet
		}
		spawnSync("sleep", ["1"])
	}
	return false
}

const waitForReady = (port, timeoutMs = 45_000) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			sh(`curl -fsS -m 2 -o /dev/null http://localhost:${port}/_electric/entity-types`)
			return true
		} catch {
			// not ready
		}
		spawnSync("sleep", ["1"])
	}
	return false
}

if (!waitForContainer()) {
	console.error(`[patch-runtime] container ${CONTAINER} did not appear within 30s`)
	process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), "maple-patch-runtime-"))
const localPath = join(tmp, "index.js")

try {
	sh(`docker cp ${CONTAINER}:${TARGET_FILE} ${localPath}`)
	const original = readFileSync(localPath, "utf8")

	if (original.includes(MARKER)) {
		console.log("[patch-runtime] FileBackedStreamStore patch already present, skipping.")
		process.exit(0)
	}

	// Two racy reads to fix:
	//   1) `const updatedMeta = this.db.get(key);` inside `if (options.closed)`
	//   2) `const updated = this.db.get(key);` right before the slow-log block,
	//      uniquely identified by the `const totalMs` line that follows it.
	const replacements = [
		{
			from: /const updatedMeta = this\.db\.get\(key\);/g,
			to: `const updatedMeta = this.db.get(key) ?? streamMeta; /* ${MARKER} */`,
		},
		{
			from: /const updated = this\.db\.get\(key\);\n(\s+const totalMs)/,
			to: `const updated = this.db.get(key) ?? streamMeta; /* ${MARKER} */\n$1`,
		},
	]

	let patched = original
	for (const { from, to } of replacements) {
		const before = patched
		patched = patched.replace(from, to)
		if (patched === before) {
			console.error(
				`[patch-runtime] replacement did not match — upstream library may have shifted. ` +
					`Pattern: ${from}`,
			)
			process.exit(1)
		}
	}

	const markerCount = (patched.match(new RegExp(MARKER, "g")) ?? []).length
	if (markerCount < 2) {
		console.error(
			`[patch-runtime] expected 2 patch markers after substitution, got ${markerCount}.`,
		)
		process.exit(1)
	}

	writeFileSync(localPath, patched)
	sh(`docker cp ${localPath} ${CONTAINER}:${TARGET_FILE}`)
	console.log(`[patch-runtime] applied (${markerCount} markers). Restarting container...`)
	sh(`docker restart ${CONTAINER}`)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}

const port = process.env.ELECTRIC_AGENTS_PORT ?? "4438"
if (!waitForReady(port)) {
	console.error(`[patch-runtime] container did not become ready on :${port} within 45s`)
	process.exit(1)
}
console.log("[patch-runtime] container restarted and ready.")

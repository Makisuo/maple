import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Schema } from "effect"
import { MapleCloudEventSchema, SignalProjectionSpecSchema, SignalScalarSchema } from "../src/model"

const root = resolve(import.meta.dirname, "..")
const check = process.argv.includes("--check")

const documents = [
	{
		path: "schemas/signal-scalar.v1.schema.json",
		id: "urn:maple:eventing:schema:signal-scalar:v1",
		schema: SignalScalarSchema,
	},
	{
		path: "schemas/signal-projection.v1.schema.json",
		id: "urn:maple:eventing:schema:signal-projection:v1",
		schema: SignalProjectionSpecSchema,
	},
	{
		path: "schemas/cloud-event.v1.schema.json",
		id: "urn:maple:eventing:schema:cloud-event:v1",
		schema: MapleCloudEventSchema,
	},
] as const

let stale = false
for (const entry of documents) {
	const document = Schema.toJsonSchemaDocument(entry.schema)
	const unformatted = `${JSON.stringify(
		{
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: entry.id,
			...document.schema,
			...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
		},
		null,
		"\t",
	)}\n`
	const serialized = execFileSync(
		resolve(root, "../../node_modules/.bin/oxfmt"),
		["--stdin-filepath", entry.path],
		{
			input: unformatted,
			encoding: "utf8",
		},
	)
	const path = resolve(root, entry.path)
	if (check) {
		if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
			console.error(`${entry.path} is stale; run bun run schemas`)
			stale = true
		}
	} else {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, serialized)
	}
}

if (stale) process.exitCode = 1

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildTinybirdProjectManifest,
  renderTinybirdProjectManifestModule,
} from "../packages/domain/src/tinybird/project-manifest"

const outputPath = fileURLToPath(
  new URL("../packages/domain/src/generated/tinybird-project-manifest.ts", import.meta.url),
)
const checkMode = process.argv.includes("--check")

const manifest = await buildTinybirdProjectManifest()
const renderedModule = renderTinybirdProjectManifestModule(manifest)
let existingModule = ""

try {
  existingModule = readFileSync(outputPath, "utf8")
} catch {
  existingModule = ""
}

if (checkMode) {
  if (existingModule !== renderedModule) {
    console.error("Tinybird project manifest is out of date. Run `bun run tinybird:manifest`.")
    process.exit(1)
  }

  console.log(`Tinybird project manifest is up to date (${manifest.projectRevision}).`)
} else {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderedModule)
  console.log(`Wrote Tinybird project manifest (${manifest.projectRevision}) to ${outputPath}.`)
}

import { applyD1Migrations } from "@maple/db/migrate-d1"
import { ensureLocalD1Sqlite } from "@maple/db/migrate-d1-local"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDir = resolve(appDir, "../../packages/db/drizzle")

const sqlitePath = await ensureLocalD1Sqlite({
  bindingName: "MAPLE_DB",
  cwd: appDir,
})

const { applied } = await applyD1Migrations({
  target: { kind: "local", sqlitePath },
  migrationsDir,
})

if (applied.length === 0) {
  console.log("[d1] no new migrations")
} else {
  console.log(
    `[d1] applied ${applied.length} migration(s): ${applied.join(", ")}`,
  )
}

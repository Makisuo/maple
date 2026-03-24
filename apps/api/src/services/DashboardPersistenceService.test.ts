import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect"
import {
  DashboardId,
  DashboardDocument,
  DashboardNotFoundError,
  DashboardPersistenceError,
  IsoDateTimeString,
  OrgId,
  PortableDashboardDocument,
  UserId,
} from "@maple/domain/http"
import { Database as DatabaseService } from "./DatabaseLive"
import { DashboardPersistenceService } from "./DashboardPersistenceService"
import { Env } from "./Env"

const createdTempDirs: string[] = []

afterEach(() => {
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (!Exit.isFailure(exit)) return undefined

  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure !== undefined) return failure

  return Cause.squash(exit.cause)
}

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-dashboards-"))
  createdTempDirs.push(dir)

  const dbPath = join(dir, "maple.db")
  const db = new Database(dbPath)
  db.close()

  return `file:${dbPath}`
}

const testConfigProvider = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      MCP_PORT: "3473",
      TINYBIRD_HOST: "https://api.tinybird.co",
      TINYBIRD_TOKEN: "test-token",
      MAPLE_DB_URL: url,
      MAPLE_DB_AUTH_TOKEN: "",
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
      CLERK_JWT_KEY: "",
    }),
  )

const makeLayer = (url: string) =>
  DashboardPersistenceService.Live.pipe(
    Layer.provide(DatabaseService.Default),
    Layer.provide(Env.Default),
    Layer.provide(testConfigProvider(url)),
  )

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeDashboard = (
  overrides: Partial<DashboardDocument> = {},
): DashboardDocument =>
  new DashboardDocument({
    id: asDashboardId("dash-1"),
    name: "Dashboard",
    timeRange: {
      type: "relative",
      value: "12h",
    },
    widgets: [],
    createdAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
    updatedAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
    ...overrides,
  })

const makePortableDashboard = (
  overrides: Partial<PortableDashboardDocument> = {},
): PortableDashboardDocument =>
  new PortableDashboardDocument({
    name: "Portable Dashboard",
    timeRange: {
      type: "relative",
      value: "12h",
    },
    widgets: [],
    ...overrides,
  })

describe("DashboardPersistenceService", () => {
  it("lists dashboards only for the requested org", async () => {
    const dbUrl = createTempDbUrl()

    const program = Effect.gen(function* () {
      yield* DashboardPersistenceService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        makeDashboard({ id: asDashboardId("a-1"), name: "Org A" }),
      )
      yield* DashboardPersistenceService.upsert(
        asOrgId("org_b"),
        asUserId("user_b"),
        makeDashboard({ id: asDashboardId("b-1"), name: "Org B" }),
      )
      return yield* DashboardPersistenceService.list(asOrgId("org_a"))
    }).pipe(Effect.provide(makeLayer(dbUrl)))

    const dashboards = await Effect.runPromise(program)

    expect(dashboards.dashboards).toHaveLength(1)
    expect(dashboards.dashboards[0]!.id).toBe(asDashboardId("a-1"))
    expect(dashboards.dashboards[0]!.name).toBe("Org A")
  })

  it("upserts by replacing existing dashboard rows for the same org/id", async () => {
    const dbUrl = createTempDbUrl()

    const original = makeDashboard({
      id: asDashboardId("dash-1"),
      name: "First Name",
      updatedAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
    })

    const updated = makeDashboard({
      id: asDashboardId("dash-1"),
      name: "Second Name",
      updatedAt: asIsoDateTimeString(new Date("2026-01-01T01:00:00.000Z").toISOString()),
    })

    const program = Effect.gen(function* () {
      yield* DashboardPersistenceService.upsert(asOrgId("org_a"), asUserId("user_a"), original)
      yield* DashboardPersistenceService.upsert(asOrgId("org_a"), asUserId("user_a"), updated)
      return yield* DashboardPersistenceService.list(asOrgId("org_a"))
    }).pipe(Effect.provide(makeLayer(dbUrl)))

    const dashboards = await Effect.runPromise(program)

    expect(dashboards.dashboards).toHaveLength(1)
    expect(dashboards.dashboards[0]!.name).toBe("Second Name")
    expect(dashboards.dashboards[0]!.updatedAt).toBe(updated.updatedAt)
  })

  it("creates dashboards from the portable import payload with fresh metadata", async () => {
    const dbUrl = createTempDbUrl()

    const program = Effect.gen(function* () {
      const created = yield* DashboardPersistenceService.create(
        asOrgId("org_a"),
        asUserId("user_a"),
        makePortableDashboard({
          name: "Imported Dashboard",
          description: "Imported from JSON",
          tags: ["imported"],
        }),
      )

      const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))

      return { created, listed }
    }).pipe(Effect.provide(makeLayer(dbUrl)))

    const { created, listed } = await Effect.runPromise(program)

    expect(created.id).toBeTypeOf("string")
    expect(created.name).toBe("Imported Dashboard")
    expect(created.description).toBe("Imported from JSON")
    expect(created.tags).toEqual(["imported"])
    expect(created.widgets).toEqual([])
    expect(created.createdAt).toBeTypeOf("string")
    expect(created.updatedAt).toBeTypeOf("string")
    expect(listed.dashboards).toHaveLength(1)
    expect(listed.dashboards[0]!.id).toBe(created.id)
  })

  it("returns DashboardNotFoundError when deleting a missing dashboard", async () => {
    const dbUrl = createTempDbUrl()

    const program = DashboardPersistenceService.delete(
      asOrgId("org_a"),
      asDashboardId("missing"),
    ).pipe(Effect.provide(makeLayer(dbUrl)))

    const exit = await Effect.runPromiseExit(program)
    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toBeInstanceOf(DashboardNotFoundError)
  })

  it("maps database/driver errors to DashboardPersistenceError", async () => {
    const failingLayer = makeLayer("http://127.0.0.1:9")

    const exit = await Effect.runPromiseExit(
      DashboardPersistenceService.list(asOrgId("org_a")).pipe(
        Effect.provide(failingLayer),
      ),
    )

    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (failure instanceof DashboardPersistenceError) {
      expect(failure).toBeInstanceOf(DashboardPersistenceError)
      return
    }

    expect(String(failure)).toContain("DatabaseError")
  })
})

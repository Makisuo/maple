import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { hashCloudflareLogpushSecret } from "@maple/db";
import {
  CloudflareLogpushEncryptionError,
  CloudflareLogpushNotFoundError,
  CloudflareLogpushValidationError,
  OrgId,
  UserId,
} from "@maple/domain/http";
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive";
import { Env } from "./Env";
import { CloudflareLogpushService } from "./CloudflareLogpushService";

const createdTempDirs: string[] = [];

afterEach(() => {
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-cloudflare-logpush-"));
  createdTempDirs.push(dir);

  const dbPath = join(dir, "maple.db");
  const db = new Database(dbPath);
  db.close();

  return { url: `file:${dbPath}`, dbPath };
};

const makeConfig = (
  url: string,
  ingestPublicUrl = "https://ingest.example.com",
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://api.tinybird.co",
      TINYBIRD_TOKEN: "test-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
      MAPLE_INGEST_PUBLIC_URL: ingestPublicUrl,
    }),
  );

const makeLayer = (url: string, ingestPublicUrl?: string) =>
  CloudflareLogpushService.Live.pipe(
    Layer.provide(DatabaseLibsqlLive),
    Layer.provide(Env.Default),
    Layer.provide(makeConfig(url, ingestPublicUrl)),
  );

const asOrgId = Schema.decodeUnknownSync(OrgId);
const asUserId = Schema.decodeUnknownSync(UserId);

describe("CloudflareLogpushService", () => {
  it("creates a connector with encrypted secret and generated setup", async () => {
    const { url, dbPath } = createTempDbUrl();

    const result = await Effect.runPromise(
      CloudflareLogpushService.create(asOrgId("org_a"), asUserId("user_a"), {
        name: "Edge requests",
        zoneName: "example.com",
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.connector.serviceName).toBe("cloudflare/example.com");
    expect(result.connector.dataset).toBe("http_requests");
    expect(result.setup.destinationConf).toStartWith(
      `https://ingest.example.com/v1/logpush/cloudflare/http_requests/${result.connector.id}?secret=maple_cf_`,
    );

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query(
        "SELECT secret_ciphertext, secret_hash FROM cloudflare_logpush_connectors WHERE id = ?",
      )
      .get(result.connector.id) as
      | {
          secret_ciphertext: string;
          secret_hash: string;
        }
      | undefined;
    db.close();

    const secret = new URL(result.setup.destinationConf).searchParams.get("secret")!;
    expect(row).toBeDefined();
    expect(row?.secret_ciphertext).not.toBe(secret);
    expect(row?.secret_hash).toBe(
      hashCloudflareLogpushSecret(
        secret,
        "maple-test-lookup-secret",
      ),
    );
  });

  it("lists connectors without exposing secrets", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* CloudflareLogpushService.create(asOrgId("org_a"), asUserId("user_a"), {
          name: "Edge requests",
          zoneName: "example.com",
        });

        return yield* CloudflareLogpushService.list(asOrgId("org_a"));
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.connectors).toHaveLength(1);
    expect("secret" in result.connectors[0]!).toBe(false);
  });

  it("returns deterministic setup payload for an existing connector", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          asOrgId("org_a"),
          asUserId("user_a"),
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const setup = yield* CloudflareLogpushService.getSetup(
          asOrgId("org_a"),
          created.connector.id,
        );

        return { created, setup };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.setup.destinationConf).toBe(
      result.created.setup.destinationConf,
    );
  });

  it("rotates only the secret", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          asOrgId("org_a"),
          asUserId("user_a"),
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const rotated = yield* CloudflareLogpushService.rotateSecret(
          asOrgId("org_a"),
          created.connector.id,
          asUserId("user_b"),
        );
        const connector = yield* CloudflareLogpushService.list(asOrgId("org_a")).pipe(
          Effect.map((rows) => rows.connectors[0]!),
        );

        return { created, rotated, connector };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.rotated.destinationConf).not.toBe(result.created.setup.destinationConf);
    expect(result.connector.name).toBe(result.created.connector.name);
    expect(result.connector.zoneName).toBe(result.created.connector.zoneName);
  });

  it("updates metadata without changing the secret", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          asOrgId("org_a"),
          asUserId("user_a"),
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const updated = yield* CloudflareLogpushService.update(
          asOrgId("org_a"),
          created.connector.id,
          asUserId("user_b"),
          {
            name: "Zone A",
            zoneName: "zone-a.example.com",
            serviceName: "cloudflare/zone-a",
            enabled: false,
          },
        );
        const setup = yield* CloudflareLogpushService.getSetup(
          asOrgId("org_a"),
          created.connector.id,
        );

        return { created, updated, setup };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.updated.name).toBe("Zone A");
    expect(result.updated.zoneName).toBe("zone-a.example.com");
    expect(result.updated.serviceName).toBe("cloudflare/zone-a");
    expect(result.updated.enabled).toBe(false);
    expect(result.setup.destinationConf).toBe(result.created.setup.destinationConf);
  });

  it("deletes a connector", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          asOrgId("org_a"),
          asUserId("user_a"),
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        yield* CloudflareLogpushService.delete(asOrgId("org_a"), created.connector.id);
        return yield* CloudflareLogpushService.list(asOrgId("org_a"));
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.connectors).toEqual([]);
  });

  it("isolates connectors by org", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          asOrgId("org_a"),
          asUserId("user_a"),
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );

        const missing = yield* CloudflareLogpushService.getSetup(
          asOrgId("org_b"),
          created.connector.id,
        ).pipe(Effect.flip);

        return missing;
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result).toBeInstanceOf(CloudflareLogpushNotFoundError);
  });

  it("rejects blank names and zone names", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      CloudflareLogpushService.create(asOrgId("org_a"), asUserId("user_a"), {
        name: " ",
        zoneName: " ",
      }).pipe(Effect.flip, Effect.provide(makeLayer(url))),
    );

    expect(result).toBeInstanceOf(CloudflareLogpushValidationError);
  });
});

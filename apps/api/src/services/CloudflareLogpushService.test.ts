import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConfigError } from "effect/ConfigError";
import { ConfigProvider, Effect, Layer } from "effect";
import { hashCloudflareLogpushSecret } from "@maple/db";
import {
  CloudflareLogpushEncryptionError,
  CloudflareLogpushNotFoundError,
  CloudflareLogpushValidationError,
} from "@maple/domain/http";
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

const makeConfigProvider = (
  url: string,
  ingestPublicUrl = "https://ingest.example.com",
) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["PORT", "3472"],
        ["TINYBIRD_HOST", "https://api.tinybird.co"],
        ["TINYBIRD_TOKEN", "test-token"],
        ["MAPLE_DB_URL", url],
        ["MAPLE_DB_AUTH_TOKEN", ""],
        ["MAPLE_AUTH_MODE", "self_hosted"],
        ["MAPLE_ROOT_PASSWORD", "test-root-password"],
        ["MAPLE_DEFAULT_ORG_ID", "default"],
        [
          "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
          Buffer.alloc(32, 7).toString("base64"),
        ],
        ["MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY", "maple-test-lookup-secret"],
        ["MAPLE_INGEST_PUBLIC_URL", ingestPublicUrl],
        ["CLERK_SECRET_KEY", ""],
        ["CLERK_PUBLISHABLE_KEY", ""],
        ["CLERK_JWT_KEY", ""],
      ]),
    ),
  );

const makeLayer = (
  url: string,
  ingestPublicUrl?: string,
): Layer.Layer<
  CloudflareLogpushService,
  CloudflareLogpushEncryptionError | ConfigError
> =>
  CloudflareLogpushService.Live.pipe(
    Layer.provide(Env.Default),
    Layer.provide(makeConfigProvider(url, ingestPublicUrl)),
  );

describe("CloudflareLogpushService", () => {
  it("creates a connector with encrypted secret and generated setup", async () => {
    const { url, dbPath } = createTempDbUrl();

    const result = await Effect.runPromise(
      CloudflareLogpushService.create("org_a", "user_a", {
        name: "Edge requests",
        zoneName: "example.com",
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.connector.serviceName).toBe("cloudflare/example.com");
    expect(result.connector.dataset).toBe("http_requests");
    expect(result.setup.endpointUrl).toBe(
      `https://ingest.example.com/v1/logpush/cloudflare/http_requests/${result.connector.id}`,
    );
    expect(result.setup.secret.startsWith("maple_cf_")).toBe(true);
    expect(result.setup.destinationConf).toContain(
      "header_X-Maple-Cloudflare-Secret=",
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

    expect(row).toBeDefined();
    expect(row?.secret_ciphertext).not.toBe(result.setup.secret);
    expect(row?.secret_hash).toBe(
      hashCloudflareLogpushSecret(
        result.setup.secret,
        "maple-test-lookup-secret",
      ),
    );
  });

  it("lists connectors without exposing secrets", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* CloudflareLogpushService.create("org_a", "user_a", {
          name: "Edge requests",
          zoneName: "example.com",
        });

        return yield* CloudflareLogpushService.list("org_a");
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result).toHaveLength(1);
    expect("secret" in result[0]).toBe(false);
  });

  it("returns deterministic setup payload for an existing connector", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          "org_a",
          "user_a",
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const setup = yield* CloudflareLogpushService.getSetup(
          "org_a",
          created.connector.id,
        );

        return { created, setup };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.setup.secret).toBe(result.created.setup.secret);
    expect(result.setup.destinationConf).toBe(
      result.created.setup.destinationConf,
    );
  });

  it("rotates only the secret", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          "org_a",
          "user_a",
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const rotated = yield* CloudflareLogpushService.rotateSecret(
          "org_a",
          created.connector.id,
          "user_b",
        );
        const connector = yield* CloudflareLogpushService.list("org_a").pipe(
          Effect.map((rows) => rows[0]!),
        );

        return { created, rotated, connector };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.rotated.secret).not.toBe(result.created.setup.secret);
    expect(result.connector.name).toBe(result.created.connector.name);
    expect(result.connector.zoneName).toBe(result.created.connector.zoneName);
  });

  it("updates metadata without changing the secret", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          "org_a",
          "user_a",
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        const updated = yield* CloudflareLogpushService.update(
          "org_a",
          created.connector.id,
          "user_b",
          {
            name: "Zone A",
            zoneName: "zone-a.example.com",
            serviceName: "cloudflare/zone-a",
            enabled: false,
          },
        );
        const setup = yield* CloudflareLogpushService.getSetup(
          "org_a",
          created.connector.id,
        );

        return { created, updated, setup };
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result.updated.name).toBe("Zone A");
    expect(result.updated.zoneName).toBe("zone-a.example.com");
    expect(result.updated.serviceName).toBe("cloudflare/zone-a");
    expect(result.updated.enabled).toBe(false);
    expect(result.setup.secret).toBe(result.created.setup.secret);
  });

  it("deletes a connector", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          "org_a",
          "user_a",
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );
        yield* CloudflareLogpushService.delete("org_a", created.connector.id);
        return yield* CloudflareLogpushService.list("org_a");
      }).pipe(Effect.provide(makeLayer(url))),
    );

    expect(result).toEqual([]);
  });

  it("isolates connectors by org", async () => {
    const { url } = createTempDbUrl();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* CloudflareLogpushService.create(
          "org_a",
          "user_a",
          {
            name: "Edge requests",
            zoneName: "example.com",
          },
        );

        const missing = yield* CloudflareLogpushService.getSetup(
          "org_b",
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
      CloudflareLogpushService.create("org_a", "user_a", {
        name: " ",
        zoneName: " ",
      }).pipe(Effect.flip, Effect.provide(makeLayer(url))),
    );

    expect(result).toBeInstanceOf(CloudflareLogpushValidationError);
  });
});

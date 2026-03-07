import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import {
  CloudflareLogpushConnectorResponse,
  CloudflareLogpushCreateResponse,
  CloudflareLogpushEncryptionError,
  CloudflareLogpushNotFoundError,
  CloudflareLogpushPersistenceError,
  CloudflareLogpushSetupResponse,
  CloudflareLogpushValidationError,
  type CreateCloudflareLogpushConnectorRequest,
  type UpdateCloudflareLogpushConnectorRequest,
} from "@maple/domain/http";
import {
  cloudflareLogpushConnectors,
  hashCloudflareLogpushSecret,
  parseCloudflareLogpushSecretHmacKey,
} from "@maple/db";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { DatabaseLive } from "./DatabaseLive";
import { Env } from "./Env";

interface EncryptedSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

const DATASET = "http_requests";
const HEADER_NAME = "X-Maple-Cloudflare-Secret";
const OUTPUT_TYPE = "ndjson";
const TIMESTAMP_FORMAT = "unixnano";

const RECOMMENDED_FIELD_NAMES = [
  "EdgeStartTimestamp",
  "EdgeEndTimestamp",
  "RayID",
  "ClientIP",
  "ClientCountry",
  "ClientRequestHost",
  "ClientRequestMethod",
  "ClientRequestURI",
  "ClientRequestProtocol",
  "ClientRequestUserAgent",
  "EdgeResponseStatus",
  "EdgeColoCode",
  "CacheCacheStatus",
  "ZoneName",
] as const;

const CLOUDFLARE_SETUP_STEPS = [
  "Open Cloudflare Logpush for the target zone and create a new job for the HTTP requests dataset.",
  "Choose HTTP as the destination type and paste the generated destination_conf value if you are using the Cloudflare API.",
  "Set the output options to NDJSON and UnixNano timestamps.",
  "Include the recommended field list exactly so Maple can map request logs consistently.",
  "Save the job and wait for Cloudflare's gzipped validation request to succeed before sending live traffic.",
] as const;

const toPersistenceError = (error: unknown) =>
  new CloudflareLogpushPersistenceError({
    message:
      error instanceof Error
        ? error.message
        : "Cloudflare Logpush persistence failed",
  });

const toEncryptionError = (message: string) =>
  new CloudflareLogpushEncryptionError({ message });

const parseEncryptionKey = (
  raw: string,
): Effect.Effect<Buffer, CloudflareLogpushEncryptionError> =>
  Effect.try({
    try: () => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new Error("MAPLE_INGEST_KEY_ENCRYPTION_KEY is required");
      }

      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length !== 32) {
        throw new Error(
          "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes",
        );
      }

      return decoded;
    },
    catch: (error) =>
      toEncryptionError(
        error instanceof Error
          ? error.message
          : "Invalid Cloudflare connector encryption key",
      ),
  });

const parseLookupHmacKey = (
  raw: string,
): Effect.Effect<string, CloudflareLogpushEncryptionError> =>
  Effect.try({
    try: () => parseCloudflareLogpushSecretHmacKey(raw),
    catch: (error) =>
      toEncryptionError(
        error instanceof Error
          ? error.message
          : "Invalid Cloudflare connector lookup HMAC key",
      ),
  });

const encryptSecret = (
  plaintext: string,
  encryptionKey: Buffer,
): Effect.Effect<EncryptedSecret, CloudflareLogpushEncryptionError> =>
  Effect.try({
    try: () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);

      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    },
    catch: (error) =>
      toEncryptionError(
        error instanceof Error
          ? error.message
          : "Failed to encrypt Cloudflare connector secret",
      ),
  });

const decryptSecret = (
  encrypted: EncryptedSecret,
  encryptionKey: Buffer,
): Effect.Effect<string, CloudflareLogpushEncryptionError> =>
  Effect.try({
    try: () => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        Buffer.from(encrypted.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
      ]);

      return plaintext.toString("utf8");
    },
    catch: () =>
      toEncryptionError("Failed to decrypt Cloudflare connector secret"),
  });

const generateSecret = () =>
  `maple_cf_${randomBytes(24).toString("base64url")}`;

const toIsoString = (value: number | null | undefined) =>
  value == null ? null : new Date(value).toISOString();

const normalizeIngestPublicUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "http://127.0.0.1:3474";
  return trimmed.replace(/\/+$/, "");
};

const cleanRequiredString = (
  label: string,
  value: string,
): Effect.Effect<string, CloudflareLogpushValidationError> => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Effect.fail(
      new CloudflareLogpushValidationError({
        message: `${label} is required`,
      }),
    );
  }

  return Effect.succeed(trimmed);
};

const cleanOptionalServiceName = (
  value: string | null | undefined,
  zoneName: string,
): Effect.Effect<string, CloudflareLogpushValidationError> => {
  if (value == null) return Effect.succeed(`cloudflare/${zoneName}`);

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Effect.fail(
      new CloudflareLogpushValidationError({
        message: "Service name cannot be empty",
      }),
    );
  }

  return Effect.succeed(trimmed);
};

export class CloudflareLogpushService extends Effect.Service<CloudflareLogpushService>()(
  "CloudflareLogpushService",
  {
    accessors: true,
    dependencies: [Env.Default],
    effect: Effect.gen(function* () {
      const db = yield* SqliteDrizzle;
      const env = yield* Env;
      const encryptionKey = yield* parseEncryptionKey(
        env.MAPLE_INGEST_KEY_ENCRYPTION_KEY,
      );
      const lookupHmacKey = yield* parseLookupHmacKey(
        env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY,
      );
      const ingestPublicUrl = normalizeIngestPublicUrl(
        env.MAPLE_INGEST_PUBLIC_URL,
      );

      const rowToConnector = (
        row: typeof cloudflareLogpushConnectors.$inferSelect,
      ) =>
        new CloudflareLogpushConnectorResponse({
          id: row.id,
          name: row.name,
          zoneName: row.zoneName,
          serviceName: row.serviceName,
          dataset: row.dataset,
          enabled: row.enabled === 1,
          lastReceivedAt: toIsoString(row.lastReceivedAt),
          lastError: row.lastError,
          secretRotatedAt: new Date(row.secretRotatedAt).toISOString(),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        });

      const buildSetup = Effect.fn("CloudflareLogpushService.buildSetup")(
        function* (row: typeof cloudflareLogpushConnectors.$inferSelect) {
          const secret = yield* decryptSecret(
            {
              ciphertext: row.secretCiphertext,
              iv: row.secretIv,
              tag: row.secretTag,
            },
            encryptionKey,
          );

          const endpointUrl = `${ingestPublicUrl}/v1/logpush/cloudflare/http_requests/${row.id}`;
          const destinationConf = `${endpointUrl}?header_${encodeURIComponent(HEADER_NAME)}=${encodeURIComponent(secret)}`;

          return new CloudflareLogpushSetupResponse({
            connectorId: row.id,
            dataset: DATASET,
            endpointUrl,
            headerName: HEADER_NAME,
            secret,
            destinationConf,
            recommendedOutputType: OUTPUT_TYPE,
            recommendedTimestampFormat: TIMESTAMP_FORMAT,
            recommendedFieldNames: [...RECOMMENDED_FIELD_NAMES],
            validationNote:
              "Cloudflare sends a gzipped validation payload during setup. Maple accepts it and returns 200 without storing a log record.",
            cloudflareSetupSteps: [...CLOUDFLARE_SETUP_STEPS],
          });
        },
      );

      const selectById = Effect.fn("CloudflareLogpushService.selectById")(
        function* (orgId: string, connectorId: string) {
          const rows = yield* db
            .select()
            .from(cloudflareLogpushConnectors)
            .where(
              and(
                eq(cloudflareLogpushConnectors.orgId, orgId),
                eq(cloudflareLogpushConnectors.id, connectorId),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError(toPersistenceError));

          return rows[0];
        },
      );

      const selectByIdOrPersistenceError = Effect.fn(
        "CloudflareLogpushService.selectByIdOrPersistenceError",
      )(function* (orgId: string, connectorId: string) {
        const row = yield* selectById(orgId, connectorId);
        if (row) return row;

        return yield* Effect.fail(
          new CloudflareLogpushPersistenceError({
            message: "Failed to load Cloudflare Logpush connector",
          }),
        );
      });

      const requireConnector = Effect.fn(
        "CloudflareLogpushService.requireConnector",
      )(function* (orgId: string, connectorId: string) {
        const row = yield* selectById(orgId, connectorId);
        if (row) return row;

        return yield* Effect.fail(
          new CloudflareLogpushNotFoundError({
            connectorId,
            message: "Cloudflare Logpush connector not found",
          }),
        );
      });

      const list = Effect.fn("CloudflareLogpushService.list")(function* (
        orgId: string,
      ) {
        const rows = yield* db
          .select()
          .from(cloudflareLogpushConnectors)
          .where(eq(cloudflareLogpushConnectors.orgId, orgId))
          .pipe(Effect.mapError(toPersistenceError));

        return rows.map(rowToConnector);
      });

      const create = Effect.fn("CloudflareLogpushService.create")(function* (
        orgId: string,
        userId: string,
        request: CreateCloudflareLogpushConnectorRequest,
      ) {
        const name = yield* cleanRequiredString("Name", request.name);
        const zoneName = yield* cleanRequiredString(
          "Zone name",
          request.zoneName,
        );
        const serviceName = yield* cleanOptionalServiceName(
          request.serviceName,
          zoneName,
        );

        const now = Date.now();
        const id = randomUUID();
        const secret = generateSecret();
        const secretHash = hashCloudflareLogpushSecret(secret, lookupHmacKey);
        const encryptedSecret = yield* encryptSecret(secret, encryptionKey);

        yield* db
          .insert(cloudflareLogpushConnectors)
          .values({
            id,
            orgId,
            name,
            zoneName,
            serviceName,
            dataset: DATASET,
            secretCiphertext: encryptedSecret.ciphertext,
            secretIv: encryptedSecret.iv,
            secretTag: encryptedSecret.tag,
            secretHash,
            enabled: request.enabled === false ? 0 : 1,
            lastReceivedAt: null,
            lastError: null,
            secretRotatedAt: now,
            createdAt: now,
            updatedAt: now,
            createdBy: userId,
            updatedBy: userId,
          })
          .pipe(Effect.mapError(toPersistenceError));

        const row = yield* selectByIdOrPersistenceError(orgId, id);

        return new CloudflareLogpushCreateResponse({
          connector: rowToConnector(row),
          setup: yield* buildSetup(row),
        });
      });

      const update = Effect.fn("CloudflareLogpushService.update")(function* (
        orgId: string,
        connectorId: string,
        userId: string,
        request: UpdateCloudflareLogpushConnectorRequest,
      ) {
        const existing = yield* requireConnector(orgId, connectorId);
        const updates: Record<string, unknown> = {
          updatedAt: Date.now(),
          updatedBy: userId,
        };

        const zoneName =
          request.zoneName !== undefined
            ? yield* cleanRequiredString("Zone name", request.zoneName)
            : existing.zoneName;

        if (request.name !== undefined) {
          updates.name = yield* cleanRequiredString("Name", request.name);
        }
        if (request.zoneName !== undefined) {
          updates.zoneName = zoneName;
        }
        if (request.serviceName !== undefined) {
          updates.serviceName = yield* cleanOptionalServiceName(
            request.serviceName,
            zoneName,
          );
        }
        if (request.enabled !== undefined) {
          updates.enabled = request.enabled ? 1 : 0;
        }

        yield* db
          .update(cloudflareLogpushConnectors)
          .set(updates)
          .where(
            and(
              eq(cloudflareLogpushConnectors.orgId, orgId),
              eq(cloudflareLogpushConnectors.id, connectorId),
            ),
          )
          .pipe(Effect.mapError(toPersistenceError));

        return rowToConnector(yield* requireConnector(orgId, connectorId));
      });

      const remove = Effect.fn("CloudflareLogpushService.delete")(function* (
        orgId: string,
        connectorId: string,
      ) {
        const rows = yield* db
          .delete(cloudflareLogpushConnectors)
          .where(
            and(
              eq(cloudflareLogpushConnectors.orgId, orgId),
              eq(cloudflareLogpushConnectors.id, connectorId),
            ),
          )
          .returning({ id: cloudflareLogpushConnectors.id })
          .pipe(Effect.mapError(toPersistenceError));

        const deleted = rows[0];
        if (deleted) {
          return { id: deleted.id };
        }

        return yield* Effect.fail(
          new CloudflareLogpushNotFoundError({
            connectorId,
            message: "Cloudflare Logpush connector not found",
          }),
        );
      });

      const getSetup = Effect.fn("CloudflareLogpushService.getSetup")(
        function* (orgId: string, connectorId: string) {
          return yield* buildSetup(yield* requireConnector(orgId, connectorId));
        },
      );

      const rotateSecret = Effect.fn("CloudflareLogpushService.rotateSecret")(
        function* (orgId: string, connectorId: string, userId: string) {
          yield* requireConnector(orgId, connectorId);

          const now = Date.now();
          const secret = generateSecret();
          const secretHash = hashCloudflareLogpushSecret(secret, lookupHmacKey);
          const encryptedSecret = yield* encryptSecret(secret, encryptionKey);

          yield* db
            .update(cloudflareLogpushConnectors)
            .set({
              secretCiphertext: encryptedSecret.ciphertext,
              secretIv: encryptedSecret.iv,
              secretTag: encryptedSecret.tag,
              secretHash,
              secretRotatedAt: now,
              updatedAt: now,
              updatedBy: userId,
            })
            .where(
              and(
                eq(cloudflareLogpushConnectors.orgId, orgId),
                eq(cloudflareLogpushConnectors.id, connectorId),
              ),
            )
            .pipe(Effect.mapError(toPersistenceError));

          return yield* buildSetup(yield* requireConnector(orgId, connectorId));
        },
      );

      return {
        list,
        create,
        update,
        delete: remove,
        getSetup,
        rotateSecret,
      };
    }),
  },
) {
  static readonly Live = this.Default.pipe(Layer.provide(DatabaseLive));
}

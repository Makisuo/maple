import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface GenerateSecretStringProps
  extends secretsmanager.GetRandomPasswordRequest {
  /**
   * JSON template merged with the generated password.
   * @default "{}"
   */
  secretStringTemplate?: string;
  /**
   * Key written into the generated secret payload.
   * @default "password"
   */
  generateStringKey?: string;
}

export interface SecretProps {
  /**
   * Secret name. If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Optional description for the secret.
   */
  description?: string;
  /**
   * Optional KMS key used to encrypt the secret.
   */
  kmsKeyId?: string;
  /**
   * Plain string secret value.
   */
  secretString?: Redacted.Redacted<string>;
  /**
   * Binary secret value.
   */
  secretBinary?: Redacted.Redacted<Uint8Array<ArrayBufferLike>>;
  /**
   * Generate a password and store it inside a JSON secret string.
   */
  generateSecretString?: GenerateSecretStringProps;
  /**
   * User-defined tags for the secret.
   */
  tags?: Record<string, string>;
}

export interface Secret extends Resource<
  "AWS.SecretsManager.Secret",
  SecretProps,
  {
    secretArn: string;
    secretName: string;
    versionId: string | undefined;
    description: string | undefined;
    kmsKeyId: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An AWS Secrets Manager secret.
 *
 * `Secret` owns the lifecycle of the secret metadata and current value. It can
 * store a caller-provided value or generate a password-backed JSON payload for
 * downstream resources such as Aurora clusters and RDS proxies.
 *
 * @section Creating Secrets
 * @example Static Secret String
 * ```typescript
 * const secret = yield* Secret("DbSecret", {
 *   secretString: Redacted.make(JSON.stringify({
 *     username: "app",
 *     password: "super-secret",
 *   })),
 * });
 * ```
 *
 * @example Generated Password Secret
 * ```typescript
 * const secret = yield* Secret("DbSecret", {
 *   generateSecretString: {
 *     secretStringTemplate: JSON.stringify({ username: "app" }),
 *     generateStringKey: "password",
 *     PasswordLength: 32,
 *   },
 * });
 * ```
 */
export const Secret = Resource<Secret>("AWS.SecretsManager.Secret");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const toSecretName = (id: string, props: SecretProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 512 });

      const createValue = Effect.fn(function* (props: SecretProps) {
        if (props.secretBinary !== undefined) {
          return { SecretBinary: props.secretBinary } as const;
        }

        if (props.secretString !== undefined) {
          return { SecretString: props.secretString } as const;
        }

        if (props.generateSecretString) {
          const {
            secretStringTemplate = "{}",
            generateStringKey = "password",
            ...request
          } = props.generateSecretString;
          const password = yield* secretsmanager.getRandomPassword(request);
          const generated = password.RandomPassword
            ? typeof password.RandomPassword === "string"
              ? password.RandomPassword
              : Redacted.value(password.RandomPassword)
            : "";
          const template = JSON.parse(secretStringTemplate) as Record<
            string,
            unknown
          >;
          return {
            SecretString: JSON.stringify({
              ...template,
              [generateStringKey]: generated,
            }),
          } as const;
        }

        return {} as const;
      });

      const readSecret = Effect.fn(function* (secretId: string) {
        return yield* secretsmanager
          .describeSecret({
            SecretId: secretId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["secretArn", "secretName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toSecretName(id, olds ?? {})) !==
            (yield* toSecretName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const secretName =
            output?.secretName ?? (yield* toSecretName(id, olds ?? {}));
          const described = yield* readSecret(output?.secretArn ?? secretName);
          if (!described?.ARN || !described.Name) {
            return undefined;
          }

          return {
            secretArn: described.ARN,
            secretName: described.Name,
            versionId: output?.versionId,
            description: described.Description,
            kmsKeyId: described.KmsKeyId,
            tags: toTagRecord(described.Tags),
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const secretName = yield* toSecretName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const created = yield* secretsmanager
            .createSecret({
              Name: secretName,
              Description: news.description,
              KmsKeyId: news.kmsKeyId,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
              ...(yield* createValue(news)),
            })
            .pipe(
              Effect.catchTag("ResourceExistsException", () =>
                Effect.gen(function* () {
                  const existing = yield* secretsmanager.describeSecret({
                    SecretId: secretName,
                  });
                  if (!existing.ARN || !existing.Name) {
                    return yield* Effect.fail(
                      new Error(
                        `Secret '${secretName}' already exists but could not be described`,
                      ),
                    );
                  }

                  if (
                    news.secretString !== undefined ||
                    news.secretBinary !== undefined ||
                    news.generateSecretString !== undefined
                  ) {
                    const updated = yield* secretsmanager.updateSecret({
                      SecretId: secretName,
                      Description: news.description,
                      KmsKeyId: news.kmsKeyId,
                      ...(yield* createValue(news)),
                    });
                    return {
                      ARN: existing.ARN,
                      Name: existing.Name,
                      VersionId: updated.VersionId,
                    };
                  }

                  return {
                    ARN: existing.ARN,
                    Name: existing.Name,
                    VersionId: undefined,
                  };
                }),
              ),
            );

          yield* session.note(created.ARN ?? secretName);
          return {
            secretArn: created.ARN ?? secretName,
            secretName: created.Name ?? secretName,
            versionId: created.VersionId,
            description: news.description,
            kmsKeyId: news.kmsKeyId,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const updateRequest: secretsmanager.UpdateSecretRequest = {
            SecretId: output.secretArn,
            Description: news.description,
            KmsKeyId: news.kmsKeyId,
            ...(yield* createValue(news)),
          };

          const updated = yield* secretsmanager.updateSecret(updateRequest);

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...olds.tags,
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (upsert.length > 0) {
            yield* secretsmanager.tagResource({
              SecretId: output.secretArn,
              Tags: upsert,
            });
          }

          if (removed.length > 0) {
            yield* secretsmanager.untagResource({
              SecretId: output.secretArn,
              TagKeys: removed,
            });
          }

          yield* session.note(output.secretArn);
          return {
            ...output,
            versionId: updated.VersionId ?? output.versionId,
            description: news.description,
            kmsKeyId: news.kmsKeyId,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* secretsmanager
            .deleteSecret({
              SecretId: output.secretArn,
              ForceDeleteWithoutRecovery: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

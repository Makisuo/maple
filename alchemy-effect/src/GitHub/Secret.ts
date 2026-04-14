import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";

export interface SecretProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Secret name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Secret value. Wrap with `Redacted.make` to prevent the value from
   * appearing in logs or state.
   */
  value: Redacted.Redacted;

  /**
   * Optional environment name. When set the secret is scoped to that
   * GitHub Actions environment instead of the whole repository.
   */
  environment?: string;

  /**
   * GitHub API token. If not provided, falls back to
   * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` environment variables.
   */
  token?: string;
}

export interface Secret extends Resource<
  "GitHub.Secret",
  SecretProps,
  {
    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  }
> {}

/**
 * A GitHub Actions repository or environment secret.
 *
 * Secrets are encrypted using the repository's (or environment's) public
 * key before being stored. The resource is idempotent — calling it with
 * the same name will update the secret value in place.
 *
 * @section Repository Secrets
 * @example Create a Repository Secret
 * ```typescript
 * yield* GitHub.Secret("aws-role", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_ROLE_ARN",
 *   value: Redacted.make(role.roleArn),
 * });
 * ```
 *
 * @section Environment Secrets
 * @example Create an Environment Secret
 * ```typescript
 * yield* GitHub.Secret("deploy-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "DEPLOY_KEY",
 *   value: Redacted.make("my-secret-value"),
 * });
 * ```
 */
export const Secret = Resource<Secret>("GitHub.Secret");

function resolveToken(props: SecretProps): string | undefined {
  return (
    props.token ?? process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN
  );
}

function createClient(props: SecretProps): Octokit {
  return new Octokit({ auth: resolveToken(props) });
}

async function encryptValue(
  plaintext: string,
  publicKey: string,
): Promise<string> {
  const sodium = await import("libsodium-wrappers");
  await sodium.ready;
  const binKey = sodium.from_base64(
    publicKey,
    sodium.base64_variants.ORIGINAL,
  );
  const binMessage = sodium.from_string(plaintext);
  const encrypted = sodium.crypto_box_seal(binMessage, binKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    create: Effect.fn(function* ({ news }) {
      const octokit = createClient(news);
      yield* upsertSecret(octokit, news);
      return { updatedAt: new Date().toISOString() };
    }),

    update: Effect.fn(function* ({ news, olds, output }) {
      const octokit = createClient(news);

      const wasEnv = !!olds.environment;
      const isEnv = !!news.environment;
      if (wasEnv !== isEnv || olds.environment !== news.environment) {
        yield* deleteSecret(octokit, olds);
      }

      yield* upsertSecret(octokit, news);
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = createClient(olds);
      yield* deleteSecret(octokit, olds);
    }),
  });

const upsertSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  const plaintext = Redacted.value(props.value);
  const isEnv = !!props.environment;

  const publicKey = yield* Effect.tryPromise(async () => {
    if (isEnv) {
      const { data } = await octokit.rest.actions.getEnvironmentPublicKey({
        owner: props.owner,
        repo: props.repository,
        environment_name: props.environment!,
      });
      return data;
    }
    const { data } = await octokit.rest.actions.getRepoPublicKey({
      owner: props.owner,
      repo: props.repository,
    });
    return data;
  });

  const encrypted = yield* Effect.tryPromise(() =>
    encryptValue(plaintext, publicKey.key),
  );

  yield* Effect.tryPromise(async () => {
    if (isEnv) {
      await octokit.rest.actions.createOrUpdateEnvironmentSecret({
        owner: props.owner,
        repo: props.repository,
        environment_name: props.environment!,
        secret_name: props.name,
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });
    } else {
      await octokit.rest.actions.createOrUpdateRepoSecret({
        owner: props.owner,
        repo: props.repository,
        secret_name: props.name,
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });
    }
  });
});

const deleteSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  yield* Effect.tryPromise(async () => {
    try {
      if (props.environment) {
        await octokit.rest.actions.deleteEnvironmentSecret({
          owner: props.owner,
          repo: props.repository,
          environment_name: props.environment,
          secret_name: props.name,
        });
      } else {
        await octokit.rest.actions.deleteRepoSecret({
          owner: props.owner,
          repo: props.repository,
          secret_name: props.name,
        });
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }
  });
});

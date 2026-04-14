import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";

export interface VariableProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Variable name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Variable value.
   */
  value: string;

  /**
   * GitHub API token. If not provided, falls back to
   * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` environment variables.
   */
  token?: string;
}

export interface Variable extends Resource<
  "GitHub.Variable",
  VariableProps,
  {
    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  }
> {}

/**
 * A GitHub Actions repository variable.
 *
 * Variables are stored in plain text and are suitable for non-sensitive
 * configuration like region names or role ARNs.
 *
 * @section Repository Variables
 * @example Create a Repository Variable
 * ```typescript
 * yield* GitHub.Variable("aws-region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 */
export const Variable = Resource<Variable>("GitHub.Variable");

function resolveToken(props: VariableProps): string | undefined {
  return (
    props.token ?? process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN
  );
}

function createClient(props: VariableProps): Octokit {
  return new Octokit({ auth: resolveToken(props) });
}

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    create: Effect.fn(function* ({ news }) {
      const octokit = createClient(news);

      yield* Effect.tryPromise(() =>
        octokit.rest.actions.createRepoVariable({
          owner: news.owner,
          repo: news.repository,
          name: news.name,
          value: news.value,
        }),
      );

      return { updatedAt: new Date().toISOString() };
    }),

    update: Effect.fn(function* ({ news }) {
      const octokit = createClient(news);

      yield* Effect.tryPromise(() =>
        octokit.rest.actions.updateRepoVariable({
          owner: news.owner,
          repo: news.repository,
          name: news.name,
          value: news.value,
        }),
      );

      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = createClient(olds);

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.actions.deleteRepoVariable({
            owner: olds.owner,
            repo: olds.repository,
            name: olds.name,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });

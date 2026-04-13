import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type RepositoryName = string;
export type RepositoryArn =
  `arn:aws:ecr:${RegionID}:${AccountID}:repository/${RepositoryName}`;
export type RepositoryUri =
  `${AccountID}.dkr.ecr.${RegionID}.amazonaws.com/${RepositoryName}`;

export interface RepositoryProps {
  /**
   * Name of the repository. If omitted, a unique name is generated.
   */
  repositoryName?: string;
  /**
   * Image tag mutability setting.
   * @default "MUTABLE"
   */
  imageTagMutability?: ecr.ImageTagMutability;
  /**
   * Whether enhanced image scanning should run on push.
   */
  scanOnPush?: boolean;
  /**
   * Optional lifecycle policy document JSON.
   */
  lifecyclePolicyText?: string;
  /**
   * User-defined tags to apply to the repository.
   */
  tags?: Record<string, string>;
}

export interface Repository extends Resource<
  "AWS.ECR.Repository",
  RepositoryProps,
  {
    repositoryName: RepositoryName;
    repositoryArn: RepositoryArn;
    repositoryUri: RepositoryUri;
    registryId: string;
    imageTagMutability: ecr.ImageTagMutability;
    lifecyclePolicyText?: string;
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon ECR repository for container images.
 *
 * @section Creating Repositories
 * @example Task Image Repository
 * ```typescript
 * const repo = yield* Repository("TaskRepository", {
 *   scanOnPush: true,
 * });
 * ```
 */
export const Repository = Resource<Repository>("AWS.ECR.Repository");

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const toRepositoryName = (
        id: string,
        props: { repositoryName?: string } = {},
      ) =>
        props.repositoryName
          ? Effect.succeed(props.repositoryName)
          : createPhysicalName({
              id,
              maxLength: 256,
              lowercase: true,
            });

      return {
        stables: [
          "repositoryArn",
          "repositoryName",
          "repositoryUri",
          "registryId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRepositoryName(id, olds ?? {})) !==
            (yield* toRepositoryName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const repositoryName =
            output?.repositoryName ?? (yield* toRepositoryName(id, olds ?? {}));
          const described = yield* ecr
            .describeRepositories({
              repositoryNames: [repositoryName],
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const repository = described?.repositories?.[0];
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            return undefined;
          }
          return {
            repositoryName,
            repositoryArn: repository.repositoryArn as RepositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability:
              repository.imageTagMutability ??
              output?.imageTagMutability ??
              "MUTABLE",
            lifecyclePolicyText: output?.lifecyclePolicyText,
            tags: output?.tags ?? {},
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const repositoryName = yield* toRepositoryName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const created = yield* ecr
            .createRepository({
              repositoryName,
              imageTagMutability: news.imageTagMutability,
              imageScanningConfiguration: news.scanOnPush
                ? { scanOnPush: true }
                : undefined,
              tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag("RepositoryAlreadyExistsException", () =>
                Effect.gen(function* () {
                  const existing = yield* ecr.describeRepositories({
                    repositoryNames: [repositoryName],
                  });
                  const repo = existing.repositories?.[0];
                  if (!repo?.repositoryArn) {
                    return yield* Effect.fail(
                      new Error(
                        `Repository '${repositoryName}' already exists`,
                      ),
                    );
                  }
                  const listedTags = yield* ecr.listTagsForResource({
                    resourceArn: repo.repositoryArn,
                  });
                  if (!(yield* hasAlchemyTags(id, listedTags.tags ?? []))) {
                    return yield* Effect.fail(
                      new Error(
                        `Repository '${repositoryName}' already exists and is not managed by alchemy`,
                      ),
                    );
                  }
                  return {
                    repository: repo,
                  };
                }),
              ),
            );

          if (news.lifecyclePolicyText) {
            yield* ecr.putLifecyclePolicy({
              repositoryName,
              lifecyclePolicyText: news.lifecyclePolicyText,
            });
          }

          const repository = created.repository!;
          yield* session.note(repository.repositoryArn!);

          return {
            repositoryName,
            repositoryArn: repository.repositoryArn as RepositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability: news.imageTagMutability ?? "MUTABLE",
            lifecyclePolicyText: news.lifecyclePolicyText,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          if (
            news.lifecyclePolicyText !== undefined &&
            news.lifecyclePolicyText !== olds.lifecyclePolicyText
          ) {
            yield* ecr.putLifecyclePolicy({
              repositoryName: output.repositoryName,
              lifecyclePolicyText: news.lifecyclePolicyText,
            });
          }

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
            yield* ecr.tagResource({
              resourceArn: output.repositoryArn,
              tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* ecr.untagResource({
              resourceArn: output.repositoryArn,
              tagKeys: removed,
            });
          }

          yield* session.note(output.repositoryArn);
          return {
            ...output,
            imageTagMutability:
              news.imageTagMutability ?? output.imageTagMutability,
            lifecyclePolicyText: news.lifecyclePolicyText,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

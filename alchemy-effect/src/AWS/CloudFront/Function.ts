import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface FunctionProps {
  /**
   * CloudFront Function name. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * CloudFront Function runtime.
   * @default "cloudfront-js-2.0"
   */
  runtime?: cloudfront.FunctionRuntime;
  /**
   * Optional function comment.
   */
  comment?: string;
  /**
   * JavaScript source code for the function.
   */
  code: string;
  /**
   * Optional associated KeyValueStore ARNs.
   */
  keyValueStoreArns?: string[];
}

export interface Function extends Resource<
  "AWS.CloudFront.Function",
  FunctionProps,
  {
    /**
     * CloudFront function ARN.
     */
    functionArn: string;
    /**
     * Function name.
     */
    functionName: string;
    /**
     * Runtime currently configured for the function.
     */
    runtime: cloudfront.FunctionRuntime;
    /**
     * Current comment.
     */
    comment: string;
    /**
     * Deployment stage for the function.
     */
    stage: cloudfront.FunctionStage;
    /**
     * Current status.
     */
    status: string;
    /**
     * Last modified time.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Latest entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Associated KeyValueStore ARNs.
     */
    keyValueStoreArns: string[];
  }
> {}

/**
 * A CloudFront Function for viewer request and response customization.
 *
 * CloudFront Functions are lightweight JavaScript handlers that run at the
 * edge and can be attached to distribution cache behaviors.
 *
 * @section Creating Functions
 * @example Viewer Request Function
 * ```typescript
 * const fn = yield* Function("RouterRequestFunction", {
 *   code: `
 * async function handler(event) {
 *   event.request.headers["x-forwarded-host"] = {
 *     value: event.request.headers.host.value,
 *   };
 *   return event.request;
 * }
 * `,
 * });
 * ```
 */
export const Function = Resource<Function>("AWS.CloudFront.Function");

class FunctionKeyValueStorePending extends Data.TaggedError(
  "FunctionKeyValueStorePending",
)<{
  message: string;
}> {}

const isFunctionDeletePending = (error: {
  _tag?: string;
}): error is cloudfront.FunctionInUse | cloudfront.PreconditionFailed =>
  error._tag === "FunctionInUse" || error._tag === "PreconditionFailed";

const isKeyValueStoreAssociationPending = (error: { Message?: string }) => {
  const message = error.Message ?? "";
  return (
    message.includes("KeyValueStoreAssociationArn") &&
    message.includes("cannot be associated before the resource is provisioned")
  );
};

const cappedCloudFrontRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(24)),
  Schedule.map(([duration]) =>
    Duration.isGreaterThan(duration, Duration.seconds(2))
      ? Duration.seconds(2)
      : duration,
  ),
);

const retryForKvAssociationReadiness = (
  operation: string,
  effect: Effect.Effect<any, any, any>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      (error as { _tag?: string })._tag === "InvalidArgument" &&
      isKeyValueStoreAssociationPending(error as { Message?: string })
        ? Effect.logInfo(
            `CloudFront Function ${operation}: key value store association not yet ready, retrying`,
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new FunctionKeyValueStorePending({
                  message:
                    "CloudFront function key value store association not yet ready",
                }),
              ),
            ),
          )
        : Effect.fail(error),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionKeyValueStorePending",
      schedule: cappedCloudFrontRetrySchedule,
    }),
  );

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const describe = Effect.fn(function* (
        name: string,
        stage?: cloudfront.FunctionStage,
      ) {
        return yield* cloudfront
          .describeFunction({
            Name: name,
            Stage: stage,
          })
          .pipe(
            Effect.catchTag("NoSuchFunctionExists", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const getCurrent = Effect.fn(function* (name: string) {
        const live = yield* describe(name, "LIVE");
        if (live?.FunctionSummary) {
          return live;
        }
        return yield* describe(name, "DEVELOPMENT");
      });

      const getDevelopmentEtag = Effect.fn(function* (name: string) {
        const current = yield* describe(name, "DEVELOPMENT");
        return current?.ETag;
      });

      const publish = Effect.fn(function* (
        name: string,
        etag: string | undefined,
      ) {
        if (!etag) {
          return yield* Effect.fail(
            new Error(
              `CloudFront Function '${name}' is missing an ETag for publish`,
            ),
          );
        }
        yield* cloudfront.publishFunction({
          Name: name,
          IfMatch: etag,
        });
        return yield* describe(name, "LIVE");
      });

      return {
        stables: ["functionArn", "functionName"],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          if (
            (yield* createName(id, olds ?? {})) !==
            (yield* createName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.functionName ?? (yield* createName(id, olds ?? {}));
          const current = yield* getCurrent(name);
          if (!current?.FunctionSummary) {
            return undefined;
          }
          return toAttrs(current.FunctionSummary, current.ETag, name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createName(id, news);
          const created = yield* retryForKvAssociationReadiness(
            "create",
            cloudfront
              .createFunction({
                Name: name,
                FunctionConfig: {
                  Comment: news.comment ?? "",
                  Runtime: news.runtime ?? "cloudfront-js-2.0",
                  KeyValueStoreAssociations: toKvAssociations(
                    news.keyValueStoreArns,
                  ),
                },
                FunctionCode: new TextEncoder().encode(news.code),
              })
              .pipe(
                Effect.catchTag("FunctionAlreadyExists", () =>
                  describe(name, "DEVELOPMENT").pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed(existing)
                        : Effect.die(
                            `CloudFront Function '${name}' already exists but could not be recovered`,
                          ),
                    ),
                  ),
                ),
              ),
          );

          const live = yield* publish(name, created.ETag);
          if (!live?.FunctionSummary) {
            return yield* Effect.die(
              "publishFunction returned no function summary",
            );
          }

          yield* session.note(name);
          return toAttrs(live.FunctionSummary, live.ETag, name);
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* retryForKvAssociationReadiness(
            "update",
            cloudfront.updateFunction({
              Name: output.functionName,
              IfMatch: output.etag!,
              FunctionConfig: {
                Comment: news.comment ?? "",
                Runtime: news.runtime ?? output.runtime,
                KeyValueStoreAssociations: toKvAssociations(
                  news.keyValueStoreArns,
                ),
              },
              FunctionCode: new TextEncoder().encode(news.code),
            }),
          );

          const developmentEtag = yield* getDevelopmentEtag(
            output.functionName,
          );
          const live = yield* publish(output.functionName, developmentEtag);
          if (!live?.FunctionSummary) {
            return yield* Effect.die(
              "publishFunction returned no function summary",
            );
          }

          yield* session.note(output.functionName);
          return toAttrs(live.FunctionSummary, live.ETag, output.functionName);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Effect.gen(function* () {
            const developmentEtag = yield* getDevelopmentEtag(
              output.functionName,
            );
            if (!developmentEtag) {
              yield* Effect.logInfo(
                `CloudFront Function delete: ${output.functionName} already absent`,
              );
              return;
            }

            yield* Effect.logInfo(
              `CloudFront Function delete: deleting ${output.functionName} stage=DEVELOPMENT etag=${developmentEtag}`,
            );
            yield* cloudfront.deleteFunction({
              Name: output.functionName,
              IfMatch: developmentEtag,
            });
          }).pipe(
            Effect.catchTag("NoSuchFunctionExists", () => Effect.void),
            Effect.tapError((error) =>
              isFunctionDeletePending(error)
                ? Effect.logInfo(
                    `CloudFront Function delete: ${output.functionName} not ready yet (${error._tag}), retrying with capped exponential backoff`,
                  )
                : Effect.logError(
                    `CloudFront Function delete: ${output.functionName} failed with ${String(error)}`,
                  ),
            ),
            Effect.retry({
              while: isFunctionDeletePending,
              schedule: cappedCloudFrontRetrySchedule,
            }),
          );
        }),
      };
    }),
  );

const createName = (id: string, props: FunctionProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 64,
        lowercase: true,
      });

const toKvAssociations = (
  arns: string[] | undefined,
): cloudfront.KeyValueStoreAssociations | undefined =>
  arns && arns.length > 0
    ? {
        Quantity: arns.length,
        Items: arns.map((KeyValueStoreARN) => ({ KeyValueStoreARN })),
      }
    : undefined;

const toAttrs = (
  summary: cloudfront.FunctionSummary,
  etag: string | undefined,
  fallbackName: string,
): Function["Attributes"] => ({
  functionArn: summary.FunctionMetadata.FunctionARN,
  functionName: summary.Name || fallbackName,
  runtime: summary.FunctionConfig.Runtime,
  comment: summary.FunctionConfig.Comment,
  stage: summary.FunctionMetadata.Stage ?? "DEVELOPMENT",
  status: summary.Status ?? "UNKNOWN",
  lastModifiedTime: summary.FunctionMetadata.LastModifiedTime,
  etag,
  keyValueStoreArns:
    summary.FunctionConfig.KeyValueStoreAssociations?.Items?.flatMap((item) =>
      item.KeyValueStoreARN ? [item.KeyValueStoreARN] : [],
    ) ?? [],
});

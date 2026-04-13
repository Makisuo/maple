import { Region } from "@distilled.cloud/aws/Region";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { diffTags } from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { RegionID } from "../Region.ts";

export type BucketName = string;
export type BucketArn = `arn:aws:s3:::${BucketName}`;

export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;
  /**
   * Indicates whether this bucket has Object Lock enabled.
   * Once enabled, cannot be disabled.
   */
  objectLockEnabled?: boolean;
  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags to apply to the bucket.
   */
  tags?: Record<string, string>;
}

export interface Bucket extends Resource<
  "AWS.S3.Bucket",
  BucketProps,
  {
    /**
     * Name of the bucket.
     */
    bucketName: BucketName;
    /**
     * ARN of the bucket.
     */
    bucketArn: BucketArn;
    /**
     * Domain name of the bucket (e.g., bucket-name.s3.amazonaws.com).
     */
    bucketDomainName: `${BucketName}.s3.amazonaws.com`;
    /**
     * Regional domain name of the bucket.
     */
    bucketRegionalDomainName: `${BucketName}.s3.${RegionID}.amazonaws.com`;
    /**
     * AWS region where the bucket is located.
     */
    region: RegionID;
    /**
     * AWS account ID that owns the bucket.
     */
    accountId: AccountID;
  },
  {
    /**
     * Notification configuration for the bucket.
     */
    notificationConfiguration?: s3.NotificationConfiguration;
    /**
     * Policy statements for the bucket.
     */
    policyStatements?: PolicyStatement[];
  }
> {}

/**
 * An S3 bucket for storing objects in AWS.
 *
 * A bucket name is auto-generated from the app, stage, and logical ID unless
 * you provide one explicitly via `bucketName`. Enable `forceDestroy` to allow
 * Alchemy to empty the bucket before deleting it.
 *
 * @section Creating a Bucket
 * @example Basic Bucket
 * ```typescript
 * import * as S3 from "alchemy-effect/AWS/S3";
 *
 * const bucket = yield* S3.Bucket("my-bucket", {});
 * ```
 *
 * @example Bucket with a custom name
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   bucketName: "my-company-assets",
 * });
 * ```
 *
 * @example Bucket with force destroy
 * ```typescript
 * const bucket = yield* S3.Bucket("my-bucket", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * @section Reading Objects
 * @example Get an object from a bucket
 * ```typescript
 * const getObject = yield* S3.GetObject.bind(bucket);
 *
 * const response = yield* getObject({ Key: "hello.txt" });
 * ```
 *
 * @section Writing Objects
 * @example Put an object into a bucket
 * ```typescript
 * const putObject = yield* S3.PutObject.bind(bucket);
 *
 * yield* putObject({
 *   Key: "hello.txt",
 *   Body: "Hello, World!",
 *   ContentType: "text/plain",
 * });
 * ```
 *
 * @section Deleting Objects
 * @example Delete an object from a bucket
 * ```typescript
 * const deleteObject = yield* S3.DeleteObject.bind(bucket);
 *
 * yield* deleteObject({ Key: "hello.txt" });
 * ```
 *
 * @section Event Notifications
 * @example Process object creation events
 * ```typescript
 * yield* S3.notifications(bucket, {
 *   events: ["s3:ObjectCreated:*"],
 * }).subscribe((stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`New object: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 */
export const Bucket = Resource<Bucket>("AWS.S3.Bucket");

export const BucketProvider = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      const createBucketName = (
        id: string,
        props: { bucketName?: string | undefined },
      ) =>
        Effect.gen(function* () {
          if (props.bucketName) {
            return props.bucketName;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 63,
            lowercase: true,
          });
        });

      const deleteAllObjects = Effect.fn(function* (bucketName: string) {
        yield* Effect.logInfo(
          `S3 Bucket delete: deleting all objects from ${bucketName}`,
        );
        // List and delete all objects (including versions and delete markers)
        let continuationToken: string | undefined;
        do {
          const listResponse = yield* s3.listObjectsV2({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          });

          if (listResponse.Contents && listResponse.Contents.length > 0) {
            yield* Effect.logInfo(
              `S3 Bucket delete: deleting ${listResponse.Contents.length} object(s) from ${bucketName}`,
            );
            yield* s3.deleteObjects({
              Bucket: bucketName,
              Delete: {
                Objects: listResponse.Contents.map((obj) => ({
                  Key: obj.Key!,
                })),
                Quiet: true,
              },
            });
          }

          continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        // Also delete all object versions and delete markers
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        do {
          const listVersionsResponse = yield* s3.listObjectVersions({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          });

          const objectsToDelete = [
            ...(listVersionsResponse.Versions ?? []).map((v) => ({
              Key: v.Key!,
              VersionId: v.VersionId,
            })),
            ...(listVersionsResponse.DeleteMarkers ?? []).map((dm) => ({
              Key: dm.Key!,
              VersionId: dm.VersionId,
            })),
          ];

          if (objectsToDelete.length > 0) {
            yield* Effect.logInfo(
              `S3 Bucket delete: deleting ${objectsToDelete.length} versioned object(s) from ${bucketName}`,
            );
            yield* s3.deleteObjects({
              Bucket: bucketName,
              Delete: {
                Objects: objectsToDelete,
                Quiet: true,
              },
            });
          }

          keyMarker = listVersionsResponse.NextKeyMarker;
          versionIdMarker = listVersionsResponse.NextVersionIdMarker;
        } while (keyMarker);
      });

      const ensureBucketExists = Effect.fnUntraced(function* ({
        id,
        news = {},
      }: {
        id: string;
        news: BucketProps;
      }) {
        const region = yield* Region;
        const accountId = yield* Account;
        const bucketName = yield* createBucketName(id, news);

        yield* Effect.logInfo(
          `S3 Bucket create: bucket=${bucketName} region=${region} `,
        );

        // For us-east-1, BucketAlreadyOwnedByYou is not thrown, so we need to
        // pre-emptively check if the bucket exists for idempotency
        if (region === "us-east-1") {
          const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
            Effect.catch(() => Effect.succeed(false)),
          );

          yield* Effect.logInfo(
            `S3 Bucket create: us-east-1 existence check for ${bucketName} -> ${exists}`,
          );

          if (!exists) {
            yield* Effect.logInfo(
              `S3 Bucket create: creating bucket ${bucketName} in us-east-1`,
            );
            yield* s3
              .createBucket({
                Bucket: bucketName,
                ObjectLockEnabledForBucket: news.objectLockEnabled ?? false,
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "OperationAborted" ||
                    e._tag === "ServiceUnavailable",
                  schedule: Schedule.exponential(100),
                }),
              );
          }
        } else {
          // For non-us-east-1 regions, we can rely on BucketAlreadyOwnedByYou
          yield* Effect.logInfo(
            `S3 Bucket create: creating bucket ${bucketName} in ${region}`,
          );
          yield* s3
            .createBucket({
              Bucket: bucketName,
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
              ObjectLockEnabledForBucket: news.objectLockEnabled,
            })
            .pipe(
              Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
              Effect.retry({
                while: (e) =>
                  e._tag === "OperationAborted" ||
                  e._tag === "ServiceUnavailable",
                schedule: Schedule.exponential(100),
              }),
            );
        }

        // Wait for bucket to exist (eventual consistency)
        yield* Effect.retry(
          s3.headBucket({ Bucket: bucketName }),
          Schedule.exponential(100).pipe(Schedule.both(Schedule.recurs(10))),
        );
        yield* Effect.logInfo(
          `S3 Bucket create: bucket is available ${bucketName}`,
        );

        return {
          bucketName,
          bucketArn: `arn:aws:s3:::${bucketName}` as const,
          bucketDomainName: `${bucketName}.s3.amazonaws.com` as const,
          bucketRegionalDomainName:
            `${bucketName}.s3.${region}.amazonaws.com` as const,
          region,
          accountId,
        };
      });

      const syncBucketTags = Effect.fnUntraced(function* ({
        bucketName,
        oldTags,
        newTags,
        session,
        operation,
      }: {
        bucketName: string;
        oldTags?: Record<string, string>;
        newTags?: Record<string, string>;
        session: ScopedPlanStatusSession;
        operation: "create" | "update";
      }) {
        const previousTags = oldTags ?? {};
        const desiredTags = newTags ?? {};
        const { removed, upsert } = diffTags(previousTags, desiredTags);
        const canSkip = oldTags !== undefined;

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: bucket=${bucketName} removedTags=${removed.length} upsertTags=${Object.keys(upsert).length}`,
        );

        if (
          canSkip &&
          removed.length === 0 &&
          Object.keys(upsert).length === 0
        ) {
          return;
        }

        if (Object.keys(desiredTags).length > 0) {
          yield* Effect.logInfo(
            `S3 Bucket ${operation}: writing ${Object.keys(desiredTags).length} total tag(s) to ${bucketName}`,
          );
          yield* s3.putBucketTagging({
            Bucket: bucketName,
            Tagging: {
              TagSet: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            },
          });
          yield* session.note(`Updated bucket tags: ${bucketName}`);
          return;
        }

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: removing all tags from ${bucketName}`,
        );
        yield* s3.deleteBucketTagging({
          Bucket: bucketName,
        });
        yield* session.note(`Removed all tags from bucket: ${bucketName}`);
      });

      const syncBucketPolicy = Effect.fnUntraced(function* ({
        bucketName,
        bindings,
        session,
        operation,
      }: {
        bucketName: string;
        session: ScopedPlanStatusSession;
        bindings: ResourceBinding<Bucket["Binding"]>[];
        operation: "create" | "update";
      }) {
        const policyStatements = bindings.flatMap(
          (binding) => binding.data.policyStatements ?? [],
        );
        const desiredPolicy =
          policyStatements.length > 0
            ? JSON.stringify({
                Version: "2012-10-17",
                Statement: policyStatements,
              })
            : undefined;
        const existingPolicy = yield* s3
          .getBucketPolicy({ Bucket: bucketName })
          .pipe(
            Effect.map((r) => r.Policy),
            Effect.catchTag("NoSuchBucketPolicy", () =>
              Effect.succeed<string | undefined>(undefined),
            ),
          );

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: bucket=${bucketName} policyStatements=${policyStatements.length}`,
        );

        if (desiredPolicy) {
          if (existingPolicy === desiredPolicy) {
            return;
          }

          yield* Effect.logInfo(
            `S3 Bucket ${operation}: applying ${policyStatements.length} policy statement(s) to ${bucketName}`,
          );
          yield* s3.putBucketPolicy({
            Bucket: bucketName,
            Policy: desiredPolicy,
          });
          yield* session.note(`Updated bucket policy: ${bucketName}`);
          return;
        }

        if (existingPolicy === undefined) {
          return;
        }

        yield* Effect.logInfo(
          `S3 Bucket ${operation}: deleting bucket policy for ${bucketName}`,
        );
        yield* s3.deleteBucketPolicy({ Bucket: bucketName });
        yield* session.note(`Removed bucket policy: ${bucketName}`);
      });

      return {
        stables: ["bucketName", "bucketArn", "region", "accountId"],
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldBucketName = yield* createBucketName(id, olds);
          const newBucketName = yield* createBucketName(id, news);
          yield* Effect.logInfo(
            `S3 Bucket diff: old=${oldBucketName} new=${newBucketName} oldObjectLock=${olds.objectLockEnabled ?? false} newObjectLock=${news.objectLockEnabled ?? false}`,
          );
          if (oldBucketName !== newBucketName) {
            yield* Effect.logInfo(
              `S3 Bucket diff: replacing bucket because name changed from ${oldBucketName} to ${newBucketName}`,
            );
            return { action: "replace" } as const;
          }
          // Object lock can only be enabled at creation time
          if (
            (olds.objectLockEnabled ?? false) !==
            (news.objectLockEnabled ?? false)
          ) {
            yield* Effect.logInfo(
              `S3 Bucket diff: replacing bucket because object lock changed for ${newBucketName}`,
            );
            return { action: "replace" } as const;
          }
        }),
        precreate: (props) => ensureBucketExists(props),
        create: Effect.fn(function* ({ id, news = {}, session, bindings }) {
          const output = yield* ensureBucketExists({ id, news });

          yield* syncBucketTags({
            bucketName: output.bucketName,
            newTags: news.tags,
            session,
            operation: "create",
          });

          yield* syncBucketPolicy({
            bucketName: output.bucketName,
            bindings,
            session,
            operation: "create",
          });

          yield* session.note(`Ensured bucket: ${output.bucketName}`);

          return output;
        }),
        update: Effect.fn(function* ({
          news = {},
          olds = {},
          output,
          session,
          bindings,
        }) {
          yield* syncBucketTags({
            bucketName: output.bucketName,
            oldTags: olds.tags,
            newTags: news.tags,
            session,
            operation: "update",
          });

          yield* syncBucketPolicy({
            bucketName: output.bucketName,
            bindings,
            session,
            operation: "update",
          });

          return output;
        }),
        delete: Effect.fn(function* ({ olds = {}, output, session }) {
          yield* Effect.logInfo(
            `S3 Bucket delete: bucket=${output.bucketName} forceDestroy=${olds.forceDestroy ?? false}`,
          );
          // If forceDestroy is enabled, delete all objects first
          if (olds.forceDestroy) {
            yield* session.note(
              `Force destroying bucket: ${output.bucketName} - deleting all objects...`,
            );
            yield* deleteAllObjects(output.bucketName);
          }

          yield* s3
            .deleteBucket({
              Bucket: output.bucketName,
            })
            .pipe(
              Effect.catchTag("NoSuchBucket", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "BucketNotEmpty",
                schedule: Schedule.exponential(100).pipe(
                  Schedule.both(Schedule.recurs(5)),
                ),
              }),
            );

          yield* session.note(`Deleted bucket: ${output.bucketName}`);
        }),
      };
    }),
  );

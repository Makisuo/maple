import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import type { Providers } from "../Providers.ts";
import { R2BucketBinding } from "./R2BucketBinding.ts";

export type R2BucketName = string;

export type R2BucketProps = {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Storage class for newly uploaded objects.
   * @default "Standard"
   */
  storageClass?: R2Bucket.StorageClass;
  /**
   * Jurisdiction where objects in this bucket are guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: R2Bucket.Jurisdiction;
  /**
   * Location hint for the bucket.
   */
  locationHint?: R2Bucket.Location;
};

export type R2Bucket = Resource<
  "Cloudflare.R2Bucket",
  R2BucketProps,
  {
    bucketName: R2BucketName;
    storageClass: R2Bucket.StorageClass;
    jurisdiction: R2Bucket.Jurisdiction;
    location: R2Bucket.Location | undefined;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare R2 object storage bucket with S3-compatible API.
 *
 * R2 provides zero-egress-fee object storage. Create a bucket as a resource,
 * then bind it to a Worker to read and write objects at runtime.
 *
 * @section Creating a Bucket
 * @example Basic R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket");
 * ```
 *
 * @example Bucket with location hint
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   locationHint: "wnam",
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Reading and writing objects
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * // Write an object
 * yield* bucket.put("hello.txt", "Hello, World!");
 *
 * // Read an object
 * const object = yield* bucket.get("hello.txt");
 * if (object) {
 *   const text = yield* object.text();
 * }
 * ```
 *
 * @example Streaming upload with content length
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * yield* bucket.put("upload.bin", request.stream, {
 *   contentLength: Number(request.headers["content-length"] ?? 0),
 * });
 * ```
 */
export const R2Bucket = Resource<R2Bucket>("Cloudflare.R2Bucket")({
  bind: R2BucketBinding.bind,
});

export declare namespace R2Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
}

export const R2BucketProvider = () =>
  Provider.effect(
    R2Bucket,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createBucket = yield* r2.createBucket;
      const patchBucket = yield* r2.patchBucket;
      const deleteBucket = yield* r2.deleteBucket;
      const getBucket = yield* r2.getBucket;

      const createBucketName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      const normalizeLocation = (
        location: string | undefined | null,
      ): R2Bucket.Location | undefined => {
        if (!location) return undefined;
        return location.toLowerCase() as R2Bucket.Location;
      };

      return {
        stables: ["bucketName", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* createBucketName(id, news.name);
          const oldName = output?.bucketName
            ? output.bucketName
            : yield* createBucketName(id, olds.name);
          const oldJurisdiction =
            output?.jurisdiction ?? olds.jurisdiction ?? "default";
          const oldStorageClass =
            output?.storageClass ?? olds.storageClass ?? "Standard";
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldName !== name ||
            oldJurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" } as const;
          }
          if (oldStorageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: oldName === name ? ["bucketName"] : undefined,
            } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const name = yield* createBucketName(id, news.name);
          const bucket = yield* createBucket({
            accountId,
            name,
            storageClass: news.storageClass,
            jurisdiction: news.jurisdiction,
            locationHint: news.locationHint,
          }).pipe(
            Effect.catchTag("BucketAlreadyExists", () =>
              getBucket({
                accountId,
                bucketName: name,
                jurisdiction: news.jurisdiction,
              }),
            ),
          );
          return {
            bucketName: bucket.name!,
            storageClass: bucket.storageClass ?? "Standard",
            jurisdiction: bucket.jurisdiction ?? "default",
            location: normalizeLocation(bucket.location),
            accountId,
          };
        }),
        update: Effect.fn(function* ({ news = {}, output }) {
          const bucket = yield* patchBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            storageClass: news.storageClass ?? output.storageClass,
            jurisdiction: output.jurisdiction,
          });
          return {
            bucketName: bucket.name!,
            storageClass: bucket.storageClass ?? "Standard",
            jurisdiction: bucket.jurisdiction ?? "default",
            location: normalizeLocation(bucket.location),
            accountId: output.accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            jurisdiction: output.jurisdiction,
          }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const acct = output?.accountId ?? accountId;
          return yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction: output?.jurisdiction ?? olds?.jurisdiction,
          }).pipe(
            Effect.map((bucket) => ({
              bucketName: bucket.name!,
              storageClass: bucket.storageClass ?? "Standard",
              jurisdiction: bucket.jurisdiction ?? "default",
              location: normalizeLocation(bucket.location),
              accountId: acct,
            })),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

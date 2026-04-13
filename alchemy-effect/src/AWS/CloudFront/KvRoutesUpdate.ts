import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  extractValue,
  getKvsEtag,
  isKvsPreconditionFailed,
  retryForKvsReadiness,
  withKvsRegionFn,
} from "./common.ts";

export interface KvRoutesUpdateProps {
  /** ARN of the CloudFront KeyValueStore. */
  store: string;
  /** Namespace prefix. The full key is `{namespace}:{key}`. */
  namespace: string;
  /** Key within the namespace (typically "routes"). */
  key: string;
  /** The route entry string to add/manage (format: "type,namespace,hostPattern,pathPrefix"). */
  entry: string;
}

export interface KvRoutesUpdate extends Resource<
  "AWS.CloudFront.KvRoutesUpdate",
  KvRoutesUpdateProps,
  {
    store: string;
    namespace: string;
    key: string;
    entry: string;
  }
> {}

/**
 * Manages a single route entry in a JSON array stored in a CloudFront KeyValueStore.
 *
 * The routes array is stored at key `{namespace}:{key}` and supports automatic
 * chunking when the serialized array exceeds 1000 characters.
 *
 * @section Managing Routes
 * @example Add A Route Entry
 * ```typescript
 * const update = yield* KvRoutesUpdate("MyRoute", {
 *   store: store.keyValueStoreArn,
 *   namespace: "app",
 *   key: "routes",
 *   entry: "site,mysite,*,/",
 * });
 * ```
 */
export const KvRoutesUpdate = Resource<KvRoutesUpdate>(
  "AWS.CloudFront.KvRoutesUpdate",
);

const CHUNK_SIZE = 1000;

export const KvRoutesUpdateProvider = () =>
  Provider.effect(
    KvRoutesUpdate,
    Effect.gen(function* () {
      const getRoutes = Effect.fn(function* (store: string, fullKey: string) {
        const res = yield* kvs
          .getKey({ KvsARN: store, Key: fullKey })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!res) {
          return { routes: [] as string[], chunkNum: 1 };
        }

        const raw = extractValue(res.Value);
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === "object" && "parts" in parsed) {
          const parts: number = parsed.parts;
          const chunks: string[] = [];
          for (let i = 0; i < parts; i++) {
            const chunkRes = yield* kvs.getKey({
              KvsARN: store,
              Key: `${fullKey}:${i}`,
            });
            chunks.push(extractValue(chunkRes.Value));
          }
          return {
            routes: JSON.parse(chunks.join("")) as string[],
            chunkNum: parts,
          };
        }

        return { routes: parsed as string[], chunkNum: 1 };
      });

      const setRoutes = Effect.fn(function* (
        store: string,
        etag: string,
        fullKey: string,
        routes: string[],
        oldChunkNum: number,
      ) {
        const serialized = JSON.stringify(routes);
        const puts: kvs.PutKeyRequestListItem[] = [];
        const deletes: kvs.DeleteKeyRequestListItem[] = [];

        if (serialized.length > CHUNK_SIZE) {
          const chunkCount = Math.ceil(serialized.length / CHUNK_SIZE);
          puts.push({
            Key: fullKey,
            Value: JSON.stringify({ parts: chunkCount }),
          });
          for (let i = 0; i < chunkCount; i++) {
            puts.push({
              Key: `${fullKey}:${i}`,
              Value: serialized.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
            });
          }
          if (oldChunkNum > chunkCount) {
            for (let i = chunkCount; i < oldChunkNum; i++) {
              deletes.push({ Key: `${fullKey}:${i}` });
            }
          }
        } else {
          puts.push({ Key: fullKey, Value: serialized });
          if (oldChunkNum > 1) {
            for (let i = 0; i < oldChunkNum; i++) {
              deletes.push({ Key: `${fullKey}:${i}` });
            }
          }
        }

        yield* kvs.updateKeys({
          KvsARN: store,
          IfMatch: etag,
          Puts: puts.length > 0 ? puts : undefined,
          Deletes: deletes.length > 0 ? deletes : undefined,
        });
      });

      const deleteKey = Effect.fn(function* (
        store: string,
        etag: string,
        fullKey: string,
        oldChunkNum: number,
      ) {
        const deletes: kvs.DeleteKeyRequestListItem[] = [{ Key: fullKey }];
        if (oldChunkNum > 1) {
          for (let i = 0; i < oldChunkNum; i++) {
            deletes.push({ Key: `${fullKey}:${i}` });
          }
        }
        yield* kvs.updateKeys({
          KvsARN: store,
          IfMatch: etag,
          Deletes: deletes,
        });
      });

      const createOp = (
        props: KvRoutesUpdateProps,
      ): Effect.Effect<void, any, any> =>
        Effect.gen(function* () {
          const fullKey = `${props.namespace}:${props.key}`;
          const etag = yield* getKvsEtag(props.store);
          const { routes, chunkNum } = yield* getRoutes(props.store, fullKey);
          if (!routes.includes(props.entry)) {
            routes.push(props.entry);
          }
          yield* setRoutes(props.store, etag, fullKey, routes, chunkNum);
        }).pipe(
          Effect.catchTag("ValidationException", (err) =>
            "Message" in err &&
            typeof err.Message === "string" &&
            isKvsPreconditionFailed(err)
              ? Effect.sleep(
                  `${Math.floor(Math.random() * 400) + 100} millis`,
                ).pipe(Effect.andThen(createOp(props)))
              : Effect.fail(err),
          ),
        );

      const deleteOp = (
        props: KvRoutesUpdateProps,
      ): Effect.Effect<void, any, any> =>
        Effect.gen(function* () {
          const fullKey = `${props.namespace}:${props.key}`;
          const etag = yield* getKvsEtag(props.store);
          const { routes, chunkNum } = yield* getRoutes(props.store, fullKey);
          const filtered = routes.filter((r) => r !== props.entry);
          if (filtered.length === 0) {
            yield* deleteKey(props.store, etag, fullKey, chunkNum);
          } else {
            yield* setRoutes(props.store, etag, fullKey, filtered, chunkNum);
          }
        }).pipe(
          Effect.catchTag("ValidationException", (err) =>
            "Message" in err &&
            typeof err.Message === "string" &&
            isKvsPreconditionFailed(err)
              ? Effect.sleep(
                  `${Math.floor(Math.random() * 400) + 100} millis`,
                ).pipe(Effect.andThen(deleteOp(props)))
              : Effect.fail(err),
          ),
        );

      return {
        read: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            return output;
          }),
        ),
        create: withKvsRegionFn(
          Effect.fn(function* ({ news }) {
            return yield* retryForKvsReadiness(
              Effect.gen(function* () {
                yield* createOp(news);
                return {
                  store: news.store,
                  namespace: news.namespace,
                  key: news.key,
                  entry: news.entry,
                };
              }),
            );
          }),
        ),
        update: withKvsRegionFn(
          Effect.fn(function* ({ news, olds }) {
            return yield* retryForKvsReadiness(
              Effect.gen(function* () {
                if (
                  news.store !== olds.store ||
                  news.namespace !== olds.namespace ||
                  news.key !== olds.key
                ) {
                  yield* deleteOp(olds);
                  yield* createOp(news);
                } else {
                  const fullKey = `${news.namespace}:${news.key}`;
                  const updateInPlace = (): Effect.Effect<void, any, any> =>
                    Effect.gen(function* () {
                      const etag = yield* getKvsEtag(news.store);
                      const { routes, chunkNum } = yield* getRoutes(
                        news.store,
                        fullKey,
                      );
                      const filtered = routes.filter((r) => r !== olds.entry);
                      if (!filtered.includes(news.entry)) {
                        filtered.push(news.entry);
                      }
                      yield* setRoutes(
                        news.store,
                        etag,
                        fullKey,
                        filtered,
                        chunkNum,
                      );
                    }).pipe(
                      Effect.catchTag("ValidationException", (err) =>
                        "Message" in err &&
                        typeof err.Message === "string" &&
                        isKvsPreconditionFailed(err)
                          ? Effect.sleep(
                              `${Math.floor(Math.random() * 400) + 100} millis`,
                            ).pipe(Effect.andThen(updateInPlace()))
                          : Effect.fail(err),
                      ),
                    );
                  yield* updateInPlace();
                }
                return {
                  store: news.store,
                  namespace: news.namespace,
                  key: news.key,
                  entry: news.entry,
                };
              }),
            );
          }),
        ),
        delete: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            yield* retryForKvsReadiness(
              deleteOp({
                store: output.store,
                namespace: output.namespace,
                key: output.key,
                entry: output.entry,
              }),
            ).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }),
        ),
      };
    }),
  );

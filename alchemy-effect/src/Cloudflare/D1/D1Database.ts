import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";

export type Jurisdiction = "default" | "eu" | "fedramp";
export type PrimaryLocationHint =
  | "wnam"
  | "enam"
  | "weur"
  | "eeur"
  | "apac"
  | "oc";

export type DatabaseProps = {
  /**
   * Name of the database. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Optional primary location hint for the database.
   */
  primaryLocationHint?: PrimaryLocationHint;
  /**
   * Read replication configuration. Only mutable property during updates.
   */
  readReplication?: {
    mode: "auto" | "disabled";
  };
  /**
   * Jurisdiction where data is guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: Jurisdiction;
};

export type D1Database = Resource<
  "Cloudflare.D1Database",
  DatabaseProps,
  {
    databaseId: string;
    databaseName: string;
    jurisdiction: Jurisdiction;
    readReplication: { mode: "auto" | "disabled" } | undefined;
    accountId: string;
  }
>;

/**
 * A Cloudflare D1 serverless SQL database built on SQLite.
 *
 * @section Creating a Database
 * @example Basic Database
 * ```typescript
 * const db = yield* Database("my-db", {});
 * ```
 *
 * @example Database with Location Hint
 * ```typescript
 * const db = yield* Database("my-db", {
 *   primaryLocationHint: "wnam",
 * });
 * ```
 */
export const D1Database = Resource<D1Database>("Cloudflare.D1Database");

export const DatabaseProvider = () =>
  Provider.effect(
    D1Database,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createDb = yield* d1.createDatabase;
      const getDb = yield* d1.getDatabase;
      const patchDb = yield* d1.patchDatabase;
      const deleteDb = yield* d1.deleteDatabase;
      const listDbs = yield* d1.listDatabases;

      const createDatabaseName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      return {
        stables: ["databaseId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createDatabaseName(id, news.name);
          const oldName = output?.databaseName
            ? output.databaseName
            : yield* createDatabaseName(id, olds.name);
          const oldJurisdiction =
            output?.jurisdiction ?? olds.jurisdiction ?? "default";
          if (
            oldName !== name ||
            oldJurisdiction !== (news.jurisdiction ?? "default") ||
            (olds.primaryLocationHint !== news.primaryLocationHint &&
              news.primaryLocationHint !== undefined)
          ) {
            return { action: "replace" } as const;
          }
          const oldReplicationMode =
            output?.readReplication?.mode ??
            olds.readReplication?.mode ??
            "disabled";
          const newReplicationMode = news.readReplication?.mode ?? "disabled";
          if (oldReplicationMode !== newReplicationMode) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.databaseId) {
            return yield* getDb({
              accountId: output.accountId,
              databaseId: output.databaseId,
            }).pipe(
              Effect.map((db) => ({
                databaseId: db.uuid ?? output.databaseId,
                databaseName: db.name ?? output.databaseName,
                jurisdiction: output.jurisdiction,
                readReplication: db.readReplication ?? undefined,
                accountId: output.accountId,
              })),
              Effect.catchTag("DatabaseNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const name = yield* createDatabaseName(id, olds?.name);
          const dbs = yield* listDbs({ accountId, name });
          const match = dbs.result.find((db) => db.name === name);
          if (match) {
            return {
              databaseId: match.uuid!,
              databaseName: match.name ?? name,
              jurisdiction: (olds?.jurisdiction ?? "default") as Jurisdiction,
              readReplication: olds?.readReplication,
              accountId,
            };
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const name = yield* createDatabaseName(id, news.name);
          const jurisdiction = news.jurisdiction ?? "default";
          const db = yield* createDb({
            accountId,
            name,
            jurisdiction: jurisdiction !== "default" ? jurisdiction : undefined,
            primaryLocationHint: news.primaryLocationHint,
          }).pipe(
            Effect.catchTag("InvalidProperty", () =>
              Effect.gen(function* () {
                const dbs = yield* listDbs({ accountId, name });
                const match = dbs.result.find((db) => db.name === name);
                if (match) {
                  return match;
                }
                return yield* Effect.die(
                  `Database with name "${name}" already exists but could not be found`,
                );
              }),
            ),
          );

          const databaseId = db.uuid!;

          if (news.readReplication?.mode) {
            yield* patchDb({
              accountId,
              databaseId,
              readReplication: news.readReplication,
            });
          }

          return {
            databaseId,
            databaseName: db.name ?? name,
            jurisdiction,
            readReplication: news.readReplication,
            accountId,
          };
        }),
        update: Effect.fn(function* ({ news = {}, output }) {
          const replicationMode = news.readReplication?.mode ?? "disabled";
          const updated = yield* patchDb({
            accountId: output.accountId,
            databaseId: output.databaseId,
            readReplication: { mode: replicationMode },
          });
          return {
            databaseId: updated.uuid ?? output.databaseId,
            databaseName: updated.name ?? output.databaseName,
            jurisdiction: output.jurisdiction,
            readReplication: news.readReplication,
            accountId: output.accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteDb({
            accountId: output.accountId,
            databaseId: output.databaseId,
          }).pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
        }),
      };
    }),
  );

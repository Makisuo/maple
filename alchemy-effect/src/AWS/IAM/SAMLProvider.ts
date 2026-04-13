import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { diffTags } from "../../Tags.ts";
import { toTagRecord, unwrapRedactedString } from "./common.ts";

export interface SAMLProviderProps {
  /**
   * The friendly SAML provider name.
   */
  name: string;
  /**
   * The provider metadata document.
   */
  samlMetadataDocument: string;
  /**
   * Optional assertion encryption mode.
   */
  assertionEncryptionMode?: iam.AssertionEncryptionModeType;
  /**
   * Optional private key added during creation/update.
   */
  addPrivateKey?: Redacted.Redacted<string> | string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface SAMLProvider extends Resource<
  "AWS.IAM.SAMLProvider",
  SAMLProviderProps,
  {
    samlProviderArn: string;
    name: string;
    samlProviderUUID: string | undefined;
    samlMetadataDocument: string | undefined;
    assertionEncryptionMode: iam.AssertionEncryptionModeType | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An IAM SAML identity provider.
 *
 * `SAMLProvider` registers a SAML metadata document so IAM roles can trust an
 * external workforce or application identity provider.
 *
 * @section Federating with SAML
 * @example Create a SAML Identity Provider
 * ```typescript
 * const provider = yield* SAMLProvider("WorkforceSaml", {
 *   name: "workforce-saml",
 *   samlMetadataDocument: "<EntityDescriptor>...</EntityDescriptor>",
 * });
 * ```
 */
export const SAMLProvider = Resource<SAMLProvider>("AWS.IAM.SAMLProvider");

export const SAMLProviderProvider = () =>
  Provider.succeed(SAMLProvider, {
    stables: ["samlProviderArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.name !== news.name) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response) {
        return undefined;
      }
      const tags = yield* iam.listSAMLProviderTags({
        SAMLProviderArn: output.samlProviderArn,
      });
      return {
        samlProviderArn: output.samlProviderArn,
        name: output.name,
        samlProviderUUID: response.SAMLProviderUUID,
        samlMetadataDocument: response.SAMLMetadataDocument,
        assertionEncryptionMode: response.AssertionEncryptionMode,
        tags: toTagRecord(tags.Tags),
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const response = yield* iam.createSAMLProvider({
        Name: news.name,
        SAMLMetadataDocument: news.samlMetadataDocument,
        AssertionEncryptionMode: news.assertionEncryptionMode,
        AddPrivateKey: news.addPrivateKey
          ? unwrapRedactedString(news.addPrivateKey)
          : undefined,
        Tags: Object.entries(news.tags ?? {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      });
      const samlProviderArn = response.SAMLProviderArn ?? news.name;
      yield* session.note(samlProviderArn);
      return {
        samlProviderArn,
        name: news.name,
        samlProviderUUID: undefined,
        samlMetadataDocument: news.samlMetadataDocument,
        assertionEncryptionMode: news.assertionEncryptionMode,
        tags: news.tags ?? {},
      };
    }),
    update: Effect.fn(function* ({ news, olds, output, session }) {
      yield* iam.updateSAMLProvider({
        SAMLProviderArn: output.samlProviderArn,
        SAMLMetadataDocument:
          news.samlMetadataDocument !== olds.samlMetadataDocument
            ? news.samlMetadataDocument
            : undefined,
        AssertionEncryptionMode: news.assertionEncryptionMode,
        AddPrivateKey: news.addPrivateKey
          ? unwrapRedactedString(news.addPrivateKey)
          : undefined,
      });
      const { removed, upsert } = diffTags(olds.tags ?? {}, news.tags ?? {});
      if (upsert.length > 0) {
        yield* iam.tagSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
          Tags: upsert,
        });
      }
      if (removed.length > 0) {
        yield* iam.untagSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
          TagKeys: removed,
        });
      }
      yield* session.note(output.samlProviderArn);
      return {
        samlProviderArn: output.samlProviderArn,
        name: output.name,
        samlProviderUUID: output.samlProviderUUID,
        samlMetadataDocument: news.samlMetadataDocument,
        assertionEncryptionMode: news.assertionEncryptionMode,
        tags: news.tags ?? {},
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });

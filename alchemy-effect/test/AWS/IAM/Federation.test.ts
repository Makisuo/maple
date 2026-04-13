import * as AWS from "@/AWS";
import { OpenIDConnectProvider, SAMLProvider } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  testOidcThumbprintA,
  testOidcThumbprintB,
  testOidcUrl,
  testSamlMetadataDocument,
  testSamlMetadataDocumentUpdated,
  testSamlProviderName,
} from "./fixtures.ts";

describe("AWS.IAM federation resources", () => {
  test(
    "create, update, and delete an OpenID Connect provider",
    Effect.gen(function* () {
      yield* destroy();

      const provider = yield* test.deploy(
        Effect.gen(function* () {
          return yield* OpenIDConnectProvider("OidcProvider", {
            url: testOidcUrl,
            clientIDList: ["sts.amazonaws.com"],
            thumbprintList: [testOidcThumbprintA],
            tags: {
              env: "test",
            },
          });
        }),
      );

      const created = yield* IAM.getOpenIDConnectProvider({
        OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
      });
      expect(created.Url).toBe(testOidcUrl.replace(/^https?:\/\//, ""));
      expect(created.ClientIDList ?? []).toContain("sts.amazonaws.com");

      yield* test.deploy(
        Effect.gen(function* () {
          return yield* OpenIDConnectProvider("OidcProvider", {
            url: testOidcUrl,
            clientIDList: ["sts.amazonaws.com", "alchemy-client"],
            thumbprintList: [testOidcThumbprintB],
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updated = yield* IAM.getOpenIDConnectProvider({
        OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
      });
      expect(updated.ClientIDList ?? []).toContain("alchemy-client");
      expect(updated.ThumbprintList).toEqual([testOidcThumbprintB]);

      const tags = yield* IAM.listOpenIDConnectProviderTags({
        OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
      });
      expect(
        Object.fromEntries(
          (tags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* destroy();

      const deleted = yield* IAM.getOpenIDConnectProvider({
        OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create, update, and delete a SAML provider",
    Effect.gen(function* () {
      yield* destroy();

      const provider = yield* test.deploy(
        Effect.gen(function* () {
          return yield* SAMLProvider("SamlProvider", {
            name: testSamlProviderName,
            samlMetadataDocument: testSamlMetadataDocument,
            tags: {
              env: "test",
            },
          });
        }),
      );

      const created = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(created.SAMLMetadataDocument).toContain("urn:alchemy:test:idp");

      yield* test.deploy(
        Effect.gen(function* () {
          return yield* SAMLProvider("SamlProvider", {
            name: testSamlProviderName,
            samlMetadataDocument: testSamlMetadataDocumentUpdated,
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updated = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(updated.SAMLMetadataDocument).toContain(
        "urn:alchemy:test:idp:updated",
      );

      const tags = yield* IAM.listSAMLProviderTags({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(
        Object.fromEntries(
          (tags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* destroy();

      const deleted = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }).pipe(Effect.provide(AWS.providers())),
  );
});

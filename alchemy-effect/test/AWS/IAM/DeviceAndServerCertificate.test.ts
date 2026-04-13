import * as AWS from "@/AWS";
import { ServerCertificate, VirtualMFADevice } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { testCertificateBody, testPrivateKey } from "./fixtures.ts";

describe("AWS.IAM device and server certificate resources", () => {
  test(
    "create, update, and delete a server certificate",
    Effect.gen(function* () {
      yield* destroy();

      const certificate = yield* test.deploy(
        Effect.gen(function* () {
          return yield* ServerCertificate("ServerCertificate", {
            certificateBody: testCertificateBody,
            privateKey: testPrivateKey,
            tags: {
              env: "test",
            },
          });
        }),
      );

      const created = yield* IAM.getServerCertificate({
        ServerCertificateName: certificate.serverCertificateName,
      });
      expect(
        created.ServerCertificate.ServerCertificateMetadata
          .ServerCertificateName,
      ).toBe(certificate.serverCertificateName);

      yield* test.deploy(
        Effect.gen(function* () {
          return yield* ServerCertificate("ServerCertificate", {
            certificateBody: testCertificateBody,
            privateKey: testPrivateKey,
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updatedTags = yield* IAM.listServerCertificateTags({
        ServerCertificateName: certificate.serverCertificateName,
      });
      expect(
        Object.fromEntries(
          (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* destroy();

      const deleted = yield* IAM.getServerCertificate({
        ServerCertificateName: certificate.serverCertificateName,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create, update, and delete an unassigned virtual MFA device",
    Effect.gen(function* () {
      yield* destroy();

      const device = yield* test.deploy(
        Effect.gen(function* () {
          return yield* VirtualMFADevice("VirtualMfaDevice", {
            tags: {
              env: "test",
            },
          });
        }),
      );

      expect(device.base32StringSeed).toBeDefined();
      expect(device.qrCodePNG).toBeDefined();

      const created = yield* IAM.listVirtualMFADevices({
        AssignmentStatus: "Unassigned",
      });
      expect(
        created.VirtualMFADevices.some(
          (entry) => entry.SerialNumber === device.serialNumber,
        ),
      ).toBe(true);

      yield* test.deploy(
        Effect.gen(function* () {
          return yield* VirtualMFADevice("VirtualMfaDevice", {
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updatedTags = yield* IAM.listMFADeviceTags({
        SerialNumber: device.serialNumber,
      });
      expect(
        Object.fromEntries(
          (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* destroy();

      const deleted = yield* IAM.listVirtualMFADevices({
        AssignmentStatus: "Unassigned",
      }).pipe(Effect.option);
      expect(
        deleted._tag === "None" ||
          !deleted.value.VirtualMFADevices.some(
            (entry) => entry.SerialNumber === device.serialNumber,
          ),
      ).toBe(true);
    }).pipe(Effect.provide(AWS.providers())),
  );
});

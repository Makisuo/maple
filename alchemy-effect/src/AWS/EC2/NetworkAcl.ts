import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import { Account } from "../Account.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type NetworkAclId<ID extends string = string> = `acl-${ID}`;
export const NetworkAclId = <ID extends string>(
  id: ID,
): ID & NetworkAclId<ID> => `acl-${id}` as ID & NetworkAclId<ID>;

export type NetworkAclArn<ID extends NetworkAclId = NetworkAclId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:network-acl/${ID}`;

export interface NetworkAclProps {
  /**
   * The VPC to create the network ACL in.
   */
  vpcId: VpcId;

  /**
   * Tags to assign to the network ACL.
   */
  tags?: Record<string, string>;
}

export interface NetworkAcl extends Resource<
  "AWS.EC2.NetworkAcl",
  NetworkAclProps,
  {
    networkAclId: NetworkAclId;
    networkAclArn: NetworkAclArn;
    vpcId: VpcId;
    isDefault: boolean;
    ownerId: string;
    entries?: Array<{
      ruleNumber: number;
      protocol: string;
      ruleAction: ec2.RuleAction;
      egress: boolean;
      cidrBlock?: string;
      ipv6CidrBlock?: string;
      icmpTypeCode?: {
        code?: number;
        type?: number;
      };
      portRange?: {
        from?: number;
        to?: number;
      };
    }>;
    associations?: Array<{
      networkAclAssociationId: string;
      networkAclId: string;
      subnetId: string;
    }>;
  }
> {}
export const NetworkAcl = Resource<NetworkAcl>("AWS.EC2.NetworkAcl");

export const NetworkAclProvider = () =>
  Provider.effect(
    NetworkAcl,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeNetworkAcl = (networkAclId: string) =>
        ec2.describeNetworkAcls({ NetworkAclIds: [networkAclId] }).pipe(
          Effect.map((r) => r.NetworkAcls?.[0]),
          Effect.flatMap((acl) =>
            acl
              ? Effect.succeed(acl)
              : Effect.fail(new Error(`Network ACL ${networkAclId} not found`)),
          ),
        );

      const toAttrs = (acl: ec2.NetworkAcl) => ({
        networkAclId: acl.NetworkAclId as NetworkAclId,
        networkAclArn:
          `arn:aws:ec2:${region}:${accountId}:network-acl/${acl.NetworkAclId}` as NetworkAclArn,
        vpcId: acl.VpcId as VpcId,
        isDefault: acl.IsDefault ?? false,
        ownerId: acl.OwnerId!,
        entries: acl.Entries?.map((e) => ({
          ruleNumber: e.RuleNumber!,
          protocol: e.Protocol!,
          ruleAction: e.RuleAction!,
          egress: e.Egress!,
          cidrBlock: e.CidrBlock,
          ipv6CidrBlock: e.Ipv6CidrBlock,
          icmpTypeCode: e.IcmpTypeCode
            ? {
                code: e.IcmpTypeCode.Code,
                type: e.IcmpTypeCode.Type,
              }
            : undefined,
          portRange: e.PortRange
            ? {
                from: e.PortRange.From,
                to: e.PortRange.To,
              }
            : undefined,
        })),
        associations: acl.Associations?.map((a) => ({
          networkAclAssociationId: a.NetworkAclAssociationId!,
          networkAclId: a.NetworkAclId!,
          subnetId: a.SubnetId!,
        })),
      });

      return {
        stables: ["networkAclId", "networkAclArn", "ownerId", "isDefault"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const acl = yield* describeNetworkAcl(output.networkAclId);
          return toAttrs(acl);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note("Creating Network ACL...");

          const result = yield* ec2.createNetworkAcl({
            VpcId: news.vpcId as string,
            TagSpecifications: [
              {
                ResourceType: "network-acl",
                Tags: createTagsList(yield* createTags(id, news.tags)),
              },
            ],
            DryRun: false,
          });

          const networkAclId = result.NetworkAcl!.NetworkAclId!;
          yield* session.note(`Network ACL created: ${networkAclId}`);

          const acl = yield* describeNetworkAcl(networkAclId);
          return toAttrs(acl);
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const networkAclId = output.networkAclId;

          // Handle tag updates
          const newTags = yield* createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [networkAclId] },
                  { Name: "resource-type", Values: ["network-acl"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};

          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [networkAclId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [networkAclId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          const acl = yield* describeNetworkAcl(networkAclId);
          return toAttrs(acl);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const networkAclId = output.networkAclId;

          yield* session.note(`Deleting Network ACL: ${networkAclId}`);

          yield* ec2
            .deleteNetworkAcl({
              NetworkAclId: networkAclId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidNetworkAclID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations (e.g., associations still being removed)
              Effect.retry({
                while: (e) => {
                  return e._tag === "DependencyViolation";
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.both(Schedule.recurs(15)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Network ACL ${networkAclId} deleted`);
        }),
      };
    }),
  );

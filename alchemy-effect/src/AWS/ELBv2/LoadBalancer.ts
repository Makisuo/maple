import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { RegionID } from "../Region.ts";

export type LoadBalancerName = string;
export type LoadBalancerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:loadbalancer/${string}`;

export interface LoadBalancerProps {
  name?: string;
  scheme?: "internal" | "internet-facing";
  type?: "application" | "network";
  subnets: Input<SubnetId[]>;
  securityGroups?: Input<SecurityGroupId[]>;
  ipAddressType?: string;
  attributes?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface LoadBalancer extends Resource<
  "AWS.ELBv2.LoadBalancer",
  LoadBalancerProps,
  {
    loadBalancerArn: LoadBalancerArn;
    loadBalancerName: LoadBalancerName;
    dnsName: string;
    canonicalHostedZoneId: string;
    vpcId: string;
    scheme: string;
    type: string;
    securityGroups: string[];
    subnets: string[];
    tags: Record<string, string>;
  }
> {}

export const LoadBalancer = Resource<LoadBalancer>("AWS.ELBv2.LoadBalancer");

export const LoadBalancerProvider = () =>
  Provider.effect(
    LoadBalancer,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: [
          "loadBalancerArn",
          "loadBalancerName",
          "dnsName",
          "canonicalHostedZoneId",
          "vpcId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              {
                scheme: olds.scheme ?? "internet-facing",
                type: olds.type ?? "application",
                subnets: olds.subnets,
                securityGroups: olds.securityGroups ?? [],
                ipAddressType: olds.ipAddressType,
              },
              {
                scheme: news.scheme ?? "internet-facing",
                type: news.type ?? "application",
                subnets: news.subnets,
                securityGroups: news.securityGroups ?? [],
                ipAddressType: news.ipAddressType,
              },
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const described = yield* elbv2
            .describeLoadBalancers({
              LoadBalancerArns: [output.loadBalancerArn],
            })
            .pipe(
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const loadBalancer = described?.LoadBalancers?.[0];
          if (!loadBalancer?.LoadBalancerArn) {
            return undefined;
          }
          return {
            ...output,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const created = yield* elbv2.createLoadBalancer({
            Name: name,
            Scheme: news.scheme ?? "internet-facing",
            Type: news.type ?? "application",
            Subnets: news.subnets as string[],
            SecurityGroups: news.securityGroups as string[] | undefined,
            IpAddressType: news.ipAddressType,
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          });
          const loadBalancer = created.LoadBalancers?.[0];
          if (!loadBalancer?.LoadBalancerArn) {
            return yield* Effect.die(
              new Error("createLoadBalancer returned no load balancer"),
            );
          }
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyLoadBalancerAttributes({
              LoadBalancerArn: loadBalancer.LoadBalancerArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }
          yield* session.note(loadBalancer.LoadBalancerArn);
          return {
            loadBalancerArn: loadBalancer.LoadBalancerArn as LoadBalancerArn,
            loadBalancerName: loadBalancer.LoadBalancerName!,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          if (
            JSON.stringify(news.attributes ?? {}) !==
            JSON.stringify(olds.attributes ?? {})
          ) {
            yield* elbv2.modifyLoadBalancerAttributes({
              LoadBalancerArn: output.loadBalancerArn,
              Attributes: Object.entries(news.attributes ?? {}).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
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
            yield* elbv2.addTags({
              ResourceArns: [output.loadBalancerArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [output.loadBalancerArn],
              TagKeys: removed,
            });
          }
          yield* session.note(output.loadBalancerArn);
          return {
            ...output,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elbv2
            .deleteLoadBalancer({
              LoadBalancerArn: output.loadBalancerArn,
            })
            .pipe(
              Effect.catchTag(
                "LoadBalancerNotFoundException",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );

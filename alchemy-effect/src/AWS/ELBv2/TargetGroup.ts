import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type TargetGroupName = string;
export type TargetGroupArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:targetgroup/${string}`;

export interface TargetGroupProps {
  name?: string;
  vpcId: string;
  port: number;
  protocol?: "HTTP" | "HTTPS" | "TCP";
  targetType?: "ip" | "instance";
  healthCheckPath?: string;
  healthCheckPort?: string;
  healthCheckProtocol?: string;
  matcher?: { HttpCode?: string; GrpcCode?: string };
  attributes?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface TargetGroup extends Resource<
  "AWS.ELBv2.TargetGroup",
  TargetGroupProps,
  {
    targetGroupArn: TargetGroupArn;
    targetGroupName: TargetGroupName;
    port: number;
    protocol: string;
    targetType: string;
    vpcId: string;
    tags: Record<string, string>;
  }
> {}

export const TargetGroup = Resource<TargetGroup>("AWS.ELBv2.TargetGroup");

export const TargetGroupProvider = () =>
  Provider.effect(
    TargetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: ["targetGroupArn", "targetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              {
                vpcId: olds.vpcId,
                protocol: olds.protocol ?? "HTTP",
                port: olds.port,
                targetType: olds.targetType ?? "ip",
              },
              {
                vpcId: news.vpcId,
                protocol: news.protocol ?? "HTTP",
                port: news.port,
                targetType: news.targetType ?? "ip",
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
            .describeTargetGroups({
              TargetGroupArns: [output.targetGroupArn],
            })
            .pipe(
              Effect.catchTag("TargetGroupNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const targetGroup = described?.TargetGroups?.[0];
          if (!targetGroup?.TargetGroupArn) {
            return undefined;
          }
          return {
            ...output,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const created = yield* elbv2.createTargetGroup({
            Name: name,
            Port: news.port,
            Protocol: news.protocol ?? "HTTP",
            VpcId: news.vpcId,
            TargetType: news.targetType ?? "ip",
            HealthCheckPath: news.healthCheckPath,
            HealthCheckPort: news.healthCheckPort,
            HealthCheckProtocol: news.healthCheckProtocol,
            Matcher: news.matcher,
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          });
          const targetGroup = created.TargetGroups?.[0];
          if (!targetGroup?.TargetGroupArn) {
            return yield* Effect.die(
              new Error("createTargetGroup returned no target group"),
            );
          }
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyTargetGroupAttributes({
              TargetGroupArn: targetGroup.TargetGroupArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }
          yield* session.note(targetGroup.TargetGroupArn);
          return {
            targetGroupArn: targetGroup.TargetGroupArn as TargetGroupArn,
            targetGroupName: targetGroup.TargetGroupName!,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* elbv2.modifyTargetGroup({
            TargetGroupArn: output.targetGroupArn,
            HealthCheckPath: news.healthCheckPath,
            HealthCheckPort: news.healthCheckPort,
            HealthCheckProtocol: news.healthCheckProtocol,
            Matcher: news.matcher,
          });
          if (
            JSON.stringify(news.attributes ?? {}) !==
            JSON.stringify(olds.attributes ?? {})
          ) {
            yield* elbv2.modifyTargetGroupAttributes({
              TargetGroupArn: output.targetGroupArn,
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
              ResourceArns: [output.targetGroupArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [output.targetGroupArn],
              TagKeys: removed,
            });
          }
          yield* session.note(output.targetGroupArn);
          return {
            ...output,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elbv2
            .deleteTargetGroup({
              TargetGroupArn: output.targetGroupArn,
            })
            .pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );

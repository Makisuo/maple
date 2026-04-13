import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";
import type { LoadBalancer, LoadBalancerArn } from "./LoadBalancer.ts";
import type { TargetGroup, TargetGroupArn } from "./TargetGroup.ts";

export type ListenerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:listener/${string}`;

export interface ListenerProps {
  loadBalancerArn: Input<LoadBalancerArn> | LoadBalancer;
  targetGroupArn: Input<TargetGroupArn> | TargetGroup;
  port: number;
  protocol?: "HTTP" | "HTTPS" | "TCP";
  certificateArn?: string;
  sslPolicy?: string;
}

export interface Listener extends Resource<
  "AWS.ELBv2.Listener",
  ListenerProps,
  {
    listenerArn: ListenerArn;
    loadBalancerArn: LoadBalancerArn;
    targetGroupArn: TargetGroupArn;
    port: number;
    protocol: string;
  }
> {}

export const Listener = Resource<Listener>("AWS.ELBv2.Listener");

export const ListenerProvider = () =>
  Provider.succeed(Listener, {
    stables: ["listenerArn", "loadBalancerArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.loadBalancerArn !== news.loadBalancerArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const described = yield* elbv2
        .describeListeners({
          ListenerArns: [output.listenerArn],
        })
        .pipe(
          Effect.catchTag("ListenerNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const listener = described?.Listeners?.[0];
      if (!listener?.ListenerArn) {
        return undefined;
      }
      const defaultForward = (listener.DefaultActions ?? []).find(
        (action) => action.Type === "forward",
      );
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: (defaultForward?.TargetGroupArn ??
          output.targetGroupArn) as TargetGroupArn,
        port: listener.Port!,
        protocol: listener.Protocol!,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const created = yield* elbv2.createListener({
        LoadBalancerArn: news.loadBalancerArn as string,
        Port: news.port,
        Protocol: news.protocol ?? "HTTP",
        Certificates: news.certificateArn
          ? [{ CertificateArn: news.certificateArn }]
          : undefined,
        SslPolicy: news.sslPolicy,
        DefaultActions: [
          {
            Type: "forward",
            TargetGroupArn: news.targetGroupArn as string,
          },
        ],
      });
      const listener = created.Listeners?.[0];
      if (!listener?.ListenerArn) {
        return yield* Effect.die(
          new Error("createListener returned no listener"),
        );
      }
      yield* session.note(listener.ListenerArn);
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: news.targetGroupArn as TargetGroupArn,
        port: listener.Port!,
        protocol: listener.Protocol!,
      };
    }),
    update: Effect.fn(function* ({ news, output, session }) {
      const modified = yield* elbv2.modifyListener({
        ListenerArn: output.listenerArn,
        Port: news.port,
        Protocol: news.protocol ?? "HTTP",
        Certificates: news.certificateArn
          ? [{ CertificateArn: news.certificateArn }]
          : undefined,
        SslPolicy: news.sslPolicy,
        DefaultActions: [
          {
            Type: "forward",
            TargetGroupArn: news.targetGroupArn as string,
          },
        ],
      });
      const listener = modified.Listeners?.[0];
      yield* session.note(output.listenerArn);
      return {
        listenerArn: output.listenerArn,
        loadBalancerArn: output.loadBalancerArn,
        targetGroupArn: news.targetGroupArn as TargetGroupArn,
        port: listener?.Port ?? news.port,
        protocol: listener?.Protocol ?? news.protocol ?? "HTTP",
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .deleteListener({
          ListenerArn: output.listenerArn,
        })
        .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.void));
    }),
  });

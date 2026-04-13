import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { RouteTableId } from "./RouteTable.ts";
import type { SubnetId } from "./Subnet.ts";

export type RouteTableAssociationId<ID extends string = string> =
  `rtbassoc-${ID}`;
export const RouteTableAssociationId = <ID extends string>(
  id: ID,
): ID & RouteTableAssociationId<ID> =>
  `rtbassoc-${id}` as ID & RouteTableAssociationId<ID>;

export interface RouteTableAssociationProps {
  /**
   * The ID of the route table.
   * Required.
   */
  routeTableId: RouteTableId;

  /**
   * The ID of the subnet to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  subnetId?: SubnetId;

  /**
   * The ID of the gateway (internet gateway or virtual private gateway) to associate with the route table.
   * Either subnetId or gatewayId is required, but not both.
   */
  gatewayId?: string;
}

export interface RouteTableAssociation extends Resource<
  "AWS.EC2.RouteTableAssociation",
  RouteTableAssociationProps,
  {
    /**
     * The ID of the association.
     */
    associationId: RouteTableAssociationId;

    /**
     * The ID of the route table.
     */
    routeTableId: RouteTableId;

    /**
     * The ID of the subnet (if the association is with a subnet).
     */
    subnetId?: SubnetId | undefined;

    /**
     * The ID of the gateway (if the association is with a gateway).
     */
    gatewayId?: string | undefined;

    /**
     * The state of the association.
     */
    associationState: {
      state: EC2.RouteTableAssociationStateCode;
      statusMessage?: string;
    };
  }
> {}
export const RouteTableAssociation = Resource<RouteTableAssociation>(
  "AWS.EC2.RouteTableAssociation",
);

export const RouteTableAssociationProvider = () =>
  Provider.effect(
    RouteTableAssociation,
    Effect.gen(function* () {
      return {
        stables: ["associationId", "subnetId", "gatewayId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Subnet/Gateway change requires replacement (use ReplaceRouteTableAssociation internally)
          if (olds.subnetId !== news.subnetId) {
            return { action: "replace" };
          }
          if (olds.gatewayId !== news.gatewayId) {
            return { action: "replace" };
          }
          // Route table change can be done via ReplaceRouteTableAssociation
        }),

        create: Effect.fn(function* ({ news, session }) {
          // Call AssociateRouteTable
          const result = yield* ec2
            .associateRouteTable({
              RouteTableId: news.routeTableId,
              SubnetId: news.subnetId,
              GatewayId: news.gatewayId,
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                // Retry if route table or subnet/gateway is not yet available
                while: (e) =>
                  e._tag === "InvalidRouteTableID.NotFound" ||
                  e._tag === "InvalidSubnetID.NotFound",
                schedule: Schedule.exponential(100),
              }),
            );

          const associationId =
            result.AssociationId! as RouteTableAssociationId;
          yield* session.note(
            `Route table association created: ${associationId}`,
          );

          // Wait for association to be associated
          yield* waitForAssociationState(
            news.routeTableId,
            associationId,
            "associated",
            session,
          );

          // Return attributes
          return {
            associationId,
            routeTableId: news.routeTableId as RouteTableId,
            subnetId: news.subnetId as SubnetId | undefined,
            gatewayId: news.gatewayId as string | undefined,
            associationState: {
              state: result.AssociationState?.State ?? "associated",
              statusMessage: result.AssociationState?.StatusMessage,
            },
          };
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          // If route table changed, use ReplaceRouteTableAssociation
          if (news.routeTableId !== olds.routeTableId) {
            const result = yield* ec2.replaceRouteTableAssociation({
              AssociationId: output.associationId,
              RouteTableId: news.routeTableId,
              DryRun: false,
            });

            const newAssociationId =
              result.NewAssociationId! as RouteTableAssociationId;
            yield* session.note(
              `Route table association replaced: ${newAssociationId}`,
            );

            // Wait for new association to be associated
            yield* waitForAssociationState(
              news.routeTableId,
              newAssociationId,
              "associated",
              session,
            );

            return {
              associationId: newAssociationId,
              routeTableId: news.routeTableId as RouteTableId,
              subnetId: news.subnetId as SubnetId | undefined,
              gatewayId: news.gatewayId as string | undefined,
              associationState: {
                state: result.AssociationState?.State ?? "associated",
                statusMessage: result.AssociationState?.StatusMessage,
              },
            };
          }

          // No changes needed
          return output;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* session.note(
            `Deleting route table association: ${output.associationId}`,
          );

          // Disassociate the route table
          yield* ec2
            .disassociateRouteTable({
              AssociationId: output.associationId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.log),
              Effect.catchTag(
                "InvalidAssociationID.NotFound",
                () => Effect.void,
              ),
            );

          yield* session.note(
            `Route table association ${output.associationId} deleted successfully`,
          );
        }),
      };
    }),
  );

/**
 * Wait for association to reach a specific state
 */
const waitForAssociationState = (
  routeTableId: string,
  associationId: string,
  targetState:
    | "associating"
    | "associated"
    | "disassociating"
    | "disassociated",
  session?: ScopedPlanStatusSession,
) =>
  Effect.retry(
    Effect.gen(function* () {
      const result = yield* ec2
        .describeRouteTables({ RouteTableIds: [routeTableId] })
        .pipe(
          Effect.catchTag("InvalidRouteTableID.NotFound", () =>
            Effect.succeed({
              RouteTables: [],
            } as ec2.DescribeRouteTablesResult),
          ),
        );

      const routeTable = result.RouteTables?.[0];
      if (!routeTable) {
        return yield* Effect.fail(new Error("Route table not found"));
      }

      const association = routeTable.Associations?.find(
        (a) => a.RouteTableAssociationId === associationId,
      );

      if (!association) {
        // Association might not exist yet, retry
        return yield* Effect.fail(new Error("Association not found"));
      }

      if (association.AssociationState?.State === targetState) {
        return;
      }

      if (association.AssociationState?.State === "failed") {
        return yield* Effect.fail(
          new Error(
            `Association failed: ${association.AssociationState.StatusMessage}`,
          ),
        );
      }

      // Still in progress, fail to trigger retry
      return yield* Effect.fail(
        new Error(`Association state: ${association.AssociationState?.State}`),
      );
    }),
    {
      schedule: Schedule.fixed(1000).pipe(
        // Check every second
        Schedule.both(Schedule.recurs(30)), // Max 30 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for association to be ${targetState}... (${attempt + 1}s)`,
              )
            : Effect.void,
        ),
      ),
    },
  );

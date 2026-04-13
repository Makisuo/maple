/** @jsxImportSource react */
import { useMemo, type JSX } from "react";

import { Box, Text } from "ink";
import type { Plan as AlchemyPlan, BindingAction, CRUD } from "../../Plan.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type DerivedAction,
} from "../NamespaceTree.ts";

export interface PlanProps {
  plan: AlchemyPlan;
}
export function Plan({ plan }: PlanProps): JSX.Element {
  const items = useMemo(
    () =>
      [
        ...Object.values(plan.resources),
        ...Object.values(plan.deletions),
      ] as CRUD[],
    [plan],
  );

  const flatItems = useMemo(() => {
    const tree = buildNamespaceTree(items);
    return flattenTree(tree);
  }, [items]);

  if (items.length === 0) {
    return <Text color="gray">No changes planned</Text>;
  }

  const counts = items.reduce((acc, item) => (acc[item.action]++, acc), {
    create: 0,
    update: 0,
    delete: 0,
    noop: 0,
    replace: 0,
  });

  const actions = (["create", "update", "delete", "replace"] as const).filter(
    (action) => counts[action] > 0,
  );

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text underline>Plan</Text>
        <Text>: </Text>
        {actions.flatMap((action, i) => {
          const count = counts[action];
          const color = actionColor(action);
          if (count === 0) return [];
          const box = (
            <Box key={action}>
              <Text color={color}>
                {count} to {action}
              </Text>
            </Box>
          );
          return i === actions.length - 1
            ? [box]
            : [box, <Text key={`${action}-separator`}> | </Text>];
        })}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {flatItems.map((item) => {
          const indent = "  ".repeat(item.depth);
          const color = getActionColor(item.action);
          const icon = getActionIcon(item.action);
          const key = item.path.join("/");

          if (item.type === "namespace") {
            return (
              <Box key={key} flexDirection="row">
                <Text>{indent}</Text>
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Text color="blueBright">{item.id}</Text>
              </Box>
            );
          }

          if (item.type === "binding") {
            return (
              <Box key={key} flexDirection="row">
                <Text>{indent}</Text>
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Text color="cyan">{item.bindingSid}</Text>
              </Box>
            );
          }

          // Resource item
          return (
            <Box key={key} flexDirection="row">
              <Text>{indent}</Text>
              <Box width={2}>
                <Text color={color}>{icon} </Text>
              </Box>
              <Box>
                <Text bold>{item.id}</Text>
              </Box>
              <Box marginLeft={1}>
                <Text color="blackBright">({item.resourceType})</Text>
              </Box>
              {item.bindingCount !== undefined && item.bindingCount > 0 && (
                <Box marginLeft={1}>
                  <Text color="cyan">({item.bindingCount} bindings)</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

type Color = Parameters<typeof Text>[0]["color"];

type AnyAction = CRUD["action"] | BindingAction | DerivedAction;

const getActionColor = (action: AnyAction): Color =>
  ({
    noop: "gray",
    create: "green",
    update: "yellow",
    delete: "red",
    replace: "magenta",
    mixed: "cyan",
  })[action] ?? "gray";

const getActionIcon = (action: AnyAction): string =>
  ({
    create: "+",
    update: "~",
    delete: "-",
    noop: "•",
    replace: "!",
    mixed: "*",
  })[action] ?? "?";

const actionColor = (action: CRUD["action"]): Color => getActionColor(action);

/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import { Box, Text } from "ink";
import type { CRUD, Plan } from "../../Plan.ts";

import type { ApplyEvent, ApplyStatus, StatusChangeEvent } from "../Event.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type FlattenedItem,
} from "../NamespaceTree.ts";

interface ProgressEventSource {
  subscribe(listener: (event: ApplyEvent) => void): () => void;
}

interface PlanTask extends Required<
  Pick<StatusChangeEvent, "id" | "type" | "status">
> {
  key: string;
  message?: string;
  updatedAt: number;
}

interface PlanProgressProps {
  source: ProgressEventSource;
  plan: Plan;
}

type PlanItem = CRUD | NonNullable<Plan["deletions"][string]>;

export type ProgressRow =
  | {
      key: string;
      type: "namespace";
      id: string;
      depth: number;
      action: FlattenedItem["action"];
    }
  | {
      key: string;
      type: "resource";
      id: string;
      depth: number;
      resourceType: string;
      action: CRUD["action"];
      /** For `noop` resources, persisted state status to show instead of `pending`. */
      persistedApplyStatus?: "created" | "updated";
    };

const getTaskKey = (item: FlattenedItem) => item.path.join("/");

type ResourceProgressRow = Extract<ProgressRow, { type: "resource" }>;

export const buildProgressRows = (plan: Plan): ProgressRow[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<Plan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as PlanItem[];
  const tree = buildNamespaceTree(items);
  return flattenTree(tree)
    .filter((item) => item.type !== "binding")
    .map((item) =>
      item.type === "namespace"
        ? {
            key: getTaskKey(item),
            type: "namespace" as const,
            id: item.id,
            depth: item.depth,
            action: item.action,
          }
        : {
            key: getTaskKey(item),
            type: "resource" as const,
            id: item.id,
            depth: item.depth,
            resourceType: item.resourceType ?? "unknown",
            action: item.action as CRUD["action"],
            persistedApplyStatus:
              item.action === "noop"
                ? (() => {
                    const crud = findCrudByLogicalId(plan, item.id);
                    return crud?.action === "noop"
                      ? crud.state.status
                      : undefined;
                  })()
                : undefined,
          },
    );
};

const buildLogicalIdIndex = (rows: ProgressRow[]) => {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    if (row.type !== "resource") continue;
    const keys = index.get(row.id);
    if (keys) {
      keys.push(row.key);
    } else {
      index.set(row.id, [row.key]);
    }
  }
  return index;
};

export function toPlanTask(id: string, planItem: PlanItem): PlanTask;
export function toPlanTask(row: ResourceProgressRow): PlanTask;
export function toPlanTask(
  rowOrId: ResourceProgressRow | string,
  planItem?: PlanItem,
): PlanTask {
  if (typeof rowOrId === "string") {
    return {
      key: rowOrId,
      id: rowOrId,
      type: planItem!.resource.Type,
      status: planItem!.action === "noop" ? planItem!.state.status : "pending",
      updatedAt: Date.now(),
    };
  }

  return {
    key: rowOrId.key,
    id: rowOrId.id,
    type: rowOrId.resourceType,
    status:
      rowOrId.action === "noop"
        ? (rowOrId.persistedApplyStatus ?? "created")
        : "pending",
    updatedAt: Date.now(),
  };
}

const buildInitialTasks = (rows: ProgressRow[]) =>
  new Map(
    rows.flatMap((row) =>
      row.type === "resource" ? [[row.key, toPlanTask(row)]] : [],
    ),
  );

export function PlanProgress(props: PlanProgressProps): JSX.Element {
  const { source, plan } = props;
  const spinner = useGlobalSpinner();
  const rows = useMemo(() => buildProgressRows(plan), [plan]);
  const logicalIdIndex = useMemo(() => buildLogicalIdIndex(rows), [rows]);
  const [tasks, setTasks] = useState<Map<string, PlanTask>>(() =>
    buildInitialTasks(rows),
  );

  const unsubscribeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = source.subscribe((event) => {
      setTasks((prev) => {
        const next = new Map(prev);
        const keys = logicalIdIndex.get(event.id) ?? [];

        if (event.kind === "status-change") {
          if (!event.bindingId) {
            for (const key of keys) {
              const current = next.get(key);
              next.set(key, {
                key,
                id: event.id,
                type: event.type,
                status: event.status,
                message: event.message ?? current?.message,
                updatedAt: Date.now(),
              });
            }
          }
        } else {
          for (const key of keys) {
            const current = next.get(key);
            if (!current) continue;
            next.set(key, {
              ...current,
              message: event.message,
              updatedAt: Date.now(),
            });
          }
        }

        return next;
      });
    });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [logicalIdIndex, source]);

  useEffect(() => {
    setTasks(buildInitialTasks(rows));
  }, [rows]);

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const indent = "  ".repeat(row.depth);

        if (row.type === "namespace") {
          return (
            <Box key={row.key} flexDirection="row">
              <Text>{indent}</Text>
              <Box width={2}>
                <Text color="blueBright">↳ </Text>
              </Box>
              <Text color="blueBright">{row.id}</Text>
            </Box>
          );
        }

        const task = tasks.get(row.key) ?? toPlanTask(row);
        const displayStatus = getDisplayStatus(row, task.status);
        const color = statusColor(displayStatus);
        const icon = statusIcon(task.status, spinner);

        return (
          <Box key={row.key} flexDirection="column">
            <Box flexDirection="row">
              <Text>{indent}</Text>
              <Box width={2}>
                <Text color={color}>{icon} </Text>
              </Box>
              <Text bold>{task.id}</Text>
              <Text dimColor> ({task.type})</Text>
              <Text color={color}> {displayStatus}</Text>
            </Box>
            {task.message ? (
              <Box paddingLeft={row.depth * 2 + 2}>
                <Text dimColor>• {task.message}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function getDisplayStatus(
  row: ResourceProgressRow,
  status: ApplyStatus,
): ApplyStatus | "no change" {
  if (row.action === "noop" && (status === "created" || status === "updated")) {
    return "no change";
  }

  return status;
}

function statusColor(
  status: ApplyStatus | "no change",
): Parameters<typeof Text>[0]["color"] {
  switch (status) {
    case "no change":
      return "gray";
    case "pending":
      return "gray";
    case "creating":
    case "created":
      return "green";
    case "updating":
    case "updated":
      return "yellow";
    case "deleting":
    case "deleted":
      return "red";
    case "fail":
      return "redBright";
    default:
      return undefined;
  }
}

function statusIcon(status: ApplyStatus, spinnerChar: string): string {
  if (isInProgress(status)) return spinnerChar;
  if (status === "fail") return "✗";
  return "✓"; // created/updated/deleted/replaced/etc.
}

function isInProgress(status: ApplyStatus): boolean {
  return (
    status === "pending" ||
    status === "creating" ||
    status === "updating" ||
    status === "deleting"
  );
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useGlobalSpinner(intervalMs = 80): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % spinnerFrames.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return spinnerFrames[index];
}

const findCrudByLogicalId = (
  plan: Plan,
  logicalId: string,
): CRUD | undefined => {
  for (const node of Object.values(plan.resources)) {
    if (node.resource.LogicalId === logicalId) {
      return node;
    }
  }
  for (const node of Object.values(plan.deletions)) {
    if (node?.resource.LogicalId === logicalId) {
      return node;
    }
  }
  return undefined;
};

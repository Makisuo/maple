import * as Event from "../event.js";
import { isFlatten, stateOf as flattenStateOf } from "../internals.js";
import type { Shape } from "../model.js";
import type { DebugSink } from "../registry.js";
import * as Store from "../store.js";

const keyLabel = (key: unknown): string => {
  if (key === undefined) return "";
  if (typeof key === "string") return `(${key})`;
  // Keys are validated flat plain data (see `KeyInput`), so this never throws.
  return `(${JSON.stringify(key)})`;
};

const isDescriptor = (port: unknown): port is { readonly id: string; readonly name?: string } =>
  Store.isStore(port) || Event.isEvent(port);

const namePort = (port: unknown, label: string): void => {
  if (!isDescriptor(port)) return;
  // `name` is readonly on the public descriptor types; construction is the
  // one sanctioned writer, and only for descriptors still unnamed.
  // eslint-disable-next-line revizo/no-type-assertion
  const named = port as { name?: string };
  if (named.name === undefined) named.name = label;
};

/**
 * Names every unnamed port descriptor from the model contract itself: the
 * section and record key ARE the semantic name, and the instance key scopes
 * it — `task-model(42).inputs.rename` without a single manual `{ name }`.
 *
 * The walk cascades into what a port is built from, so internals reachable
 * only through the contract still get addresses: a setter's target store is
 * `...ui.setQuery.target`, a combined store's sources are `...ui.view[0]`,
 * `...ui.view[1]`, a flattened store's outer source is `...outputs.items.source`.
 * Setter targets are named before combined sources — the more semantic label
 * wins. Descriptors already named (manually, or by the child model that
 * created and exposed them first) are left untouched.
 *
 * Every touched descriptor is also reported to the debug sink when one is
 * attached — the inspector's directory for retroactive log naming and
 * derived-store snapshots.
 */
export const namePorts = (
  shape: Shape,
  modelKey: string,
  key: unknown,
  sink?: Pick<DebugSink, "port"> | undefined,
): void => {
  const instance = `${modelKey}${keyLabel(key)}`;
  const visited = new Set<unknown>();

  const cascade = (port: unknown, label: string): void => {
    if (!isDescriptor(port) || visited.has(port)) return;
    visited.add(port);
    namePort(port, label);
    const effective = port.name ?? label;
    sink?.port(port);
    if (Event.isSetter(port)) {
      cascade(Event.targetOf(port), `${effective}.target`);
      return;
    }
    if (Event.isEvent(port) && Event.isCombined(port)) {
      Event.sourcesOf(port).forEach((source, index) => {
        cascade(source, `${effective}[${index}]`);
      });
      return;
    }
    if (isFlatten(port)) {
      cascade(flattenStateOf(port).source, `${effective}.source`);
      return;
    }
    if (Store.isCombined(port)) {
      Store.sourcesOf(port).forEach((source, index) => {
        cascade(source, `${effective}[${index}]`);
      });
    }
  };

  const entries: Array<[unknown, string]> = [];
  for (const [section, ports] of Object.entries(shape)) {
    for (const [portName, port] of Object.entries(ports)) {
      entries.push([port, `${instance}.${section}.${portName}`]);
    }
  }
  // Direct port names land first, then setter targets (the most semantic
  // internal label), then everything reachable through composition.
  for (const [port, label] of entries) namePort(port, label);
  for (const [port, label] of entries) {
    if (Event.isSetter(port)) cascade(port, label);
  }
  for (const [port, label] of entries) cascade(port, label);
};

// Ripgrep utility functions
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import path from "path";
import { exec } from "./exec.ts";

// import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js";

class Stats extends S.Class<Stats>("Stats")({
  elapsed: S.Struct({
    secs: S.Number,
    nanos: S.Number,
    human: S.String,
  }),
  searches: S.Number,
  searches_with_match: S.Number,
  bytes_searched: S.Number,
  bytes_printed: S.Number,
  matched_lines: S.Number,
  matches: S.Number,
}) {}

class Begin extends S.Class<Begin>("Begin")({
  type: S.Literal("begin"),
  data: S.Struct({
    path: S.Struct({
      text: S.String,
    }),
  }),
}) {}

class Match extends S.Class<Match>("Match")({
  type: S.Literal("match"),
  data: S.Struct({
    path: S.Struct({
      text: S.String,
    }),
    lines: S.Struct({
      text: S.String,
    }),
    line_number: S.Number,
    absolute_offset: S.Number,
    submatches: S.Array(
      S.Struct({
        match: S.Struct({
          text: S.String,
        }),
        start: S.Number,
        end: S.Number,
      }),
    ),
  }),
}) {}

class End extends S.Class<End>("End")({
  type: S.Literal("end"),
  data: S.Struct({
    path: S.Struct({
      text: S.String,
    }),
    binary_offset: S.optional(S.Number),
    stats: Stats,
  }),
}) {}

class Summary extends S.Class<Summary>("Summary")({
  type: S.Literal("summary"),
  data: S.Struct({
    elapsed_total: S.Struct({
      human: S.String,
      nanos: S.Number,
      secs: S.Number,
    }),
    stats: Stats,
  }),
}) {}

const Result = S.Union([Begin, Match, End, Summary]);

const parseResult = Schema.decodeEffect(Result);

export type Result = typeof Result.Type;

export const findFiles = Effect.fn("findFiles")(function* (input: {
  cwd: string;
  glob?: string[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(input.cwd).pipe(Effect.catch(() => Effect.void));
  if (!stat) {
    return yield* Effect.fail(`No such file or directory: '${input.cwd}'`);
  }
  if (stat.type !== "Directory") {
    return yield* Effect.fail(`Path is not a directory: '${input.cwd}'`);
  }

  const args = ["--files", "--follow", "--hidden", "--glob=!.git/*"];
  if (input.glob) {
    for (const g of input.glob) {
      args.push(`--glob=${g}`);
    }
  }
  const cmd = ChildProcess.make("rg", args);
  const handle = yield* cmd;
  const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  return output.trim().split(/\r?\n/).filter(Boolean);
});

export const tree = Effect.fn("tree")(function* (input: {
  cwd: string;
  limit?: number;
}) {
  const files = yield* findFiles({ cwd: input.cwd });
  interface Node {
    path: string[];
    children: Node[];
  }

  function getPath(node: Node, parts: string[], create: boolean) {
    if (parts.length === 0) return node;
    let current = node;
    for (const part of parts) {
      let existing = current.children.find((x) => x.path.at(-1) === part);
      if (!existing) {
        if (!create) return;
        existing = {
          path: current.path.concat(part),
          children: [],
        };
        current.children.push(existing);
      }
      current = existing;
    }
    return current;
  }

  const root: Node = {
    path: [],
    children: [],
  };
  for (const file of files) {
    if (file.includes(".opencode")) continue;
    const parts = file.split(path.sep);
    getPath(root, parts, true);
  }

  function sort(node: Node) {
    node.children.sort((a, b) => {
      if (!a.children.length && b.children.length) return 1;
      if (!b.children.length && a.children.length) return -1;
      return a.path.at(-1)!.localeCompare(b.path.at(-1)!);
    });
    for (const child of node.children) {
      sort(child);
    }
  }
  sort(root);

  let current = [root];
  const result: Node = {
    path: [],
    children: [],
  };

  let processed = 0;
  const limit = input.limit ?? 50;
  while (current.length > 0) {
    const next = [];
    for (const node of current) {
      if (node.children.length) next.push(...node.children);
    }
    const max = Math.max(...current.map((x) => x.children.length));
    for (let i = 0; i < max && processed < limit; i++) {
      for (const node of current) {
        const child = node.children[i];
        if (!child) continue;
        getPath(result, child.path, true);
        processed++;
        if (processed >= limit) break;
      }
    }
    if (processed >= limit) {
      for (const node of [...current, ...next]) {
        const compare = getPath(result, node.path, false);
        if (!compare) continue;
        if (compare?.children.length !== node.children.length) {
          const diff = node.children.length - compare.children.length;
          compare.children.push({
            path: compare.path.concat(`[${diff} truncated]`),
            children: [],
          });
        }
      }
      break;
    }
    current = next;
  }

  const lines: string[] = [];

  function render(node: Node, depth: number) {
    const indent = "\t".repeat(depth);
    lines.push(indent + node.path.at(-1) + (node.children.length ? "/" : ""));
    for (const child of node.children) {
      render(child, depth + 1);
    }
  }
  result.children.map((x) => render(x, 0));

  return lines.join("\n");
});

export const search = Effect.fn("search")(function* (input: {
  cwd: string;
  pattern: string;
  glob?: string[];
  limit?: number;
}) {
  const args = ["rg", "--json", "--hidden", "--glob='!.git/*'"];

  if (input.glob) {
    for (const g of input.glob) {
      args.push(`--glob=${g}`);
    }
  }

  if (input.limit) {
    args.push(`--max-count=${input.limit}`);
  }

  args.push("--");
  args.push(input.pattern);

  const result = yield* exec(
    ChildProcess.make(args[0], args.slice(1), { shell: true }),
  ).pipe(
    Effect.catch(() => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })),
  );

  // const result = await $`${{ raw: command }}`.cwd(input.cwd).quiet().nothrow();
  if (result.exitCode !== 0) {
    return [];
  }

  // Handle both Unix (\n) and Windows (\r\n) line endings
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);

  // Parse JSON lines from ripgrep output
  return (yield* Effect.all(lines.map((line) => parseResult(JSON.parse(line)))))
    .filter((r) => r.type === "match")
    .map((r) => r.data);
});

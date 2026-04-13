import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { cwd } from "../../Config.ts";
import { AspectConfig } from "../Aspect.ts";
import { Tool } from "../tool/tool.ts";
import { exec } from "../util/exec.ts";

const MAX_LINE_LENGTH = 2000;

class pattern extends Tool.input(
  "pattern",
)`The regex pattern to search for in file contents.
Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+", etc.)` {}

class path extends Tool.input(
  "path",
  S.optional(S.String),
)`The directory to search in. Defaults to ${cwd} if not specified.` {}

class include extends Tool.input(
  "include",
  S.optional(S.String),
)`File pattern to include in the search (e.g., "*.js", "*.{ts,tsx}")` {}

class matches extends Tool.output(
  "matches",
)`The search results showing file paths and matching lines, sorted by modification time.` {}

export class grep extends Tool(
  "grep",
)`Fast content search tool that works with any codebase size.
Returns ${matches} with file paths and line numbers.

Given a ${pattern} and optional ${path} and ${include}:
- Searches file contents using regular expressions
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+", etc.)
- Filter files by pattern with the include parameter (e.g., "*.js", "*.{ts,tsx}")
- Returns file paths and line numbers with at least one match sorted by modification time
- Use this tool when you need to find files containing specific patterns
- If you need to identify/count the number of matches within files, use the Bash tool with \`rg\` (ripgrep) directly. Do NOT use \`grep\`.
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
`(function* ({ pattern, path: searchDir, include }) {
  yield* Effect.logDebug(`[grep] pattern=${pattern} path=${searchDir}`);

  const config = yield* Effect.serviceOption(AspectConfig).pipe(
    Effect.map(Option.getOrElse(() => ({ cwd: process.cwd() }))),
  );
  const fs = yield* FileSystem.FileSystem;
  const searchPath = searchDir || config.cwd;

  const rgArgs = ["-nH", "--field-match-separator=|", "--regexp", pattern];
  if (include) {
    rgArgs.push("--glob", include);
  }
  rgArgs.push(searchPath);

  const { stdout, stderr, exitCode } = yield* exec(
    ChildProcess.make("rg", rgArgs),
  ).pipe(
    Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
  );

  if (exitCode === 1) {
    return {
      matches: `No matches found for pattern "${pattern}" in ${searchPath}`,
    };
  } else if (exitCode !== 0) {
    return { matches: `ripgrep failed with exit code ${exitCode}: ${stderr}` };
  }

  const lines = stdout.split(/\r?\n/);
  const matchList: {
    path: string;
    modTime: number;
    lineNum: number;
    lineText: string;
  }[] = [];

  for (const line of lines) {
    if (!line) continue;

    const [filePath, lineNumStr, ...lineTextParts] = line.split("|");
    if (!filePath || !lineNumStr || lineTextParts.length === 0) continue;

    const lineNum = parseInt(lineNumStr, 10);
    const lineText = lineTextParts.join("|");

    const stats = yield* fs
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stats) continue;

    const modTime = stats.mtime;
    if (!modTime) continue;
    matchList.push({
      path: filePath,
      modTime: modTime.pipe(Option.getOrElse(() => new Date(0))).getTime(),
      lineNum,
      lineText,
    });
  }

  matchList.sort((a, b) => b.modTime - a.modTime);

  const limit = 100;
  const truncated = matchList.length > limit;
  const finalMatches = truncated ? matchList.slice(0, limit) : matchList;

  if (finalMatches.length === 0) {
    return {
      matches: `No matches found for pattern "${pattern}" in ${searchPath}`,
    };
  }

  const outputLines = [`Found ${finalMatches.length} matches`];

  let currentFile = "";
  for (const match of finalMatches) {
    if (currentFile !== match.path) {
      if (currentFile !== "") {
        outputLines.push("");
      }
      currentFile = match.path;
      outputLines.push(`${match.path}:`);
    }
    const truncatedLineText =
      match.lineText.length > MAX_LINE_LENGTH
        ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..."
        : match.lineText;
    outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`);
  }

  if (truncated) {
    outputLines.push("");
    outputLines.push(
      "(Results are truncated. Consider using a more specific path or pattern.)",
    );
  }

  return { matches: outputLines.join("\n") };
}) {}

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type JSDoc,
  type PropertySignature,
  type SourceFile,
} from "ts-morph";

const websiteRoot = path.join(import.meta.dir, "../alchemy-effect-website");

const config = {
  srcRoot: path.join(import.meta.dir, "../alchemy-effect/src"),
  outRoot: path.join(websiteRoot, "content/reference"),
  contentRoot: path.join(websiteRoot, "content"),
  staticRoot: path.join(websiteRoot, "static"),
  tsConfig: path.join(import.meta.dir, "../alchemy-effect/tsconfig.json"),
  includeDirs: ["AWS", "Cloudflare"],
  excludeFile(baseName: string): boolean {
    if (baseName === "index.ts") return true;
    if (/^[a-z]/.test(baseName)) return true;
    return false;
  },
};

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  outputPath: string;
}

interface PropertyDoc {
  name: string;
  type: string;
  optional: boolean;
  description: string;
  defaultValue: string | undefined;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  examples: ExampleBlock[];
}

interface ReferenceSection {
  heading: string;
  summary?: string;
  properties: PropertyDoc[];
}

interface PageDoc {
  title: string;
  relativePath: string;
  summary: string;
  sections: ExampleSection[];
  reference: ReferenceSection[];
}

interface IndexDoc {
  title: string;
  description: string;
  outputPath: string;
  relativePath: string;
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  for (const dir of config.includeDirs) {
    const dirPath = path.join(config.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      const baseName = path.basename(file);
      if (!baseName.endsWith(".ts") && !baseName.endsWith(".tsx")) continue;
      if (baseName.endsWith(".d.ts")) continue;
      if (config.excludeFile(baseName)) continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(config.srcRoot, relativePath),
        outputPath: path.join(
          config.outRoot,
          relativePath.replace(/\.tsx?$/, ".md"),
        ),
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocBlocks(node: Node): JSDoc[] {
  const getter = (node as Node & { getJsDocs?: () => JSDoc[] }).getJsDocs;
  return getter ? getter.call(node) : [];
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

interface ParsedJSDoc {
  summary: string;
  defaultValue?: string;
  sections: ExampleSection[];
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const docs = getJsDocBlocks(node);
  if (docs.length === 0) {
    return { summary: "", defaultValue: undefined, sections: [] };
  }

  const clean = cleanDocComment(docs.map((doc) => doc.getText()).join("\n"));
  const lines = clean.split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  let defaultValue: string | undefined;
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  for (const line of lines) {
    const tag = line.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "default":
          defaultValue = value || undefined;
          break;
        case "section":
          flushExample();
          currentSection = { title: value || "Examples", examples: [] };
          sections.push(currentSection);
          break;
        case "example":
          flushExample();
          currentExample = { title: value || "Example", body: "" };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    }
  }

  flushExample();

  return {
    summary: summaryLines.join("\n").trim(),
    defaultValue,
    sections,
  };
}

function formatType(value: string | undefined): string {
  if (!value) return "unknown";
  return value
    .replace(/\/\*\*[\s\S]*?\*\//g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function propertyToDoc(prop: PropertySignature): PropertyDoc {
  const jsdoc = parseJSDoc(prop);
  return {
    name: prop.getName(),
    type: formatType(
      prop.getTypeNode()?.getText() ?? prop.getType().getText(prop),
    ),
    optional: prop.hasQuestionToken(),
    description: jsdoc.summary.replace(/\n/g, " "),
    defaultValue: jsdoc.defaultValue,
  };
}

function extractPropertiesFromTypeNode(node: Node): PropertyDoc[] {
  if (Node.isTypeLiteral(node)) {
    return node
      .getMembers()
      .filter((member): member is PropertySignature =>
        Node.isPropertySignature(member),
      )
      .map(propertyToDoc);
  }
  if (Node.isIntersectionTypeNode(node)) {
    return node
      .getTypeNodes()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  if (Node.isUnionTypeNode(node)) {
    return node
      .getTypeNodes()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  if (node.getKind() === SyntaxKind.ParenthesizedType) {
    return node
      .getChildren()
      .flatMap((child) => extractPropertiesFromTypeNode(child));
  }
  return [];
}

function deduplicateProperties(props: PropertyDoc[]): PropertyDoc[] {
  const result: PropertyDoc[] = [];
  const seen = new Set<string>();
  for (const prop of props) {
    if (seen.has(prop.name)) continue;
    if (prop.type === "undefined") continue;
    seen.add(prop.name);
    result.push(prop);
  }
  return result;
}

function findPrimaryJSDoc(sourceFile: SourceFile): ParsedJSDoc {
  for (const decl of sourceFile.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const init = decl.getInitializerIfKind(SyntaxKind.CallExpression);
    const expr = init?.getExpression().getText();
    if (expr === "Resource" || expr === "Host") {
      const stmt = decl.getVariableStatement();
      if (stmt) {
        const jsdoc = parseJSDoc(stmt);
        if (jsdoc.summary || jsdoc.sections.length > 0) return jsdoc;
      }
    }
  }

  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    const text = cls.getText();
    if (
      text.includes("extends Binding.Service<") ||
      text.includes("extends Binding.Policy<")
    ) {
      const jsdoc = parseJSDoc(cls);
      if (jsdoc.summary || jsdoc.sections.length > 0) return jsdoc;
    }
  }

  let firstWithSummary: ParsedJSDoc | undefined;
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isExportable(stmt) && stmt.isExported()) {
      const jsdoc = parseJSDoc(stmt);
      if (jsdoc.sections.length > 0) return jsdoc;
      if (!firstWithSummary && jsdoc.summary) firstWithSummary = jsdoc;
    }
  }

  return firstWithSummary ?? { summary: "", sections: [] };
}

function processInterface(
  iface: import("ts-morph").InterfaceDeclaration,
): ReferenceSection[] {
  const resourceHeritage = iface
    .getHeritageClauses()
    .flatMap((clause) => clause.getTypeNodes())
    .find((typeNode) => {
      const expr = typeNode.getExpression().getText();
      return expr === "Resource" || expr === "Host";
    });

  if (resourceHeritage) {
    const sections: ReferenceSection[] = [];
    const typeArgs = resourceHeritage.getTypeArguments();

    const attrsNode = typeArgs[2];
    if (attrsNode) {
      const props = deduplicateProperties(
        extractPropertiesFromTypeNode(attrsNode),
      );
      if (props.length > 0) {
        sections.push({ heading: "Attributes", properties: props });
      }
    }

    const bindingNode = typeArgs[3];
    if (bindingNode) {
      const props = deduplicateProperties(
        extractPropertiesFromTypeNode(bindingNode),
      );
      if (props.length > 0) {
        sections.push({ heading: "Binding Contract", properties: props });
      }
    }

    return sections;
  }

  const props = iface.getProperties().map(propertyToDoc);
  if (props.length === 0) {
    return [];
  }

  const ifaceJsdoc = parseJSDoc(iface);
  return [
    {
      heading: iface.getName(),
      summary: ifaceJsdoc.summary || undefined,
      properties: props,
    },
  ];
}

function processTypeAlias(
  typeAlias: import("ts-morph").TypeAliasDeclaration,
): ReferenceSection[] {
  const typeNode = typeAlias.getTypeNode();
  if (!typeNode) return [];

  const props = deduplicateProperties(extractPropertiesFromTypeNode(typeNode));
  if (props.length === 0) {
    return [];
  }

  const typeJsdoc = parseJSDoc(typeAlias);
  return [
    {
      heading: typeAlias.getName(),
      summary: typeJsdoc.summary || undefined,
      properties: props,
    },
  ];
}

function extractReferenceSections(sourceFile: SourceFile): ReferenceSection[] {
  const sections: ReferenceSection[] = [];

  for (const stmt of sourceFile.getStatements()) {
    if (Node.isInterfaceDeclaration(stmt) && stmt.isExported()) {
      sections.push(...processInterface(stmt));
    } else if (Node.isTypeAliasDeclaration(stmt) && stmt.isExported()) {
      sections.push(...processTypeAlias(stmt));
    }
  }

  return sections;
}

function parseFile(sourceFile: SourceFile, relativePath: string): PageDoc {
  const baseName = path.basename(relativePath, path.extname(relativePath));
  const dirParts = path
    .dirname(relativePath)
    .split(path.sep)
    .filter((part) => part !== ".");
  const title = [...dirParts, baseName].join(".");

  const primary = findPrimaryJSDoc(sourceFile);
  const reference = extractReferenceSections(sourceFile);

  return {
    title,
    relativePath,
    summary: primary.summary,
    sections: primary.sections,
    reference,
  };
}

function escMd(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function flattenSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderPropertyTable(
  properties: PropertyDoc[],
  includeRequired: boolean,
): string {
  if (includeRequired) {
    const rows = properties.map(
      (prop) =>
        `| \`${escMd(prop.name)}\` | \`${escMd(prop.type)}\` | ${prop.optional ? "No" : "Yes"} | ${escMd(prop.defaultValue ?? "-")} | ${escMd(prop.description || "-")} |`,
    );
    return [
      "| Property | Type | Required | Default | Description |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  }

  const rows = properties.map(
    (prop) =>
      `| \`${escMd(prop.name)}\` | \`${escMd(prop.type)}\` | ${escMd(prop.description || "-")} |`,
  );
  return [
    "| Property | Type | Description |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderPageBody(doc: PageDoc): string {
  const parts: string[] = [];

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    for (const example of section.examples) {
      secParts.push(`### ${example.title}`);
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  for (const section of doc.reference) {
    const secParts: string[] = [`## ${section.heading}`];
    if (section.summary) secParts.push(section.summary);
    secParts.push(
      renderPropertyTable(section.properties, section.heading !== "Attributes"),
    );
    parts.push(secParts.join("\n\n"));
  }

  if (parts.length === 0) {
    parts.push("No API reference content was generated for this source file.");
  }

  return parts.join("\n\n");
}

function renderPage(doc: PageDoc): string {
  const sourcePath = `src/${normalizeSlashes(doc.relativePath)}`;
  const frontmatter = [
    "+++",
    `title = ${tomlString(doc.title)}`,
    `description = ${tomlString(flattenSummary(doc.summary))}`,
    'template = "page.html"',
    "[extra]",
    'kind = "reference"',
    `source = ${tomlString(sourcePath)}`,
    "+++",
  ].join("\n");

  return `${frontmatter}\n\n${renderPageBody(doc).trim()}\n`;
}

function generateIndexes(entries: FileEntry[]): IndexDoc[] {
  const dirs = new Set<string>([config.outRoot]);
  for (const entry of entries) {
    let dir = path.dirname(entry.outputPath);
    while (dir.startsWith(config.outRoot)) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return [...dirs].sort().map((dir) => {
    const relativePath = path.relative(config.outRoot, dir);
    const title =
      relativePath === ""
        ? "API Reference"
        : normalizeSlashes(relativePath).split("/").join(".");
    const description =
      relativePath === ""
        ? "Generated API reference for Alchemy Effect resources, bindings, and platforms."
        : `Generated API reference for ${title}.`;

    return {
      title,
      description,
      relativePath,
      outputPath: path.join(dir, "_index.md"),
    };
  });
}

function renderIndex(doc: IndexDoc): string {
  const frontmatter = [
    "+++",
    `title = ${tomlString(doc.title)}`,
    `description = ${tomlString(doc.description)}`,
    'template = "section.html"',
    'sort_by = "title"',
    'insert_anchor_links = "heading"',
    "[extra]",
    'kind = "reference-section"',
    `section_path = ${tomlString(doc.relativePath === "" ? "reference" : `reference/${normalizeSlashes(doc.relativePath)}`)}`,
    "+++",
  ].join("\n");

  return `${frontmatter}\n`;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("+++")) return content;
  const end = content.indexOf("+++", 3);
  if (end === -1) return content;
  return content.slice(end + 3).replace(/^\n+/, "");
}

/**
 * Maps a content-relative path to the Zola URL-based path under static/.
 * Zola copies static/ verbatim into dist/, so these end up alongside the HTML.
 *
 *   _index.md            → index.md
 *   guides/_index.md     → guides/index.md
 *   guides/foo.md        → guides/foo/index.md
 *   reference/X/Y/Z.md   → reference/X/Y/Z/index.md
 */
function contentPathToStaticPath(relPath: string): string {
  const base = path.basename(relPath);
  const dir = path.dirname(relPath);

  if (base === "_index.md") {
    return path.join(config.staticRoot, dir, "index.md");
  }
  const slug = base.replace(/\.md$/, "");
  return path.join(config.staticRoot, dir, slug, "index.md");
}

async function writeStaticMarkdown(staticPath: string, body: string) {
  await fs.mkdir(path.dirname(staticPath), { recursive: true });
  await fs.writeFile(staticPath, body, "utf8");
}

/**
 * Walks content/ for hand-written .md files (guides, root index, etc.)
 * and writes stripped-frontmatter copies into static/ so Zola serves them
 * alongside the HTML pages.
 */
async function copyContentMarkdownToStatic(): Promise<number> {
  const allFiles = await fs.readdir(config.contentRoot, { recursive: true });
  const mdFiles = (allFiles as string[]).filter(
    (f) => f.endsWith(".md") && !f.startsWith("reference"),
  );
  let count = 0;
  for (const relPath of mdFiles) {
    const raw = await fs.readFile(
      path.join(config.contentRoot, relPath),
      "utf8",
    );
    const body = stripFrontmatter(raw);
    if (!body.trim()) continue;
    await writeStaticMarkdown(contentPathToStaticPath(relPath), body);
    count++;
  }
  return count;
}

async function main() {
  const entries = await discoverFiles();
  console.log(`Discovered ${entries.length} source files.`);

  const project = new Project({
    tsConfigFilePath: config.tsConfig,
    skipFileDependencyResolution: true,
  });

  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  let written = 0;
  for (const entry of entries) {
    const sourceFile = project.getSourceFile(entry.absolutePath);
    if (!sourceFile) {
      console.warn(`  skipped: ${entry.relativePath}`);
      continue;
    }

    const doc = parseFile(sourceFile, entry.relativePath);
    const body = renderPageBody(doc).trim() + "\n";

    // Zola content (with frontmatter) for HTML rendering
    await fs.mkdir(path.dirname(entry.outputPath), { recursive: true });
    await fs.writeFile(entry.outputPath, renderPage(doc), "utf8");

    // Clean markdown in static/ for agent content negotiation
    const staticPath = contentPathToStaticPath(
      path.join("reference", entry.relativePath.replace(/\.ts$/, ".md")),
    );
    await writeStaticMarkdown(staticPath, body);

    written++;
  }

  const indexes = generateIndexes(entries);
  for (const index of indexes) {
    await fs.mkdir(path.dirname(index.outputPath), { recursive: true });
    await fs.writeFile(index.outputPath, renderIndex(index), "utf8");
  }

  // Copy hand-written content (guides, root pages) to static/ as clean markdown
  const contentCount = await copyContentMarkdownToStatic();

  console.log(
    `Done. Wrote ${written} doc files and ${indexes.length} index files to ${normalizeSlashes(path.relative(path.join(import.meta.dir, ".."), config.outRoot))}. Copied ${contentCount} content pages to static/.`,
  );
}

await main();

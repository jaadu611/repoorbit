import { mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

const IMPORT_DEPTH = 999; 
const FILE_CHAR_LIMIT = 100_000;
const SPLIT_THRESHOLD_CHARS = 3_000;
const MIN_RELEVANCE_SCORE_GENERIC = 3;
const MIN_RELEVANCE_SCORE_TARGETED = 15;

const MAX_OUTPUT_FILES = 50; 
const MAX_SOURCE_BUCKETS = MAX_OUTPUT_FILES - 1; 
const WORD_LIMIT_PER_FILE = 450_000;

const TOTAL_WORD_BUDGET = MAX_SOURCE_BUCKETS * WORD_LIMIT_PER_FILE; 

const TIER1_EXTENSIONS = new Set(["md", "mdx", "json", "yaml", "yml", "toml"]);
const TIER2_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "cs",
  "cpp",
  "c",
  "h",
  "svelte",
  "vue",
  "sh",
  "bash",
  "zsh",
  "sql",
]);
const TIER3_EXTENSIONS = new Set(["html", "yaml", "yml", "toml"]);
const TIER4_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);

const ROOT_CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "jsconfig.json",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "makefile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "rollup.config.js",
  "webpack.config.js",
  "babel.config.js",
  "babel.config.json",
  "jest.config.ts",
  "jest.config.js",
  "vitest.config.ts",
  "tailwind.config.ts",
  "tailwind.config.js",
  "turbo.json",
  ".env.example",
  ".env.sample",
]);

const SOURCE_EXTENSIONS = new Set([
  ...TIER2_EXTENSIONS,
  ...TIER4_EXTENSIONS,
  "html",
  "json",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
]);

const EXCLUDE_PATTERNS: RegExp[] = [
  /node_modules/,
  /\.git\//,
  /dist\//,
  /\.next\//,
  /\.nuxt\//,
  /build\//,
  /coverage\//,
  /\.turbo\//,
  /\.cache\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.d\.(ts|mts|cts)$/,
];

const STOP_WORDS = new Set([
  "what",
  "does",
  "this",
  "that",
  "the",
  "how",
  "many",
  "times",
  "which",
  "file",
  "files",
  "where",
  "find",
  "show",
  "list",
  "have",
  "been",
  "there",
  "into",
  "from",
  "with",
  "about",
  "used",
  "called",
  "imported",
  "exported",
  "defined",
  "function",
  "method",
  "class",
  "module",
  "every",
  "each",
  "all",
  "any",
  "some",
  "repo",
  "code",
  "project",
  "codebase",
  "library",
  "package",
  "tell",
  "give",
  "return",
  "returns",
  "takes",
  "accepts",
  "throws",
  "emits",
  "renders",
  "works",
]);

type ImportRole = "Entry Point" | `Depth ${number}` | "Utility";
type QueryIntent =
  | "contributors"
  | "commits"
  | "branches"
  | "issues"
  | "pulls"
  | "repo_meta"
  | "tree"
  | "code"
  | "test";
type CodeFocus = "targeted" | "generic";

interface FunctionBlock {
  name: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface ScoredFile {
  file: any;
  score: number;
}

interface Block {
  group: string;
  text: string;
}

export interface ExpertPlan {
  files?: string[];
  intents?: QueryIntent[];
  focus?: CodeFocus;
}

export function detectIntent(query: string): QueryIntent[] {
  const intents = new Set<QueryIntent>();
  const q = query.toLowerCase();

  if (/commit|contributed|push(ed)?/i.test(q)) intents.add("commits");
  if (/contribut(or|er|ion)|who (made|wrote|built|coded)|most active/i.test(q))
    intents.add("contributors");
  if (/branch(es)?|protected branch|default branch/i.test(q))
    intents.add("branches");
  if (/\bissue\b|bug report|ticket|open problem/i.test(q))
    intents.add("issues");
  if (/pull request|\bpr\b|merged?|code review/i.test(q)) intents.add("pulls");

  if (
    /\bstar|fork|licen[sc]e|topic|language|tech stack|docker|tailwind|\bci\b|readme/i.test(
      q,
    ) ||
    /\b(about|overview|purpose|summary|describe|description)\b/i.test(q) ||
    /what (is|are|does) (this|the) (repo|project|codebase|library|package|app)/i.test(
      q,
    ) ||
    /tell me about (this|the) (repo|project|codebase)/i.test(q) ||
    /^(what|describe|summarize|explain)\b.{0,60}$/i.test(q) ||
    /what does (this|the) repo (use|have|include|contain)/i.test(q) ||
    /does (this|the) (repo|project).{0,40}(use|have|include|support)/i.test(
      q,
    ) ||
    /is there (a|an).{0,40}(config|setup|file|docker|ci|test)/i.test(q) ||
    /what.{0,20}(framework|library|tool|stack|bundler|linter)/i.test(q)
  )
    intents.add("repo_meta");

  if (
    /^(list|show|what('s| is| are)?).{0,40}(file|folder|director|structure|tree|root)/i.test(
      q,
    ) ||
    /contents? of\s+[\w/.]+/i.test(q)
  )
    intents.add("tree");

  if (
    /\btest(s|ing|ed)?\b|\bspec\b|\bsuite\b|\bit\(|describe\(|jest|vitest|mocha|cypress/i.test(
      q,
    ) ||
    /show.{0,30}test|find.{0,30}test|where.{0,30}test/i.test(q)
  )
    intents.add("test");

  if (
    /what (changed|was (changed|updated|modified|added|removed))/i.test(q) ||
    /latest (change|update|commit|diff)/i.test(q) ||
    /recent (change|update|commit)/i.test(q)
  )
    intents.add("commits");

  const hasNonCodeIntent =
    intents.has("repo_meta") ||
    intents.has("contributors") ||
    intents.has("commits") ||
    intents.has("branches") ||
    intents.has("issues") ||
    intents.has("pulls") ||
    intents.has("tree");

  const hasCodeKeyword =
    /how (does|do|is|are|works?)|implement|function|method|class|module|export|import|call(ed)?|logic|algorithm|where is|defined?|which files?|involved|used by|source/i.test(
      q,
    );
  const hasCamelSymbol = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(query);
  const hasSnakeSymbol = /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query);
  const hasQuotedSymbol = /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);

  if (intents.has("test")) intents.add("code");

  if (
    !hasNonCodeIntent ||
    hasCodeKeyword ||
    hasCamelSymbol ||
    hasSnakeSymbol ||
    hasQuotedSymbol ||
    hasFilePath
  ) {
    intents.add("code");
  }

  return [...intents];
}

export function detectCodeFocus(query: string): CodeFocus {
  const q = query.toLowerCase();
  const isBroadQuestion =
    /how does .{0,40} (work|fit|connect|relate|interact)/i.test(q) ||
    /explain (the |how |what ).{0,60}/i.test(q) ||
    /walk me through/i.test(q) ||
    /architecture|overview|structure|system|pipeline|flow/i.test(q);
  if (isBroadQuestion) return "generic";

  const hasSymbol =
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(query) ||
    /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query) ||
    /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);
  const hasFocusedVerb =
    /what does .{0,60} (do|return|take|accept|throw|emit|render)/i.test(q) ||
    /how (does|is) .{0,60} (work|called|used|imported|exported|defined)/i.test(
      q,
    ) ||
    /where is .{0,60} (defined|used|called|imported|exported)/i.test(q) ||
    /how many times.{0,60}(import|call|use|invoke)/i.test(q) ||
    /which files?.{0,40}(import|use|call|depend)/i.test(q) ||
    /find (all|every|the).{0,40}(usage|import|call|reference|occurrence)/i.test(
      q,
    ) ||
    /show (me )?(all |every )?(usage|import|call|where)/i.test(q);

  return hasSymbol || hasFilePath || hasFocusedVerb ? "targeted" : "generic";
}

export function extractQueryTokens(query: string): string[] {
  const tokens = new Set<string>();

  const quoted = query.match(/['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/g) ?? [];
  for (const q of quoted) tokens.add(q.replace(/['"`]/g, ""));

  const paths = query.match(/\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/g) ?? [];
  for (const p of paths) tokens.add(p);

  const dotChains = query.match(/\b[a-zA-Z_$][a-zA-Z0-9_$.]{3,}\b/g) ?? [];
  for (const chain of dotChains) {
    if (chain.includes(".")) {
      tokens.add(chain);
      for (const part of chain.split(".")) {
        if (part.length > 2) tokens.add(part);
      }
    }
  }

  const camel = query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [];
  for (const c of camel) tokens.add(c);

  const snake = query.match(/\b[a-z][a-z0-9]*(_[a-z0-9]+){1,}\b/g) ?? [];
  for (const s of snake) tokens.add(s);

  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  for (const w of words) tokens.add(w);

  return [...tokens];
}

export function scoreFile(
  file: any,
  tokens: string[],
  importGraph: Record<string, string[]>,
  isImportQuery: boolean,
  isTestQuery: boolean,
): number {
  if (!tokens.length) return 0;

  let score = 0;
  const filePath = (file.path as string).toLowerCase();
  const exports: string[] = file.analysis?.exports ?? [];
  const imports: string[] = file.imports ?? [];
  const isTestFile =
    /\.(test|spec)\.[a-z]+$/.test(file.path) ||
    /__tests__/.test(file.path) ||
    /\/tests?\//.test(file.path);

  if (isTestFile && !isTestQuery) score -= 15;
  if (!isTestFile && isTestQuery) score -= 5;

  const fullContent = (file.content ?? "").toLowerCase();

  for (const token of tokens) {
    const t = token.toLowerCase();
    const pathBase =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    if (pathBase === t) score += 30;
    else if (filePath.includes(t)) score += 5;

    if (exports.some((e) => e.toLowerCase() === t)) score += 20;
    else if (exports.some((e) => e.toLowerCase().includes(t))) score += 8;

    if (imports.some((i) => i.toLowerCase().includes(t))) score += 3;

    const occurrences = (
      fullContent.match(new RegExp(`\\b${escapeRegex(t)}\\b`, "g")) ?? []
    ).length;
    score += Math.min(occurrences * 2, 30);

    if (token.includes("/") && filePath.includes(token.toLowerCase()))
      score += 50;
  }

  if (isImportQuery) {
    const importerCount = Object.values(importGraph).filter((deps) =>
      deps.some((d) => d.includes(file.path) || file.path.includes(d)),
    ).length;
    score += importerCount * 4;
  }

  if ((file.metrics?.codeLines ?? 0) < 5) score = Math.floor(score * 0.4);

  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function selectFilesForQuery(
  sourceFiles: any[],
  query: string,
  focus: CodeFocus,
  importGraph: Record<string, string[]>,
  depthMap: Map<string, number>,
  intents: QueryIntent[],
): { files: any[]; omittedCount: number; omittedPaths: string[] } {
  if (focus === "generic" && !intents.includes("code")) {
    return { files: [], omittedCount: sourceFiles.length, omittedPaths: [] };
  }

  const tokens = extractQueryTokens(query);
  if (tokens.length === 0 && focus === "targeted") focus = "generic";

  const isImportQuery =
    /how many times|import(ed)?|usage|reference|occurrence|depend/i.test(query);
  const isTestQuery = intents.includes("test");

  const scored: ScoredFile[] = sourceFiles.map((file) => ({
    file,
    score: scoreFile(file, tokens, importGraph, isImportQuery, isTestQuery),
  }));

  scored.sort((a, b) => b.score - a.score);

  const threshold =
    focus === "targeted"
      ? MIN_RELEVANCE_SCORE_TARGETED
      : MIN_RELEVANCE_SCORE_GENERIC;
  const relevant = scored.filter((s) => s.score >= threshold);
  const selected = relevant.map((s) => s.file);
  const omitted = scored
    .filter((s) => !selected.includes(s.file))
    .map((s) => s.file);

  return {
    files: selected,
    omittedCount: omitted.length,
    omittedPaths: omitted.slice(0, 20).map((f) => f.path),
  };
}

function resolveImportDepths(
  seedPaths: string[],
  importGraph: Record<string, string[]>,
  maxDepth: number,
): Map<string, number> {
  const depths = new Map<string, number>();
  for (const seed of seedPaths) depths.set(seed, 0);
  let frontier = [...seedPaths];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const dep of importGraph[p] ?? []) {
        if (!depths.has(dep)) {
          depths.set(dep, depth);
          next.push(dep);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return depths;
}

function importRoleLabel(depth: number | undefined): ImportRole {
  if (depth === undefined) return "Utility";
  if (depth === 0) return "Entry Point";
  return `Depth ${depth}`;
}

function fileTier(filePath: string): number {
  if (EXCLUDE_PATTERNS.some((re) => re.test(filePath))) return 0;

  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1].toLowerCase();
  const ext = fileName.split(".").pop() ?? "";

  if (!SOURCE_EXTENSIONS.has(ext)) return 0;

  const isRoot = parts.length === 1;
  const isShallowDoc = parts.length <= 2 && (ext === "md" || ext === "mdx");
  const isKeyConfig = isRoot && ROOT_CONFIG_NAMES.has(fileName);
  const isGitHubWorkflow = /^\.github\/workflows\//.test(filePath);
  if (isRoot || isShallowDoc || isKeyConfig || isGitHubWorkflow) return 1;

  if (TIER2_EXTENSIONS.has(ext)) return 2;

  if (
    ext === "md" ||
    ext === "mdx" ||
    ext === "html" ||
    ext === "yaml" ||
    ext === "yml" ||
    ext === "toml" ||
    ext === "json"
  )
    return 3;

  if (TIER4_EXTENSIONS.has(ext)) return 4;

  return 0;
}

function shouldInclude(filePath: string): boolean {
  return fileTier(filePath) > 0;
}

function selectFilesByBudget(
  candidates: any[],
  estimateWords: (f: any) => number,
): { files: any[]; droppedTiers: number[] } {
  const withTier = candidates
    .map((f) => ({ file: f, tier: fileTier(f.path) }))
    .filter((x) => x.tier > 0);

  const mustInclude = withTier.filter((x) => x.tier <= 2).map((x) => x.file);
  const tier3 = withTier.filter((x) => x.tier === 3).map((x) => x.file);
  const tier4 = withTier.filter((x) => x.tier === 4).map((x) => x.file);

  const wordsOf = (files: any[]) =>
    files.reduce((s, f) => s + estimateWords(f), 0);

  const droppedTiers: number[] = [];

  let selected = [...mustInclude, ...tier3, ...tier4];
  if (wordsOf(selected) > TOTAL_WORD_BUDGET) {

    selected = [...mustInclude, ...tier3];
    droppedTiers.push(4);
  }
  if (wordsOf(selected) > TOTAL_WORD_BUDGET) {

    selected = [...mustInclude];
    droppedTiers.push(3);
  }

  return { files: selected, droppedTiers };
}

function isDocFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "md" && ext !== "mdx") return false;
  return !/node_modules|CHANGELOG|CHANGES|HISTORY|\.github\/|dist\//.test(
    filePath,
  );
}

function safeFileExt(file: any): string {
  const raw: unknown = file.ext;
  if (typeof raw !== "string" || raw.includes(".")) {
    return (file.path as string).split(".").pop()?.toLowerCase() ?? "";
  }
  return raw.toLowerCase();
}

function safeContent(file: any): string {
  const c = file.content;
  if (c === null || c === undefined) return "";
  return String(c);
}

export function getDirectoryStructure(
  filesMetadata: any[],
  maxLines = 400,
): string {
  const included = filesMetadata.filter((f) => shouldInclude(f.path));

  type TreeNode = { files: string[]; children: Map<string, TreeNode> };
  const root: TreeNode = { files: [], children: new Map() };

  for (const file of included) {
    const parts = (file.path as string).split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg))
        node.children.set(seg, { files: [], children: new Map() });
      node = node.children.get(seg)!;
    }
    node.files.push(parts[parts.length - 1]);
  }

  const lines: string[] = [];
  let lineCount = 0;
  let truncated = false;

  function countFiles(node: TreeNode): number {
    return (
      node.files.length +
      [...node.children.values()].reduce((s, c) => s + countFiles(c), 0)
    );
  }

  function render(node: TreeNode, indent: number) {
    if (lineCount >= maxLines) {
      truncated = true;
      return;
    }
    for (const f of node.files.sort()) {
      if (lineCount >= maxLines) {
        truncated = true;
        return;
      }
      lines.push(`${" ".repeat(indent)}${f}`);
      lineCount++;
    }
    for (const [seg, child] of [...node.children.entries()].sort()) {
      if (lineCount >= maxLines) {
        truncated = true;
        return;
      }
      const count = countFiles(child);
      lines.push(
        `${" ".repeat(indent)}${seg}/  (${count} file${count !== 1 ? "s" : ""})`,
      );
      lineCount++;
      render(child, indent + 2);
    }
  }

  render(root, 0);
  if (truncated)
    lines.push(`\n[TRUNCATED: Directory listing exceeds ${maxLines} lines.]`);
  return lines.join("\n");
}

function docSortKey(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower === "readme.md" || lower === "readme.mdx") return "0-root-readme";
  if (!filePath.includes("/")) return `1-root-${lower}`;
  if (/^(docs?|wiki|documentation)\//.test(lower))
    return `2-docsfolder-${lower}`;
  return `3-other-${lower}`;
}

export function getReadme(docFiles: any[], maxFiles = 5): string {
  if (!docFiles.length) return "";
  const sorted = [...docFiles].sort((a, b) =>
    docSortKey(a.path).localeCompare(docSortKey(b.path)),
  );
  const limited = sorted.slice(0, maxFiles);
  const omitted = sorted.length - limited.length;

  const parts: string[] = [
    `## Project Documentation\n\nIncluding ${limited.length} documentation file${limited.length !== 1 ? "s" : ""}.${omitted > 0 ? ` Omitted ${omitted} secondary doc files.` : ""}`,
  ];

  for (const doc of limited) {
    let content = safeContent(doc);
    if (content.length > FILE_CHAR_LIMIT) {
      const cut = content.lastIndexOf("\n", FILE_CHAR_LIMIT);
      content =
        content.slice(0, cut > 0 ? cut : FILE_CHAR_LIMIT) + `\n\n[TRUNCATED]`;
    }
    parts.push(`### ${doc.path}\n\n${content}`);
  }
  return parts.join("\n\n");
}

function parseFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];
  const startRe =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|class\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|var\s+(\w+)\s*=)/;
  const decoratorRe = /^@\w+/;

  let i = 0;
  while (i < lines.length) {
    let decoratorStart: number | null = null;
    while (i < lines.length && decoratorRe.test(lines[i].trim())) {
      if (decoratorStart === null) decoratorStart = i;
      i++;
    }

    const m = startRe.exec(lines[i]?.trim() ?? "");
    if (!m) {
      i++;
      continue;
    }

    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "anonymous";
    const blockStart = decoratorStart ?? i;
    let depth = 0;
    let hasOpenedBrace = false;
    let inString: string | null = null;
    let inTemplateBraceDepth = 0;
    let j = i;

    outer: while (j < lines.length) {
      const line = lines[j];
      let k = 0;
      while (k < line.length) {
        const ch = line[k];
        if (inString === "`") {
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === "$" && line[k + 1] === "{") {
            inTemplateBraceDepth++;
            k += 2;
            continue;
          }
          if (ch === "{" && inTemplateBraceDepth > 0) {
            depth++;
            k++;
            continue;
          }
          if (ch === "}" && inTemplateBraceDepth > 0) {
            if (depth > 0) depth--;
            else inTemplateBraceDepth--;
            k++;
            continue;
          }
          if (ch === "`") {
            inString = null;
            k++;
            continue;
          }
        } else if (inString) {
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === inString) inString = null;
        } else {
          if (ch === '"' || ch === "'") {
            inString = ch;
          } else if (ch === "`") {
            inString = "`";
          } else if (ch === "{") {
            depth++;
            hasOpenedBrace = true;
          } else if (ch === "}") {
            depth--;
            if (hasOpenedBrace && depth <= 0) {
              j++;
              break outer;
            }
          } else if (
            !hasOpenedBrace &&
            ch === "=" &&
            line[k + 1] === ">" &&
            j > i
          ) {
            j++;
            break outer;
          }
        }
        k++;
      }
      j++;
      if (!hasOpenedBrace && j > i + 3) break;
    }

    const endLine = j - 1;
    if (endLine > blockStart) {
      blocks.push({
        name,
        startLine: blockStart,
        endLine,
        text: lines.slice(blockStart, endLine + 1).join("\n"),
      });
    }
    i = j;
  }
  return blocks;
}

export function getRepoMeta(repoContext: any): string {
  const stack = repoContext?.stack ?? {};
  const meta = repoContext?.meta ?? {};
  const github = repoContext?.github ?? {};
  const stats = repoContext?.stats ?? {};
  const languages = repoContext?.languages ?? [];

  const topLangs =
    languages
      .slice(0, 5)
      .map((l: any) => `${l.lang} (${l.pct}%)`)
      .join(", ") || "unknown";
  const stackItems =
    [
      stack.hasTailwind ? "Tailwind CSS" : null,
      stack.hasDocker ? "Docker" : null,
      stack.hasTests ? "automated tests" : null,
      stack.hasGitActions ? "GitHub Actions CI" : null,
    ]
      .filter(Boolean)
      .join(", ") || "no detected tooling";

  return `## Repository Overview

${meta.fullName ?? "Unknown repo"} is a ${stack.architecture ?? "unknown"} project. ${github.description ?? ""}

It has ${meta.stars ?? 0} stars, ${meta.forks ?? 0} forks, and ${meta.openIssues ?? 0} open issues. The license is ${meta.license ?? "unknown"}. The default branch is ${meta.defaultBranch ?? "unknown"}, last pushed on ${meta.pushedAt ?? "unknown"}.

Topics: ${github.topics?.join(", ") || "none listed"}. Primary languages: ${topLangs}. The stack includes: ${stackItems}.

The repository contains ${stats.totalFiles ?? "?"} files across ${stats.totalFolders ?? "?"} folders with a maximum directory depth of ${stats.maxDepth ?? "?"}.`;
}

export function getContributorsNames(repoContext: any): string {
  const contributors = repoContext?.contributors ?? [];
  if (!contributors.length) return "";
  const sorted = [...contributors].sort(
    (a: any, b: any) => b.contributions - a.contributions,
  );
  const list = sorted
    .map(
      (c: any, i: number) =>
        `${i + 1}. ${c.login} with ${c.contributions} commits`,
    )
    .join("\n");
  return `## Contributors\n\nTop contributor: ${sorted[0].login} with ${sorted[0].contributions} commits.\n\n${list}`;
}

export function getCommitHistory(repoContext: any): string {
  const commitsByAuthor: Record<string, any[]> =
    repoContext?.commitsByAuthor ?? {};
  if (!Object.keys(commitsByAuthor).length) {
    if (!repoContext?.recentCommits?.length) return "";
    const lines = repoContext.recentCommits.map(
      (c: any) =>
        `- ${c.message.split("\n")[0]} by ${c.author} on ${c.date} [${c.shortSha}]`,
    );
    return `## Recent Commits\n\n${lines.join("\n")}`;
  }
  const parts: string[] = ["## Commit History"];
  for (const [author, commits] of Object.entries(commitsByAuthor).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const shown = (commits as any[]).slice(0, 20);
    const hidden = commits.length - shown.length;
    parts.push(
      `\n### Commits by ${author} (${commits.length} total${hidden > 0 ? `, ${hidden} older omitted` : ""})\n\n` +
        shown
          .map(
            (c: any) =>
              `- ${c.message?.split("\n")[0] ?? ""} on ${c.date} [${c.shortSha}]`,
          )
          .join("\n"),
    );
  }
  return parts.join("\n");
}

export function getBranches(repoContext: any): string {
  const branches = repoContext?.branches ?? [];
  if (!branches.length) return "";
  return `## Branches\n\n${branches.map((b: any) => `- ${b.name}${b.protected ? " (protected)" : ""}`).join("\n")}`;
}

export function getIssues(repoContext: any): string {
  const issues = repoContext?.issues ?? [];
  if (!issues.length) return "";
  const open = issues.filter((i: any) => i.state === "open").length;
  const closed = issues.filter((i: any) => i.state === "closed").length;
  const lines: string[] = [`## Issues (${open} open, ${closed} closed)\n`];
  for (const i of issues) {
    const labels = i.labels?.length ? ` Labels: ${i.labels.join(", ")}.` : "";
    lines.push(`### Issue #${i.number}: ${i.title} (${i.state})\n`);
    lines.push(
      `Opened by ${i.author ?? "unknown"} on ${i.createdAt}. ${i.comments} comment(s).${labels}`,
    );
    if (i.body)
      lines.push(
        `\n${i.body.slice(0, 400)}${i.body.length > 400 ? "..." : ""}`,
      );
  }
  return lines.join("\n");
}

export function getPulls(repoContext: any): string {
  const pulls = repoContext?.pulls ?? [];
  if (!pulls.length) return "";
  const open = pulls.filter((p: any) => p.state === "open").length;
  const merged = pulls.filter((p: any) => p.merged).length;
  const lines: string[] = [
    `## Pull Requests (${open} open, ${merged} merged)\n`,
  ];
  for (const p of pulls) {
    lines.push(
      `### PR #${p.number}: ${p.title} (${p.merged ? "merged" : p.state})\n`,
    );
    lines.push(
      `Author: ${p.author ?? "unknown"}. Branch: ${p.headBranch} into ${p.baseBranch}. Opened: ${p.createdAt}.${p.mergedAt ? ` Merged: ${p.mergedAt}.` : ""}`,
    );
    if (p.body)
      lines.push(
        `\n${p.body.slice(0, 400)}${p.body.length > 400 ? "..." : ""}`,
      );
  }
  return lines.join("\n");
}

export function getFileContext(
  file: any,
  role: ImportRole,
  repoName: string,
): string {
  const ext = safeFileExt(file);
  const exports = (file.analysis?.exports ?? []) as string[];
  const imports = (file.imports ?? []) as string[];
  const todos = (file.analysis?.todoComments ?? []) as string[];
  const lineCount = file.metrics?.lineCount ?? "?";
  const codeLines = file.metrics?.codeLines ?? "?";
  const logicType = file.analysis?.logicType ?? "unknown";
  const flags = [
    file.analysis?.isReact ? "React component" : "",
    file.analysis?.isTest ? "test file" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const exportsStr = exports.length
    ? `It exports: ${exports.join(", ")}.`
    : "It has no named exports.";
  const importsStr = imports.length
    ? `It imports from: ${imports.slice(0, 12).join(", ")}${imports.length > 12 ? ` and ${imports.length - 12} more` : ""}.`
    : "It has no imports.";
  const todosStr = todos.length ? ` TODOs: ${todos.join(" | ")}.` : "";
  const flagsStr = flags ? ` (${flags})` : "";

  const prose =
    `This file is a **${role}** in the ${repoName} import graph${flagsStr}. ` +
    `Logic type: ${logicType}. ${lineCount} lines (${codeLines} code lines). ` +
    `${exportsStr} ${importsStr}${todosStr}`;

  let content = safeContent(file);
  if (content.length > FILE_CHAR_LIMIT) {
    const cut = content.lastIndexOf("\n", FILE_CHAR_LIMIT);
    content =
      content.slice(0, cut > 0 ? cut : FILE_CHAR_LIMIT) +
      `\n\n[TRUNCATED: file exceeds ${FILE_CHAR_LIMIT.toLocaleString()} characters.]`;
  }

  const heading = `### ${file.path} (${role})`;
  const isNonCodeFile = [
    "css",
    "scss",
    "sass",
    "less",
    "json",
    "yaml",
    "yml",
    "toml",
    "md",
    "mdx",
  ].includes(ext);

  if (content.length <= SPLIT_THRESHOLD_CHARS || isNonCodeFile) {
    return [heading, "", prose, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  const blocks = parseFunctionBlocks(content);
  if (!blocks.length) {
    return [heading, "", prose, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  const fileLines = content.split("\n");
  const headerText = fileLines.slice(0, blocks[0].startLine).join("\n").trim();
  const parts: string[] = [heading, "", prose];

  if (headerText) {
    parts.push(
      "",
      `#### ${file.path} — module header`,
      "",
      `\`\`\`${ext}`,
      headerText,
      "```",
    );
  }

  for (const block of blocks) {
    parts.push(
      "",
      `#### ${file.path} — ${block.name}`,
      "",
      `Function or class \`${block.name}\` defined in \`${file.path}\` (${role}, ${repoName}).`,
      "",
      `\`\`\`${ext}`,
      block.text,
      "```",
    );
  }

  return parts.join("\n");
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function packAndFlush(
  blocks: Block[],
  outDir: string,
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });

  const allText = blocks.map((b) => b.text);

  const totalWords = allText.reduce((s, t) => s + countWords(t), 0);

  const targetWordsPerBucket = Math.min(
    Math.ceil(totalWords / MAX_SOURCE_BUCKETS),
    WORD_LIMIT_PER_FILE,
  );

  const buckets: string[][] = [[]]; 
  const bucketWords: number[] = [0];

  for (const text of allText) {
    const wc = countWords(text);
    const curr = buckets.length - 1;

    if (
      buckets.length < MAX_SOURCE_BUCKETS &&
      bucketWords[curr] + wc > targetWordsPerBucket
    ) {

      buckets.push([text]);
      bucketWords.push(wc);
    } else {

      if (
        buckets.length === MAX_SOURCE_BUCKETS &&
        bucketWords[curr] === 0 &&
        curr === 0
      ) {

      }
      buckets[curr].push(text);
      bucketWords[curr] += wc;
    }
  }

  const written: string[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const paddedNum = String(i + 1).padStart(2, "0");
    const fileName = `part_${paddedNum}.txt`;
    const fullPath = join(outDir, fileName);
    const content = buckets[i].join("\n\n");
    await writeFile(fullPath, content, "utf-8");
    written.push(fullPath);
  }

  return written;
}

function buildManifest(
  fileCount: number,
  repoName: string,
  repoContext: any,
  droppedTiers: number[],
  totalSourceFiles: number,
): string {
  const timestamp = new Date().toISOString();
  return [
    `00_Repo_Manifest.txt — ${repoName}`,
    `Generated: ${timestamp}`,
    `Repository: ${repoContext?.meta?.fullName ?? repoName}`,
    `Description: ${repoContext?.github?.description ?? "N/A"}`,
    "",
    `Mode: ${droppedTiers.length > 0 ? "BUDGET-CONSTRAINED (dropped tiers: " + droppedTiers.join(",") + ")" : "FULL (all source files)"}`,
    `Total files considered: ${totalSourceFiles}`,
    `Output files produced: ${fileCount} source buckets + this manifest = ${fileCount + 1} total`,
    "",
    `Each part_NN.txt contains source code organized alphabetically by directory.`,
    `Upload all files (including this manifest) to NotebookLM as sources.`,
    "",
    "END OF MANIFEST",
  ].join("\n");
}

export async function buildMasterContext(
  query: string,
  filesMetadata: any[],
  importGraph: Record<string, string[]>,
  repoContext: any,
  expertPlan?: ExpertPlan,
  outputDir = "/tmp/notebooklm_sources",
  dumpAll = true,
): Promise<string> {
  const repoName = repoContext?.meta?.fullName?.split("/").pop() ?? "repo";
  const safeQuery = query ? String(query) : "";

  const intents = dumpAll
    ? ([
        "code",
        "repo_meta",
        "contributors",
        "commits",
        "branches",
        "issues",
        "pulls",
        "tree",
      ] as QueryIntent[])
    : (expertPlan?.intents ?? detectIntent(safeQuery));

  const needsCode =
    dumpAll ||
    intents.includes("code") ||
    intents.includes("test") ||
    (expertPlan?.files && expertPlan.files.length > 0);

  const focus = dumpAll
    ? "generic"
    : (expertPlan?.focus ??
      (needsCode ? detectCodeFocus(safeQuery) : "generic"));

  const allCandidates = filesMetadata.filter(
    (f) => f && typeof f.path === "string" && shouldInclude(f.path),
  );

  const estimateWords = (f: any) =>
    Math.ceil((f.metrics?.charCount ?? f.content?.length ?? 0) / 5);

  const { files: allIncluded, droppedTiers } = selectFilesByBudget(
    allCandidates,
    estimateWords,
  );

  if (droppedTiers.length > 0) {
    const tierNames: Record<number, string> = {
      3: "nested docs/yaml/json",
      4: "CSS/SCSS/LESS",
    };
  }

  const docFiles = allIncluded.filter((f) => isDocFile(f.path));
  const sourceFiles = allIncluded.filter((f) => !isDocFile(f.path));

  const blocks: Block[] = [];

  const push = (group: string, text: string) => {
    if (text.trim()) blocks.push({ group, text });
  };

  const metaLines: string[] = [];
  metaLines.push(
    `# ${repoContext?.meta?.fullName ?? "Unknown"} — Codebase Context`,
  );
  metaLines.push(
    `Generated: ${new Date().toISOString()}. Mode: ${droppedTiers.length > 0 ? "budget-constrained" : "full"}.`,
  );

  if (dumpAll || focus === "generic" || intents.includes("repo_meta")) {
    metaLines.push(getRepoMeta(repoContext));
  }

  if (dumpAll || intents.includes("repo_meta") || focus === "generic") {
    const docsSection = getReadme(docFiles, dumpAll ? 5 : 3);
    if (docsSection) metaLines.push(docsSection);
  }

  if (intents.includes("contributors")) {
    const s = getContributorsNames(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("commits")) {
    const s = getCommitHistory(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("branches")) {
    const s = getBranches(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("issues")) {
    const s = getIssues(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("pulls")) {
    const s = getPulls(repoContext);
    if (s) metaLines.push(s);
  }

  if (
    dumpAll ||
    intents.includes("tree") ||
    (intents.includes("repo_meta") && focus === "generic")
  ) {
    const extFreq = repoContext?.stats?.extFrequency ?? {};
    const extSummary = Object.entries(extFreq)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `.${ext}: ${count} files`)
      .join(", ");

    metaLines.push(
      `## Directory Structure\n\n${sourceFiles.length} source files${droppedTiers.length > 0 ? " (filtered by budget)" : ""}. Types: ${extSummary}.\n\n` +
        getDirectoryStructure(filesMetadata, dumpAll ? 10000 : 200),
    );
  }

  push("_meta", metaLines.join("\n\n"));

  if (needsCode) {
    const allGraphPaths = new Set([
      ...Object.keys(importGraph),
      ...Object.values(importGraph).flat(),
    ]);
    const importedByOthers = new Set(Object.values(importGraph).flat());
    const entryPoints = [...allGraphPaths].filter(
      (p) => !importedByOthers.has(p),
    );
    const graphlessFiles = sourceFiles
      .map((f) => f.path)
      .filter((p) => !allGraphPaths.has(p));
    const depthMap = resolveImportDepths(
      [...entryPoints, ...graphlessFiles],
      importGraph,
      IMPORT_DEPTH,
    );

    let sortedFiles: any[];

    if (dumpAll) {
      sortedFiles = [...sourceFiles].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
    } else {
      const {
        files: selectedFiles,
        omittedCount,
        omittedPaths,
      } = selectFilesForQuery(
        sourceFiles,
        query,
        focus,
        importGraph,
        depthMap,
        intents,
      );

      if (expertPlan?.files) {
        for (const f of expertPlan.files) {
          const found = sourceFiles.find(
            (sf) => sf.path === f || sf.path.endsWith(f),
          );
          if (found && !selectedFiles.includes(found))
            selectedFiles.push(found);
        }
      }

      sortedFiles = [...selectedFiles].sort((a, b) => {
        const da = depthMap.get(a.path) ?? 999;
        const db = depthMap.get(b.path) ?? 999;
        return da !== db ? da - db : a.path.localeCompare(b.path);
      });

      if (omittedCount > 0) {
        push(
          "_meta",
          `## File Selection\n\n${sortedFiles.length} files included, ${omittedCount} files omitted as irrelevant.\nSample omitted: ${omittedPaths.join(", ")}`,
        );
      }
    }

    const graphHeader =
      `## Import Graph and File Roles\n\n` +
      `- **Entry Point**: not imported by any other file.\n` +
      `- **Depth N**: N hops from an entry point.\n` +
      `- **Utility**: not in the import graph.\n\n` +
      `Entry points: ${entryPoints.slice(0, 20).join(", ") || "none detected"}.`;

    if (sortedFiles.length > 0) push("_meta", graphHeader);

    for (const file of sortedFiles) {
      const fileContext = getFileContext(
        file,
        importRoleLabel(depthMap.get(file.path)),
        repoName,
      );
      push(file.path.split("/")[0] || "_root", fileContext);
    }
  }

  push(
    "_meta",
    `## End of Context\n\nSource files: ${needsCode ? "included" : "not included (meta-only query)"}.`,
  );

  const writtenPaths = await packAndFlush(blocks, outputDir);

  const manifestText = buildManifest(
    writtenPaths.length,
    repoName,
    repoContext,
    droppedTiers,
    allCandidates.length,
  );
  const manifestPath = join(outputDir, "00_Repo_Manifest.txt");
  await writeFile(manifestPath, manifestText, "utf-8");

  return manifestText;
}

export function buildFallbackContext(repoContext: any): string {
  return getRepoMeta(repoContext);
}

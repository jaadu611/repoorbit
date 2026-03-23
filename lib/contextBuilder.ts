import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const IMPORT_DEPTH = 10;
const FILE_CHAR_LIMIT = 120_000;
const SPLIT_THRESHOLD_CHARS = 3_000;
const MIN_RELEVANCE_SCORE_GENERIC = 3;
const MIN_RELEVANCE_SCORE_TARGETED = 15;
const MAX_OUTPUT_CHARS = 4_000_000; // ~4MB safe limit for NotebookLM/Gemini

const SOURCE_EXTENSIONS = new Set([
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
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "svelte",
  "vue",
  "json",
  "yaml",
  "yml",
  "toml",
  "sh",
  "bash",
  "zsh",
  "sql",
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
  "show",
  "give",
  "return",
  "returns",
  "takes",
  "accepts",
  "throws",
  "emits",
  "renders",
  "works",
  "defined",
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

export interface ExpertPlan {
  files?: string[];
  intents?: QueryIntent[];
  focus?: CodeFocus;
}

// ── Intent Detection ──────────────────────────────────────────────────────────

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
    /what does (this|the) repo (use|have|include|contain)/i.test(q)
  )
    intents.add("repo_meta");

  if (
    /^(list|show|what('s| is| are)?).{0,40}(file|folder|director|structure|tree|root)/i.test(
      q,
    ) ||
    /contents? of\s+[\w/.]+/i.test(q)
  )
    intents.add("tree");

  // Test intent: queries specifically about tests
  if (
    /\btest(s|ing|ed)?\b|\bspec\b|\bsuite\b|\bit\(|describe\(|jest|vitest|mocha|cypress/i.test(
      q,
    ) ||
    /show.{0,30}test|find.{0,30}test|where.{0,30}test/i.test(q)
  )
    intents.add("test");

  // Commit-specific queries that look like code questions but aren't
  if (
    /what (changed|was (changed|updated|modified|added|removed))/i.test(q) ||
    /latest (change|update|commit|diff)/i.test(q) ||
    /recent (change|update|commit)/i.test(q)
  )
    intents.add("commits");

  // repo_meta queries about tooling/setup should NOT get code intent
  // even though they mention specific tool names
  const isToolingQuery =
    /does (this|the) (repo|project).{0,40}(use|have|include|support)/i.test(
      q,
    ) ||
    /is there (a|an).{0,40}(config|setup|file|docker|ci|test)/i.test(q) ||
    /what.{0,20}(framework|library|tool|stack|bundler|linter)/i.test(q);

  if (isToolingQuery) intents.add("repo_meta");

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

  // camelCase symbol — but exclude single-word proper nouns like "React", "Docker"
  const hasCamelSymbol = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(query);

  const hasSnakeSymbol = /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query);

  // Quoted symbol: 'reconcileChildren' or "reconcileChildren"
  const hasQuotedSymbol = /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);

  // Explicit file path in query: src/foo/bar.ts
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);

  // test intent always needs code (files) too
  if (intents.has("test")) intents.add("code");

  const noOtherIntentMatched = intents.size === 0;

  if (
    noOtherIntentMatched ||
    hasCodeKeyword ||
    hasCamelSymbol ||
    hasSnakeSymbol ||
    hasQuotedSymbol ||
    hasFilePath ||
    // only add code for non-code intents when there's an explicit code signal
    // prevents "what is this repo about" from getting code
    !hasNonCodeIntent
  ) {
    intents.add("code");
  }

  return [...intents];
}

// ── Code Focus Detection ──────────────────────────────────────────────────────

export function detectCodeFocus(query: string): CodeFocus {
  const q = query.toLowerCase();

  // Broad architectural / conceptual questions → generic even if they contain
  // a symbol, because the answer spans many files
  const isBroadQuestion =
    /how does .{0,40} (work|fit|connect|relate|interact)/i.test(q) ||
    /explain (the |how |what ).{0,60}/i.test(q) ||
    /walk me through/i.test(q) ||
    /architecture|overview|structure|system|pipeline|flow/i.test(q);

  if (isBroadQuestion) return "generic";

  // Explicit symbol reference
  const hasSymbol =
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(query) ||
    /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query) ||
    /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);

  // Explicit file path
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);

  // Targeted question patterns
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

// ── Token Extraction ──────────────────────────────────────────────────────────

export function extractQueryTokens(query: string): string[] {
  const tokens = new Set<string>();

  // Quoted symbols — highest priority, extracted verbatim
  const quoted = query.match(/['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/g) ?? [];
  for (const q of quoted) tokens.add(q.replace(/['"`]/g, ""));

  // Explicit file paths
  const paths = query.match(/\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/g) ?? [];
  for (const p of paths) tokens.add(p);

  // dot.notation chains: fiber.updateQueue → add whole + each part
  const dotChains = query.match(/\b[a-zA-Z_$][a-zA-Z0-9_$.]{3,}\b/g) ?? [];
  for (const chain of dotChains) {
    if (chain.includes(".")) {
      tokens.add(chain);
      for (const part of chain.split(".")) {
        if (part.length > 2) tokens.add(part);
      }
    }
  }

  // camelCase symbols
  const camel = query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [];
  for (const c of camel) tokens.add(c);

  // snake_case symbols
  const snake = query.match(/\b[a-z][a-z0-9]*(_[a-z0-9]+){1,}\b/g) ?? [];
  for (const s of snake) tokens.add(s);

  // Meaningful words — min length 2 (catches act, ref, map, key, ctx, jsx)
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  for (const w of words) tokens.add(w);

  return [...tokens];
}

// ── File Scoring ──────────────────────────────────────────────────────────────

export function scoreFile(
  file: any,
  tokens: string[],
  importGraph: Record<string, string[]>,
  isImportQuery: boolean,
  isTestQuery: boolean,
): number {
  if (!tokens.length) return 0;

  let score = 0;
  const path = (file.path as string).toLowerCase();
  const exports: string[] = file.analysis?.exports ?? [];
  const imports: string[] = file.imports ?? [];
  const isTestFile =
    /\.(test|spec)\.[a-z]+$/.test(file.path) ||
    /__tests__/.test(file.path) ||
    /\/tests?\//.test(file.path);

  // Penalise test files for non-test queries and vice versa
  if (isTestFile && !isTestQuery) score -= 15;
  if (!isTestFile && isTestQuery) score -= 5;

  // Scan full content, not just a preview
  const fullContent = (file.content ?? "").toLowerCase();

  for (const token of tokens) {
    const t = token.toLowerCase();

    // Exact file path component match (e.g. token "useReducer" in "useReducer.ts")
    const pathBase =
      path
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    if (pathBase === t)
      score += 30; // exact filename match — almost certainly the definition
    else if (path.includes(t)) score += 5;

    // Export exact match — this file defines the symbol
    if (exports.some((e) => e.toLowerCase() === t)) score += 20;
    else if (exports.some((e) => e.toLowerCase().includes(t))) score += 8;

    // Import match — this file uses the symbol
    if (imports.some((i) => i.toLowerCase().includes(t))) score += 3;

    // Full content occurrences — no preview cap
    const occurrences = (
      fullContent.match(new RegExp(`\\b${escapeRegex(t)}\\b`, "g")) ?? []
    ).length;
    score += Math.min(occurrences * 2, 30);

    // Explicit file path token in query (e.g. "src/reconciler/fiber.ts")
    if (token.includes("/") && path.includes(token.toLowerCase())) score += 50;
  }

  // Import graph signals
  if (isImportQuery) {
    // How many files import this file
    const importerCount = Object.values(importGraph).filter((deps) =>
      deps.some((d) => d.includes(file.path) || file.path.includes(d)),
    ).length;
    score += importerCount * 4;
  }

  // Empty or near-empty file — likely a re-export barrel, reduce noise
  if ((file.metrics?.codeLines ?? 0) < 5) score = Math.floor(score * 0.4);

  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Dynamic File Limit (Removed) ──────────────────────────────────────────────

// The computeFileLimit function was intentionally removed as we now rely on strict
// relevance scoring to filter files rather than an arbitrary cap.

// ── File Selection ────────────────────────────────────────────────────────────

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
  
  // For generic queries, if they only asked about repo\_meta/tree/etc.,
  // they might still need broad codebase exposure if code intent fired.
  // But we want to filter noise.

  const tokens = extractQueryTokens(query);
  if (tokens.length === 0 && focus === "targeted") {
    // Edge case: User typed a generic query like "what is this" that had NO meaningful tokens.
    // It's impossible to do a "targeted" search without tokens. Fallback to generic relevance.
    focus = "generic";
  }

  const isImportQuery =
    /how many times|import(ed)?|usage|reference|occurrence|depend/i.test(query);
  const isTestQuery = intents.includes("test");

  const scored: ScoredFile[] = sourceFiles.map((file) => ({
    file,
    score: scoreFile(file, tokens, importGraph, isImportQuery, isTestQuery),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Apply a dynamic threshold based on the focus.
  const threshold = focus === "targeted" ? MIN_RELEVANCE_SCORE_TARGETED : MIN_RELEVANCE_SCORE_GENERIC;
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

// ── Import Graph ──────────────────────────────────────────────────────────────

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

// ── File Filtering ────────────────────────────────────────────────────────────

function shouldInclude(filePath: string): boolean {
  if (EXCLUDE_PATTERNS.some((re) => re.test(filePath))) return false;
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXTENSIONS.has(ext);
}

function isDocFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "md" && ext !== "mdx") return false;
  return !/node_modules|CHANGELOG|CHANGES|HISTORY|\.github\/|dist\//i.test(
    filePath,
  );
}

function safeFileExt(file: any): string {
  const raw: unknown = file.ext;
  if (typeof raw !== "string" || raw.includes(".")) {
    // ext was accidentally stored as full filename — extract real extension
    const fromPath =
      (file.path as string).split(".").pop()?.toLowerCase() ?? "";
    return fromPath;
  }
  return raw.toLowerCase();
}

function safeContent(file: any): string {
  const c = file.content;
  if (c === null || c === undefined) return "";
  return String(c);
}

// ── Directory Listing ─────────────────────────────────────────────────────────

export function getDirectoryStructure(filesMetadata: any[], maxLines = 400): string {
  const included = filesMetadata.filter((f) => shouldInclude(f.path));

  // Build full nested tree instead of only first path segment
  type TreeNode = { files: string[]; children: Map<string, TreeNode> };
  const root: TreeNode = { files: [], children: new Map() };

  for (const file of included) {
    const parts = (file.path as string).split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { files: [], children: new Map() });
      }
      node = node.children.get(seg)!;
    }
    node.files.push(parts[parts.length - 1]);
  }

  const lines: string[] = [];
  let lineCount = 0;
  let truncatedByLimit = false;

  function render(node: TreeNode, indent: number, prefix: string) {
    if (lineCount >= maxLines) {
      truncatedByLimit = true;
      return;
    }

    for (const f of node.files.sort()) {
      if (lineCount >= maxLines) {
        truncatedByLimit = true;
        return;
      }
      lines.push(`${" ".repeat(indent)}${f}`);
      lineCount++;
    }

    for (const [seg, child] of [...node.children.entries()].sort()) {
      if (lineCount >= maxLines) {
        truncatedByLimit = true;
        return;
      }
      const count = countFiles(child);
      lines.push(
        `${" ".repeat(indent)}${seg}/  (${count} file${count !== 1 ? "s" : ""})`,
      );
      lineCount++;
      render(child, indent + 2, `${prefix}${seg}/`);
    }
  }

  function countFiles(node: TreeNode): number {
    return (
      node.files.length +
      [...node.children.values()].reduce((s, c) => s + countFiles(c), 0)
    );
  }

  render(root, 0, "");
  if (truncatedByLimit) {
    lines.push(`\n[TRUNCATED: Directory listing exceeds ${maxLines} lines. Ask for contents of specific subdirectories if needed.]`);
  }
  return lines.join("\n");
}

// ── Documentation ─────────────────────────────────────────────────────────────

function docSortKey(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower === "readme.md" || lower === "readme.mdx") return "0-root-readme";
  if (!filePath.includes("/")) return `1-root-${lower}`;
  if (/^(docs?|wiki|documentation)\//i.test(filePath))
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
    `## Project Documentation\n\nIncluding ${limited.length} relevant documentation file${limited.length !== 1 ? "s" : ""}.${omitted > 0 ? ` Omitted ${omitted} secondary doc files to keep context concise.` : ""}`,
  ];

  for (const doc of limited) {
    let content = safeContent(doc);
    if (content.length > FILE_CHAR_LIMIT) {
      const cut = content.lastIndexOf("\n", FILE_CHAR_LIMIT);
      content =
        content.slice(0, cut > 0 ? cut : FILE_CHAR_LIMIT) +
        `\n\n[TRUNCATED: exceeds ${FILE_CHAR_LIMIT.toLocaleString()} characters.]`;
    }
    parts.push(
      `### ${doc.path}\n\nDocumentation file: \`${doc.path}\`\n\n${content}`,
    );
  }
  return parts.join("\n\n");
}

// ── Function Block Parser ─────────────────────────────────────────────────────

function parseFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];

  // Matches: export async function Foo / class Foo / const Foo = / @decorator\nclass Foo
  const startRe =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|class\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|var\s+(\w+)\s*=)/;
  const decoratorRe = /^@\w+/;

  let i = 0;
  while (i < lines.length) {
    // Skip decorator lines but remember them so the block starts there
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
          // Template literal — handle ${...} nesting
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
          }
          // Arrow function with no braces: const x = () => expr
          else if (
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
      if (!hasOpenedBrace && j > i + 3) break; // give up on brace-less declarations
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

// ── Metadata Sections ─────────────────────────────────────────────────────────

export function getRepoMeta(repoContext: any): string {
  // Defensive access — repoContext.stack may be undefined
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
  return `## Branches\n\n${branches
    .map((b: any) => `- ${b.name}${b.protected ? " (protected)" : ""}`)
    .join("\n")}`;
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
      `Author: ${p.author ?? "unknown"}. Branch: ${p.headBranch} into ${p.baseBranch}. Opened: ${p.createdAt}.${
        p.mergedAt ? ` Merged: ${p.mergedAt}.` : ""
      }`,
    );
    if (p.body)
      lines.push(
        `\n${p.body.slice(0, 400)}${p.body.length > 400 ? "..." : ""}`,
      );
  }
  return lines.join("\n");
}

// ── File Section Builder ──────────────────────────────────────────────────────

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
    ? `It imports from: ${imports.slice(0, 12).join(", ")}${
        imports.length > 12 ? ` and ${imports.length - 12} more` : ""
      }.`
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

  // Pure type/config/CSS files often have no parseable functions — emit as one block
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

// ── Main Export ───────────────────────────────────────────────────────────────

export async function buildMasterContext(
  query: string,
  filesMetadata: any[],
  importGraph: Record<string, string[]>,
  repoContext: any,
  expertPlan?: ExpertPlan,
): Promise<string> {
  const repoName = repoContext?.meta?.fullName?.split("/").pop() ?? "repo";
  const safeQuery = query ? String(query) : "";
  const intents = expertPlan?.intents ?? detectIntent(safeQuery);
  const needsCode = intents.includes("code") || intents.includes("test") || (expertPlan?.files && expertPlan.files.length > 0);
  const focus = expertPlan?.focus ?? (needsCode ? detectCodeFocus(safeQuery) : "generic");
  const sections: string[] = [];

  sections.push(
    `# ${repoContext?.meta?.fullName ?? "Unknown"} — Codebase Master Context`,
  );
  sections.push(
    `Generated: ${new Date().toISOString()}. Intents: [${intents.join(", ")}]. Focus: ${focus}.`,
  );

  // If it's a generic query or specifically asked for repo meta, include the meta section
  if (focus === "generic" || intents.includes("repo_meta")) {
    sections.push(getRepoMeta(repoContext));
  }

  // Edge case: defensive check for malformed file objects
  const allIncluded = filesMetadata.filter(
    (f) => f && typeof f.path === "string" && shouldInclude(f.path)
  );
  const docFiles = allIncluded.filter((f) => isDocFile(f.path));
  const sourceFiles = allIncluded.filter((f) => !isDocFile(f.path));

  // Skip docs if targeted logic query, only include if repo meta asked
  if (intents.includes("repo_meta") || focus === "generic") {
    // For generic "about" questions, we only want the primary READMEs (max 3)
    // If they explicitly asked for "readme" or "docs", we give more.
    const isExplicitDocsRequest = /readme|doc(s|umentation)|wiki/i.test(query.toLowerCase());
    const docsLimit = isExplicitDocsRequest ? 25 : 3;
    const docsSection = getReadme(docFiles, docsLimit);
    if (docsSection) sections.push(docsSection);
  }

  if (intents.includes("contributors")) {
    const s = getContributorsNames(repoContext);
    if (s) sections.push(s);
  }
  if (intents.includes("commits")) {
    const s = getCommitHistory(repoContext);
    if (s) sections.push(s);
  }
  if (intents.includes("branches")) {
    const s = getBranches(repoContext);
    if (s) sections.push(s);
  }
  if (intents.includes("issues")) {
    const s = getIssues(repoContext);
    if (s) sections.push(s);
  }
  if (intents.includes("pulls")) {
    const s = getPulls(repoContext);
    if (s) sections.push(s);
  }

  if (intents.includes("tree") || (intents.includes("repo_meta") && focus === "generic")) {
    const extFreq = repoContext?.stats?.extFrequency ?? {};
    const extSummary = Object.entries(extFreq)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `.${ext}: ${count} files`)
      .join(", ");

    // For generic overview, tree is limited to 200 lines. 
    // If they explicitly asked for "structure" or "tree", we give 1000 lines.
    const isExplicitTreeRequest = /tree|structure|folder|list files/i.test(query.toLowerCase());
    const treeLimit = isExplicitTreeRequest ? 1000 : 200;

    sections.push(
      `## Directory Structure\n\n${sourceFiles.length} source files. Types: ${extSummary}.\n\n` +
        getDirectoryStructure(filesMetadata, treeLimit),
    );
  }

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

    // If we have an expert plan with specific files, give them a massive score boost
    // effectively ensuring they are included even if our basic scoring missed them.
    if (expertPlan?.files) {
      for (const f of expertPlan.files) {
        const found = sourceFiles.find(sf => sf.path === f || sf.path.endsWith(f));
        if (found && !selectedFiles.includes(found)) {
          selectedFiles.push(found);
        }
      }
    }

    const sortedFiles = [...selectedFiles].sort((a, b) => {
      const da = depthMap.get(a.path) ?? 999;
      const db = depthMap.get(b.path) ?? 999;
      return da !== db ? da - db : a.path.localeCompare(b.path);
    });

    if (sortedFiles.length === 0 && focus === "targeted") {
      sections.push(
        `> [!WARNING]\n> No specific files met the strict relevance threshold for the query. The requested symbols or file paths might not exist or were filtered out.`
      );
    } else if (sortedFiles.length > 0) {
      sections.push(
        `## Import Graph and File Roles\n\n` +
          `- **Entry Point**: not imported by any other file.\n` +
          `- **Depth N**: N hops from an entry point.\n` +
          `- **Utility**: not in the import graph.\n\n` +
          `Entry points: ${entryPoints.slice(0, 20).join(", ") || "none detected"}.`,
      );
    }

    const totalLines = sortedFiles.reduce(
      (s, f) => s + (f.metrics?.lineCount ?? 0),
      0,
    );
    const entryCount = sortedFiles.filter(
      (f) => (depthMap.get(f.path) ?? 999) === 0,
    ).length;

    let sourceHeader = `## Source Files\n\n${sortedFiles.length} files included`;

    if (focus === "targeted") {
      sourceHeader += ` (targeted — ${omittedCount} files omitted as irrelevant)`;
      if (omittedPaths.length) {
        sourceHeader += `.\nSample omitted: ${omittedPaths.join(", ")}${
          omittedCount > 20 ? ` and ${omittedCount - 20} more` : ""
        }`;
      }
    }

    sourceHeader += `. ${entryCount} entry points. ${totalLines.toLocaleString()} total lines.`;
    if (sortedFiles.length > 0) sections.push(sourceHeader);

    for (const file of sortedFiles) {
      sections.push(
        getFileContext(
          file,
          importRoleLabel(depthMap.get(file.path)),
          repoName,
        ),
      );
    }
  }

  sections.push(
    `## End of Master Context\n\nIntents: [${intents.join(", ")}]. Focus: ${focus}. ` +
      `Source files emitted: ${needsCode ? "yes" : "no (meta-only query)"}.`,
  );

  let fullContext = sections.join("\n\n");

  // Edge case: Hard size limit to prevent memory exhaustion and downstream rejections
  if (fullContext.length > MAX_OUTPUT_CHARS) {
    fullContext =
      fullContext.slice(0, MAX_OUTPUT_CHARS) +
      "\n\n[CRITICAL WARNING: CONTEXT TRUNCATED DUE TO EXTREME SIZE OVER 4MB. NOTEBOOKLM MIGHT REJECT LARGER FILES.]";
  }

  const OUTPUT_PATH = "/tmp/contextForNotebook.txt";
  try {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, fullContext, "utf-8");
    console.log(
      `[RepoOrbit] ${OUTPUT_PATH} — ${(fullContext.length / 1024).toFixed(1)} KB | ` +
        `intents: [${intents.join(", ")}] | focus: ${focus} | ` +
        `files: ${needsCode ? "dynamic" : 0}`,
    );
  } catch (err) {
    console.error(`[RepoOrbit] Write failed: ${(err as Error).message}`);
  }

  return fullContext;
}

export function buildFallbackContext(repoContext: any): string {
  return getRepoMeta(repoContext);
}
